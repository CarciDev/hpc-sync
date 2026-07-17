import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { bestWindow, UsageAnalytics } from './analytics';
import { ClusterMonitor } from './clusterMonitor';
import { getConfig } from './config';
import { log } from './log';
import { loadProjectConfig } from './projectConfig';
import { SshManager } from './sshManager';
import { StorageBench } from './storageBench';
import { SyncEngine } from './syncEngine';

interface PaletteEntry {
  id: string;
  label: string;
  /** default path suggestion when a chip is created from this storage */
  base: string;
  lifetime: string;
  quotaText?: string;
  quotaPct?: number;
  benchText?: string;
  caps: { input: boolean; workspace: boolean; result: boolean };
  /** project mounts get bind-mounted into the container when used */
  bind?: boolean;
  /** raw mount name (for the HPC_MOUNT_<NAME> env var) */
  mountName?: string;
}

interface LaunchConfigMsg {
  command: 'launch';
  mode: 'quick' | 'job';
  script: string;
  args: string;
  outputDir: string; // quick mode only
  jobName: string;
  content: string; // sbatch script text (job mode)
  saveLocal: boolean;
}

/**
 * "Launch" job builder. Storage is configured as a visual pipeline:
 * a palette of storages on the left, and typed role slots (INPUTS →
 * WORKSPACE → RESULTS) on the right. Chips are added by drag-and-drop or
 * "+ add"; the slot types make invalid data flows impossible by
 * construction, and the sbatch script is generated from the graph.
 */
export class LaunchPanel {
  private static current?: LaunchPanel;
  private readonly panel: vscode.WebviewPanel;

  static async open(
    scriptRel: string,
    ssh: SshManager,
    engine: SyncEngine,
    cluster: ClusterMonitor,
    analytics: UsageAnalytics,
    bench: StorageBench
  ): Promise<void> {
    if (LaunchPanel.current) {
      LaunchPanel.current.panel.dispose();
    }
    LaunchPanel.current = new LaunchPanel(scriptRel, ssh, engine, cluster, analytics, bench);
  }

  private constructor(
    private readonly scriptRel: string,
    private readonly ssh: SshManager,
    private readonly engine: SyncEngine,
    private readonly cluster: ClusterMonitor,
    private readonly analytics: UsageAnalytics,
    private readonly bench: StorageBench
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'hpcSyncLaunch',
      `Launch ${path.basename(scriptRel)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      if (LaunchPanel.current === this) {
        LaunchPanel.current = undefined;
      }
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg: LaunchConfigMsg | { command: string; mounts?: string[] }) => {
      if (msg.command === 'ready') {
        void this.sendInit();
      } else if (msg.command === 'launch') {
        void this.launch(msg as LaunchConfigMsg);
      } else if (msg.command === 'atlas') {
        void vscode.commands.executeCommand('hpcSync.projectAtlas', {
          label: `Launch · ${path.basename(this.scriptRel)}`,
          mountPaths: (msg as { mounts?: string[] }).mounts ?? [],
        });
      }
    });
  }

  private async sendInit(): Promise<void> {
    const cfg = getConfig();
    // Fallback is $HOME, not '~': the generated bash double-quotes these paths
    // (where ~ does NOT expand but $HOME does), and the submit step expands
    // $VARs for #SBATCH directives. A literal '~' created junk dirs.
    let home = '$HOME';
    let scratch = '';
    let connected = false;
    try {
      await this.ssh.ensureConnected();
      connected = true;
      const env = await this.ssh.execChecked('echo "$HOME|$SCRATCH"');
      const parts = env.stdout.trim().split('\n').pop()!.split('|');
      home = parts[0] || '$HOME';
      scratch = parts[1] || '';
      void this.cluster.refreshNow();
      void this.analytics.ensure(false);
    } catch (e) {
      log.appendLine(`[launch] not connected: ${(e as Error).message}`);
    }

    const snap = this.cluster.getSnapshot();
    const pattern = this.analytics.get();
    const benchSnap = this.bench.get();

    // ── Suggestions ──
    const suggestions: string[] = [];
    if (pattern) {
      const w = bestWindow(pattern.bins);
      // "now" in CLUSTER time — the extension host may run in a UTC container.
      const hour =
        pattern.clusterUtcOffsetMin !== undefined
          ? new Date(Date.now() + pattern.clusterUtcOffsetMin * 60000).getUTCHours()
          : new Date().getHours();
      const inWin = hour === w.start || hour === (w.start + 1) % 24 || hour === (w.start + 2) % 24;
      const hh = (h: number) => `${h.toString().padStart(2, '0')}:00`;
      suggestions.push(
        inWin
          ? `Now (${hh(hour)}) is inside the quietest submission window ${hh(w.start)}–${hh((w.start + 3) % 24)} — good time to submit.`
          : `Quietest submission window: ${hh(w.start)}–${hh((w.start + 3) % 24)} cluster time (it is now ${hh(hour)}).`
      );
    }
    if (snap.cpu) {
      const freePct = 100 - Math.round((snap.cpu.alloc / snap.cpu.total) * 100);
      suggestions.push(
        `${snap.cpu.idle.toLocaleString()} CPU cores idle right now (${freePct}% of the cluster) — ${
          freePct > 15 ? 'small CPU jobs should start quickly' : 'cluster is busy; expect queueing'
        }.`
      );
    }
    if (snap.gpu) {
      const free = snap.gpu.total - snap.gpu.used;
      suggestions.push(
        free > 0 ? `${free} GPUs free — a GPU job may start quickly.` : 'All GPUs busy — GPU jobs will queue.'
      );
    }
    const fsRow =
      snap.fairshare?.find((r) =>
        r.account.toLowerCase().includes(cfg.allocGroup.toLowerCase().split('_')[0])
      ) ?? snap.fairshare?.[0];
    if (fsRow?.ratio !== undefined) {
      suggestions.push(
        fsRow.ratio > 1.15
          ? `Your group is at ${fsRow.ratio.toFixed(2)}× its fair share — request modest resources for faster starts.`
          : `Your group is at ${fsRow.ratio.toFixed(2)}× its fair share — priority is healthy.`
      );
    }

    // ── Storage palette ──
    const quotaFor = (needle: string) => snap.storage.find((s) => s.label.toLowerCase().includes(needle));
    const benchFor = (label: string) => benchSnap?.results.find((r) => r.label === label && !r.note);
    const entry = (
      id: string,
      label: string,
      base: string,
      lifetime: string,
      caps: PaletteEntry['caps'],
      quotaNeedle?: string,
      benchLabel?: string
    ): PaletteEntry => {
      const q = quotaNeedle ? quotaFor(quotaNeedle) : undefined;
      const b = benchLabel ? benchFor(benchLabel) : undefined;
      return {
        id,
        label,
        base,
        lifetime,
        caps,
        quotaText: q ? `${q.used} / ${q.quota}` : undefined,
        quotaPct: q?.usedPct,
        benchText: b ? `w ${b.writeMBps?.toFixed(0)} / r ${b.readMBps?.toFixed(0)} MB/s` : undefined,
      };
    };
    const projSlug = path.basename(cfg.localProjectDir || 'project').replace(/[^\w.-]/g, '_');
    const projectDefault = cfg.outputDir.replace(/^\$HOME/, home).replace(/^~(?=\/)/, home);
    const palette: PaletteEntry[] = [
      entry('project', 'Project', projectDefault, 'persistent · backed up', { input: true, workspace: false, result: true }, '/project (project', 'project'),
      ...(scratch
        ? [entry('scratch', 'Scratch', `${scratch}/${projSlug}_out`, '⚠ purged after ~60 days idle', { input: true, workspace: false, result: true }, '/scratch', 'scratch')]
        : []),
      entry('home', 'Home', `${home}/${projSlug}_out`, 'small quota — avoid large outputs', { input: true, workspace: false, result: true }, '/home', 'home'),
      entry('nearline', 'Nearline', `/nearline/${cfg.allocGroup}/${cfg.user}/archive`, 'tape archive · slow retrieval, write-mostly', { input: false, workspace: false, result: true }, '/nearline (project'),
      entry('tmpdir', '$SLURM_TMPDIR', '$SLURM_TMPDIR', 'per-job NVMe · fastest I/O · wiped at job end', { input: false, workspace: true, result: false }),
      entry('custom', 'Custom path…', '', 'you know best', { input: true, workspace: false, result: true }),
    ];
    // Project mounts (.hpcproject.json) — named shared directories; jobs that
    // use them get an apptainer --bind automatically.
    for (const m of loadProjectConfig().mounts) {
      palette.push({
        id: 'mount:' + m.name,
        label: '📁 ' + m.name,
        base: m.path,
        lifetime: m.purpose || 'project mount · bind-mounted into the container',
        caps: { input: true, workspace: false, result: true },
        bind: true,
        mountName: m.name,
      });
    }

    // Ground truth for submittable accounts: the user's Slurm associations
    // (both raw names and base forms — the submit plugin accepts different
    // spellings on different clusters).
    let accounts: string[] = [];
    let rawAssoc: string[] = [];
    if (connected) {
      try {
        const assoc = await this.ssh.exec(`sacctmgr -n -P show assoc where user=$USER format=account`);
        if (assoc.code === 0) {
          rawAssoc = assoc.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((a) => a && a !== 'root');
          accounts = Array.from(new Set(rawAssoc.flatMap((a) => [a.replace(/_(cpu|gpu)$/i, ''), a])));
        }
      } catch {
        /* fall through to fallbacks */
      }
    }
    if (accounts.length === 0) {
      const rawAccounts = (snap.fairshare ?? []).map((r) => r.account).filter(Boolean);
      accounts = Array.from(new Set(rawAccounts.flatMap((a) => [a.replace(/_(cpu|gpu)$/i, ''), a])));
    }
    if (accounts.length === 0 && cfg.allocGroup) {
      accounts = [cfg.allocGroup];
    }
    accounts.sort(
      (a, b) => (a === cfg.allocGroup ? -1 : 0) - (b === cfg.allocGroup ? -1 : 0) || a.localeCompare(b)
    );

    // GPU-only allocation (an rrg-* grant that covers only GPUs): every association is
    // a _gpu variant, so jobs MUST request at least one GPU or sbatch rejects
    // them with an inscrutable "Unspecified error".
    const assocSource = rawAssoc.length > 0 ? rawAssoc : (snap.fairshare ?? []).map((r) => r.account);
    const gpuOnly = assocSource.length > 0 && assocSource.every((a) => /_gpu$/i.test(a));
    if (gpuOnly) {
      suggestions.unshift(
        'Your allocation is GPU-only — every job must request at least 1 GPU (GPUs field is defaulted to 1; 0 will be rejected by the scheduler).'
      );
    }

    void this.panel.webview.postMessage({
      type: 'init',
      script: this.scriptRel,
      connected,
      suggestions,
      palette,
      accounts,
      tpl: {
        account: accounts[0] ?? cfg.allocGroup,
        apptainerLoad: cfg.apptainerLoad,
        remoteProjectDir: cfg.remoteProjectDir,
        containerWorkdir: cfg.containerWorkdir,
        sifPath: `${cfg.remoteSifDir}/${cfg.sifName}`,
        defaultJobName: path.basename(this.scriptRel, '.py').replace(/[^\w.-]/g, '_'),
        gpuOnly,
      },
    });
  }

  private async launch(msg: LaunchConfigMsg): Promise<void> {
    const runCmd = msg.args ? `${msg.script} ${msg.args}` : msg.script;
    if (msg.mode === 'quick') {
      void this.panel.webview.postMessage({
        type: 'status',
        text: 'Quick run started — see the HPC Sync pipeline/output.',
      });
      // empty string must fall back to the configured outputDir, not mkdir ''
      await this.engine.sync({ runCmd, runOutputDir: msg.outputDir || undefined });
      return;
    }
    const name = (msg.jobName || 'job').replace(/[^\w.-]/g, '_') + '_' + Date.now().toString(36);
    if (msg.saveLocal) {
      const ws = getConfig().localProjectDir;
      if (ws) {
        const localPath = path.join(ws, `slurm_generated_${name}.sh`);
        fs.writeFileSync(localPath, msg.content.replace(/\r\n/g, '\n'));
        log.appendLine(`[launch] saved a local copy: ${localPath}`);
      }
    }
    void this.panel.webview.postMessage({ type: 'status', text: `Submitting ${name}… (see pipeline view)` });
    // Mount paths bound by this run, straight from the script that will be
    // submitted (works even if the user edited it) — recorded per job so the
    // Project Atlas can show a run's relations later.
    const mounts = Array.from(msg.content.matchAll(/--env HPC_MOUNT_\w+="([^"]+)"/g), (m) => m[1]);
    await this.engine.sync({ submitGenerated: { name, content: msg.content, mounts } });
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 14px 18px; max-width: 900px; }
  h2 { margin: 0 0 4px; font-size: 1.25em; }
  h3 { margin: 18px 0 6px; font-size: 0.92em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.88em; }
  input[type=text], select, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 7px; font-family: inherit; font-size: inherit; }
  input[type=text]:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  textarea { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.88em; width: 100%; box-sizing: border-box; }
  label { font-size: 0.92em; }
  .row { display: flex; gap: 10px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
  .row .grow { flex: 1; min-width: 160px; }
  .field { display: flex; flex-direction: column; gap: 3px; }
  .field span { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .field input, .field select { width: 110px; }
  .mode { display: flex; gap: 8px; margin: 8px 0; }
  .modebtn { flex: 1; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); border-radius: 6px; padding: 10px 12px; cursor: pointer; background: var(--vscode-editorWidget-background); }
  .modebtn.sel { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); }
  .modebtn b { display: block; margin-bottom: 3px; }
  .modebtn small { color: var(--vscode-descriptionForeground); }
  .sugg { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); border-radius: 6px; padding: 8px 12px; margin: 8px 0; }
  .sugg li { margin: 3px 0 3px 14px; font-size: 0.92em; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 7px 18px; cursor: pointer; font-family: inherit; font-size: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 4px 10px; }
  .actions { margin-top: 16px; display: flex; gap: 10px; align-items: center; }
  #status { margin-top: 10px; color: var(--vscode-descriptionForeground); }
  .hidden { display: none !important; }
  /* ── pipeline builder ──
     palette is a horizontal strip on top; the flow gets the full width below
     (a tall left palette next to a wide flow cropped RESULTS off-screen) */
  .builder { display: flex; flex-direction: column; gap: 10px; }
  .palette { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); border-radius: 6px; padding: 7px 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: stretch; }
  .palette .ptitle { font-size: 0.85em; font-weight: 600; color: var(--vscode-descriptionForeground); width: 100%; }
  .pitem { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); border-radius: 5px; padding: 6px 8px; width: 190px; box-sizing: border-box; cursor: grab; background: var(--vscode-editor-background); }
  .pitem:active { cursor: grabbing; }
  .pitem b { font-size: 0.92em; }
  .pitem .fine { color: var(--vscode-descriptionForeground); font-size: 0.8em; margin-top: 1px; }
  .pitem .caps { margin-top: 3px; display: flex; gap: 3px; }
  .cap { font-size: 0.72em; border-radius: 8px; padding: 0 6px; background: rgba(139,148,158,0.18); color: var(--vscode-descriptionForeground); }
  .bar-track { background: var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); border-radius: 2px; margin-top: 3px; height: 3px; }
  .bar { height: 3px; border-radius: 2px; background: #2ea043; }
  .bar.warn { background: #d29922; }
  .bar.crit { background: #f85149; }
  /* left→right flow: three labeled slot columns joined by captioned arrows —
     the same node-card grammar as the Project Atlas */
  .flow { min-width: 0; display: flex; flex-direction: row; align-items: stretch; overflow-x: auto; padding-bottom: 4px; }
  .fcol { flex: 1; min-width: 180px; }
  .farrow { width: 86px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 0 5px; }
  .farrow .arr { font-size: 1.7em; line-height: 1; color: var(--vscode-descriptionForeground); }
  .farrow .acap { font-size: 0.75em; color: var(--vscode-descriptionForeground); text-align: center; }
  .slot { border: 1.5px dashed var(--vscode-widget-border, rgba(128,128,128,0.45)); border-radius: 8px; padding: 8px 10px; margin: 0; box-sizing: border-box; }
  .slot-inputs { background: rgba(88,166,255,0.045); }
  .slot-ws { border-style: solid; border-width: 2px; background: var(--vscode-editorWidget-background); }
  .slot-res { background: rgba(46,160,67,0.05); }
  .slot.dragok { border-color: var(--vscode-focusBorder); background: rgba(88,166,255,0.06); }
  .slot .shead { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
  .slot .stitle { font-size: 0.84em; font-weight: 700; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); flex: 1; }
  .slot .shint { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; min-height: 1.1em; }
  .addbtn { font-size: 0.82em; padding: 1px 8px; border-radius: 9px; border: 1px dashed var(--vscode-descriptionForeground); color: var(--vscode-descriptionForeground); cursor: pointer; background: none; }
  .addbtn:hover { color: var(--vscode-foreground); border-color: var(--vscode-foreground); background: none; }
  .addmenu { margin: 4px 0; display: flex; flex-wrap: wrap; gap: 4px; }
  .addmenu button { font-size: 0.82em; padding: 2px 9px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .chip { border: 1.5px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 8px; padding: 6px 9px; margin: 5px 0; background: var(--vscode-editorWidget-background); }
  .chip .chead { display: flex; align-items: center; gap: 7px; }
  .chip .chead b { font-size: 0.92em; }
  .chip .fine { color: var(--vscode-descriptionForeground); font-size: 0.8em; }
  .chip .cx { margin-left: auto; cursor: pointer; color: var(--vscode-descriptionForeground); padding: 0 4px; border-radius: 3px; }
  .chip .cx:hover { background: rgba(248,81,73,0.2); color: #f85149; }
  .chip input[type=text], .chip textarea { width: 100%; box-sizing: border-box; margin-top: 4px; }
  .tag { font-size: 0.72em; border-radius: 8px; padding: 0 7px; background: rgba(46,160,67,0.2); color: #2ea043; font-weight: 700; }
  .mkprimary { font-size: 0.78em; color: var(--vscode-textLink-foreground); cursor: pointer; }
  .inplace { color: var(--vscode-descriptionForeground); font-size: 0.88em; padding: 4px 2px; }
</style>
</head>
<body>
  <h2 id="title">Launch</h2>
  <div class="meta" id="subtitle">runs inside the Apptainer container after a fast-path sync</div>

  <h3>Mode</h3>
  <div class="mode">
    <div class="modebtn" id="modeQuick"><b>▶ Quick run</b><small>Runs on the login node over the shared session. For short/light tasks only.</small></div>
    <div class="modebtn sel" id="modeJob"><b>⚙ Slurm job</b><small>Builds an sbatch script from the data pipeline below and submits it.</small></div>
  </div>

  <div class="sugg"><b style="font-size:0.9em">Suggestions</b><ul id="suggList"><li class="meta">connecting…</li></ul></div>

  <h3>Script</h3>
  <div class="row">
    <div class="field grow"><span>arguments</span><input type="text" id="args" style="width:100%" placeholder="--flag value …"></div>
  </div>

  <div id="jobFields">
    <h3>Resources</h3>
    <div class="row">
      <div class="field grow"><span>job name</span><input type="text" id="jobName" style="width:100%"></div>
      <div class="field"><span>account</span><select id="account"></select></div>
    </div>
    <div class="row">
      <div class="field"><span>time (HH:MM:SS)</span><input type="text" id="time" value="03:00:00"></div>
      <div class="field"><span>CPUs</span><input type="text" id="cpus" value="4"></div>
      <div class="field"><span>memory</span><input type="text" id="mem" value="8G"></div>
      <div class="field"><span>GPUs</span><input type="text" id="gpus" value="0"></div>
      <button class="secondary" id="applySugg" title="Modest defaults that schedule fast">Apply suggested</button>
    </div>
    <div class="row">
      <label title="Snapshots every destination directory before and after the job to compute an exact diff. Costs a full file scan of each destination — minutes on very large folders (e.g. a shared datasets dir). The cheap produced-files list from the workspace is always recorded when staging is on.">
        <input type="checkbox" id="trackDiff"> diff destinations after the job (slow on huge destination folders)
      </label>
    </div>
  </div>

  <div id="pipeWrap">
    <h3>Data pipeline <a id="lnkAtlas" style="font-size:0.75em;font-weight:400">view relations ⤢</a></h3>
    <div class="meta" style="margin-bottom:6px">Data flows left to right: sources are staged in, the job computes in the workspace, results are delivered to the destinations. Drag storages from the palette into a column, or use “+ add” — column types keep the flow valid: only $SLURM_TMPDIR can be a workspace, and it can never be a destination.</div>
    <div class="builder">
      <div class="palette" id="palette"><div class="ptitle">STORAGES</div></div>
      <div class="flow">
        <div class="slot fcol slot-inputs" data-role="inputs">
          <div class="shead"><span class="stitle">INPUTS</span><button class="addbtn" data-add="inputs">+ add source</button></div>
          <div class="shint" id="hintInputs"></div>
          <div class="addmenu hidden" id="menu-inputs"></div>
          <div id="chips-inputs"></div>
        </div>
        <div class="farrow"><div class="arr">⟶</div><div class="acap" id="hopInText"></div></div>
        <div class="slot fcol slot-ws" data-role="workspace">
          <div class="shead"><span class="stitle">WORKSPACE</span><button class="addbtn" data-add="workspace">+ add</button></div>
          <div class="shint" id="hintWs"></div>
          <div class="addmenu hidden" id="menu-workspace"></div>
          <div id="chips-workspace"></div>
        </div>
        <div class="farrow"><div class="arr">⟶</div><div class="acap" id="hopRunText"></div></div>
        <div class="slot fcol slot-res" data-role="results">
          <div class="shead"><span class="stitle">RESULTS</span><button class="addbtn" data-add="results">+ add destination</button></div>
          <div class="shint" id="hintRes"></div>
          <div class="addmenu hidden" id="menu-results"></div>
          <div id="chips-results"></div>
        </div>
      </div>
    </div>
  </div>

  <div id="quickOutWrap" class="hidden">
    <h3>Output directory</h3>
    <div class="row"><div class="field grow"><span>OUTPUT_DIR for the quick run</span><input type="text" id="quickOut" style="width:100%"></div></div>
  </div>

  <div id="previewWrap">
    <h3>Generated sbatch script</h3>
    <textarea id="preview" rows="20" spellcheck="false"></textarea>
    <div class="meta">You can edit the script directly — what you see is exactly what gets submitted. Changing fields or the pipeline regenerates it.</div>
  </div>
  <div id="quickPreviewWrap" class="hidden">
    <h3>Command</h3>
    <textarea id="quickPreview" rows="3" readonly></textarea>
  </div>

  <div class="actions">
    <button id="go">Submit job</button>
    <label id="saveWrap"><input type="checkbox" id="saveLocal"> save a copy as slurm_generated_*.sh in the workspace</label>
  </div>
  <div id="status"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let init = null;
  let mode = 'job';
  let uid = 0;
  // pipeline state: chips reference palette storages by id
  const pipe = {
    inputs: [],            // {uid, storId, paths}
    workspace: null,       // {uid, storId:'tmpdir'} or null = run in place
    results: []            // {uid, storId, path}; index 0 = primary
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }
  function stor(id) { return init.palette.find(function (p) { return p.id === id; }); }
  function barClass(p) { return p >= 90 ? 'bar crit' : p >= 70 ? 'bar warn' : 'bar'; }

  window.addEventListener('message', function (e) {
    const m = e.data;
    if (m.type === 'init') { init = m; setup(); }
    else if (m.type === 'status') { el('status').textContent = m.text; }
  });
  vscode.postMessage({ command: 'ready' });

  function setup() {
    el('title').textContent = 'Launch ' + init.script;
    el('jobName').value = init.tpl.defaultJobName;
    if (init.tpl.gpuOnly) { el('gpus').value = '1'; }
    const acc = el('account');
    acc.innerHTML = '';
    if (!init.accounts.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(cluster default account)';
      acc.appendChild(o);
    }
    for (const a of init.accounts) {
      const o = document.createElement('option');
      o.value = a; o.textContent = a;
      acc.appendChild(o);
    }
    el('suggList').innerHTML = init.suggestions.length
      ? init.suggestions.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('')
      : '<li class="meta">' + (init.connected ? 'No suggestion data yet — refresh the Cluster view, run the benchmark, build the pattern.' : 'Not connected — suggestions unavailable.') + '</li>';

    // default pipeline: run in place, project as primary destination
    const proj = stor('project');
    pipe.results.push({ uid: ++uid, storId: 'project', path: proj ? proj.base : '' });
    el('quickOut').value = proj ? proj.base : '';

    // Project mounts are INPUTS by default — declaring a mount means "this
    // project's jobs consume that data", so every launch stages it to
    // node-local NVMe without a manual drag. Remove the chip (or trim the
    // paths on it) for a run that doesn't need the data.
    for (const p of init.palette) {
      if (p.bind && p.base) {
        pipe.inputs.push({ uid: ++uid, storId: p.id, paths: p.base });
      }
    }
    if (pipe.inputs.length && !pipe.workspace) {
      pipe.workspace = { uid: ++uid, storId: 'tmpdir' };
    }

    renderPalette();
    renderPipeline();

    el('modeQuick').onclick = function () { setMode('quick'); };
    el('modeJob').onclick = function () { setMode('job'); };
    el('applySugg').onclick = function () {
      el('time').value = '03:00:00'; el('cpus').value = '4'; el('mem').value = '8G';
      el('gpus').value = init.tpl.gpuOnly ? '1' : '0';
      regen();
    };
    ['args', 'jobName', 'time', 'cpus', 'mem', 'gpus', 'quickOut'].forEach(function (id) {
      el(id).addEventListener('input', regen);
    });
    el('trackDiff').addEventListener('change', regen);
    el('account').addEventListener('change', regen);
    el('go').onclick = go;
    el('lnkAtlas').onclick = function () {
      // mounts used by the current pipeline (dedup by path)
      const paths = [];
      pipe.inputs.concat(pipe.results).forEach(function (c) {
        const p = stor(c.storId);
        if (p && p.bind && p.base && paths.indexOf(p.base) < 0) { paths.push(p.base); }
      });
      vscode.postMessage({ command: 'atlas', mounts: paths });
    };
    document.querySelectorAll('.addbtn').forEach(function (b) {
      b.onclick = function () { toggleAddMenu(b.getAttribute('data-add')); };
    });
    setupSlotDnd();
    setMode('job');
  }

  // ── palette ──
  function mountInUse(storId) {
    return pipe.inputs.some(function (c) { return c.storId === storId; }) ||
      pipe.results.some(function (c) { return c.storId === storId; });
  }

  function renderPalette() {
    const pal = el('palette');
    pal.innerHTML = '<div class="ptitle">STORAGES</div>';
    for (const p of init.palette) {
      // a mount lives either in the palette OR in the pipeline, never both —
      // generic storages stay (multiple destinations are legitimate)
      if (p.bind && mountInUse(p.id)) { continue; }
      const d = document.createElement('div');
      d.className = 'pitem';
      d.setAttribute('draggable', 'true');
      d.setAttribute('data-stor', p.id);
      let fine = esc(p.lifetime);
      if (p.quotaText) { fine += ' · ' + esc(p.quotaText); }
      if (p.benchText) { fine += ' · ' + esc(p.benchText); }
      const caps = [];
      if (p.caps.input) { caps.push('input'); }
      if (p.caps.workspace) { caps.push('workspace'); }
      if (p.caps.result) { caps.push('result'); }
      d.innerHTML = '<b>' + esc(p.label) + '</b><div class="fine">' + fine + '</div>' +
        (typeof p.quotaPct === 'number' ? '<div class="bar-track"><div class="' + barClass(p.quotaPct) + '" style="width:' + Math.min(100, p.quotaPct) + '%"></div></div>' : '') +
        '<div class="caps">' + caps.map(function (c) { return '<span class="cap">' + c + '</span>'; }).join('') + '</div>';
      d.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', 'pal:' + p.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      pal.appendChild(d);
    }
  }

  // ── slot mechanics ──
  function canAccept(role, storId) {
    const p = stor(storId);
    if (!p) { return false; }
    if (role === 'inputs') { return p.caps.input; }
    if (role === 'workspace') { return p.caps.workspace; }
    if (role === 'results') { return p.caps.result; }
    return false;
  }

  function addChip(role, storId) {
    const p = stor(storId);
    if (!p || !canAccept(role, storId)) { return; }
    if (role === 'inputs') {
      pipe.inputs.push({ uid: ++uid, storId: storId, paths: p.base ? p.base : '' });
      if (!pipe.workspace) {
        pipe.workspace = { uid: ++uid, storId: 'tmpdir' };
        setStatusNote('Workspace set to $SLURM_TMPDIR automatically — stage-in needs a node-local workspace.');
      }
    } else if (role === 'workspace') {
      pipe.workspace = { uid: ++uid, storId: 'tmpdir' };
    } else if (role === 'results') {
      pipe.results.push({ uid: ++uid, storId: storId, path: p.base ? p.base : '' });
    }
    renderPipeline();
  }

  function removeChip(role, chipUid) {
    if (role === 'inputs') {
      pipe.inputs = pipe.inputs.filter(function (c) { return c.uid !== chipUid; });
    } else if (role === 'workspace') {
      if (pipe.inputs.length > 0) {
        setStatusNote('Remove the stage-in sources first — they need the node-local workspace.');
        return;
      }
      pipe.workspace = null;
    } else if (role === 'results') {
      if (pipe.results.length <= 1) { return; } // at least one destination, by construction
      pipe.results = pipe.results.filter(function (c) { return c.uid !== chipUid; });
    }
    renderPipeline();
  }

  function setStatusNote(t) { el('status').textContent = t; }

  function toggleAddMenu(role) {
    const menu = el('menu-' + role);
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    document.querySelectorAll('.addmenu').forEach(function (m) { m.classList.add('hidden'); });
    menu.innerHTML = '';
    let any = false;
    for (const p of init.palette) {
      if (!canAccept(role, p.id)) { continue; }
      if (role === 'workspace' && pipe.workspace) { continue; }
      if (p.bind && mountInUse(p.id)) { continue; }
      any = true;
      const b = document.createElement('button');
      b.textContent = p.label;
      b.onclick = function () { menu.classList.add('hidden'); addChip(role, p.id); };
      menu.appendChild(b);
    }
    if (!any) {
      const s = document.createElement('span');
      s.className = 'meta';
      s.textContent = role === 'workspace' ? 'workspace already set' : 'no eligible storages';
      menu.appendChild(s);
    }
    menu.classList.remove('hidden');
  }

  function setupSlotDnd() {
    document.querySelectorAll('.slot').forEach(function (slot) {
      const role = slot.getAttribute('data-role');
      slot.addEventListener('dragover', function (e) {
        const data = e.dataTransfer.types.indexOf('text/plain') >= 0;
        if (!data) { return; }
        e.preventDefault();
        slot.classList.add('dragok');
      });
      slot.addEventListener('dragleave', function () { slot.classList.remove('dragok'); });
      slot.addEventListener('drop', function (e) {
        e.preventDefault();
        slot.classList.remove('dragok');
        const raw = e.dataTransfer.getData('text/plain');
        if (raw.indexOf('pal:') === 0) {
          const storId = raw.slice(4);
          if (canAccept(role, storId)) {
            if (role === 'workspace' && pipe.workspace) { return; }
            addChip(role, storId);
          } else {
            setStatusNote(stor(storId) ? stor(storId).label + ' cannot be used as ' + role.toUpperCase() + ' — not a valid role for it.' : '');
          }
        } else if (raw.indexOf('chip:') === 0) {
          const parts = raw.slice(5).split(':');
          moveChip(parts[0], parseInt(parts[1], 10), role);
        }
      });
    });
  }

  function moveChip(fromRole, chipUid, toRole) {
    if (fromRole === toRole) { return; }
    let chip = null;
    if (fromRole === 'inputs') { chip = pipe.inputs.find(function (c) { return c.uid === chipUid; }); }
    else if (fromRole === 'results') { chip = pipe.results.find(function (c) { return c.uid === chipUid; }); }
    else { return; } // workspace chip can't move anywhere valid
    if (!chip || !canAccept(toRole, chip.storId)) {
      setStatusNote('That storage cannot take the ' + toRole.toUpperCase() + ' role.');
      return;
    }
    if (fromRole === 'results' && pipe.results.length <= 1) {
      setStatusNote('Keep at least one destination.');
      return;
    }
    removeNoRender(fromRole, chipUid);
    if (toRole === 'inputs') {
      pipe.inputs.push({ uid: chip.uid, storId: chip.storId, paths: chip.path || chip.paths || '' });
      if (!pipe.workspace) { pipe.workspace = { uid: ++uid, storId: 'tmpdir' }; }
    } else if (toRole === 'results') {
      const p = stor(chip.storId);
      const firstPath = (chip.paths || chip.path || (p ? p.base : '')).split('\\n')[0];
      pipe.results.push({ uid: chip.uid, storId: chip.storId, path: firstPath });
    }
    renderPipeline();
  }

  function removeNoRender(role, chipUid) {
    if (role === 'inputs') { pipe.inputs = pipe.inputs.filter(function (c) { return c.uid !== chipUid; }); }
    else if (role === 'results') { pipe.results = pipe.results.filter(function (c) { return c.uid !== chipUid; }); }
  }

  // ── pipeline rendering ──
  function chipHead(role, c, extra) {
    const p = stor(c.storId);
    return '<div class="chead" draggable="true" data-drag="' + role + ':' + c.uid + '">' +
      '<b>' + esc(p ? p.label : c.storId) + '</b>' +
      (extra || '') +
      '<span class="fine">' + esc(p ? p.lifetime : '') + '</span>' +
      '<span class="cx" data-rm="' + role + ':' + c.uid + '" title="remove">✕</span></div>';
  }

  function renderPipeline() {
    renderPalette(); // mounts in use leave the palette; removed chips return

    // INPUTS
    const ci = el('chips-inputs');
    ci.innerHTML = '';
    for (const c of pipe.inputs) {
      const d = document.createElement('div');
      d.className = 'chip';
      d.innerHTML = chipHead('inputs', c) +
        '<textarea rows="2" spellcheck="false" placeholder="one remote path per line — .tar/.tar.gz are extracted" data-paths="' + c.uid + '">' + esc(c.paths) + '</textarea>';
      ci.appendChild(d);
    }
    el('hintInputs').textContent = pipe.inputs.length ? '' : 'optional — datasets copied to $INPUT_DIR before the run';

    // WORKSPACE
    const cw = el('chips-workspace');
    cw.innerHTML = '';
    if (pipe.workspace) {
      const d = document.createElement('div');
      d.className = 'chip';
      const locked = pipe.inputs.length > 0;
      const p = stor('tmpdir');
      d.innerHTML = '<div class="chead"><b>$SLURM_TMPDIR</b><span class="fine">' + esc(p ? p.lifetime : '') + '</span>' +
        (locked ? '<span class="fine" style="margin-left:auto" title="stage-in sources require this workspace">locked by INPUTS</span>'
                : '<span class="cx" data-rm="workspace:' + pipe.workspace.uid + '" title="remove — run in place instead">✕</span>') +
        '</div>';
      cw.appendChild(d);
    } else {
      cw.innerHTML = '<div class="inplace">run in place — the script reads/writes the destination storage directly (fine for light I/O)</div>';
    }
    el('hintWs').textContent = pipe.workspace ? '' : 'drag $SLURM_TMPDIR here for fast node-local I/O';

    // RESULTS
    const cr = el('chips-results');
    cr.innerHTML = '';
    pipe.results.forEach(function (c, i) {
      const d = document.createElement('div');
      d.className = 'chip';
      const tag = i === 0 ? '<span class="tag">primary</span>'
                          : '<span class="mkprimary" data-primary="' + c.uid + '">set primary</span>';
      d.innerHTML = chipHead('results', c, tag) +
        '<input type="text" spellcheck="false" placeholder="/destination/dir" data-path="' + c.uid + '" value="' + esc(c.path) + '">';
      cr.appendChild(d);
    });
    el('hintRes').textContent = pipe.results.length > 1 ? 'primary receives OUTPUT_DIR; others get a mirror copy' : '';

    // hop labels
    el('hopInText').textContent = pipe.inputs.length
      ? 'rsync stage-in (.tar extracted) → $INPUT_DIR'
      : 'no stage-in';
    el('hopRunText').textContent = pipe.workspace
      ? 'compute (apptainer) in $SLURM_TMPDIR → trap-guarded rsync copy-back on exit'
      : 'compute (apptainer) writes directly to the primary destination';

    wireChips();
    regen();
  }

  function wireChips() {
    document.querySelectorAll('[data-rm]').forEach(function (x) {
      x.onclick = function () {
        const parts = x.getAttribute('data-rm').split(':');
        removeChip(parts[0], parseInt(parts[1], 10));
      };
    });
    document.querySelectorAll('[data-primary]').forEach(function (x) {
      x.onclick = function () {
        const cu = parseInt(x.getAttribute('data-primary'), 10);
        const idx = pipe.results.findIndex(function (c) { return c.uid === cu; });
        if (idx > 0) {
          const c = pipe.results.splice(idx, 1)[0];
          pipe.results.unshift(c);
          renderPipeline();
        }
      };
    });
    document.querySelectorAll('[data-paths]').forEach(function (t) {
      t.addEventListener('input', function () {
        const cu = parseInt(t.getAttribute('data-paths'), 10);
        const c = pipe.inputs.find(function (x) { return x.uid === cu; });
        if (c) { c.paths = t.value; regen(); }
      });
    });
    document.querySelectorAll('[data-path]').forEach(function (t) {
      t.addEventListener('input', function () {
        const cu = parseInt(t.getAttribute('data-path'), 10);
        const c = pipe.results.find(function (x) { return x.uid === cu; });
        if (c) { c.path = t.value; regen(); }
      });
    });
    document.querySelectorAll('[data-drag]').forEach(function (h) {
      h.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', 'chip:' + h.getAttribute('data-drag'));
        e.dataTransfer.effectAllowed = 'move';
        e.stopPropagation();
      });
    });
  }

  // ── mode & generation ──
  function setMode(m) {
    mode = m;
    el('modeQuick').classList.toggle('sel', m === 'quick');
    el('modeJob').classList.toggle('sel', m === 'job');
    el('jobFields').classList.toggle('hidden', m === 'quick');
    el('pipeWrap').classList.toggle('hidden', m === 'quick');
    el('quickOutWrap').classList.toggle('hidden', m === 'job');
    el('previewWrap').classList.toggle('hidden', m === 'quick');
    el('quickPreviewWrap').classList.toggle('hidden', m === 'job');
    el('saveWrap').classList.toggle('hidden', m === 'quick');
    el('go').textContent = m === 'quick' ? 'Run now' : 'Submit job';
    regen();
  }

  function gen() {
    const t = init.tpl;
    const args = el('args').value.trim();
    const gpus = parseInt(el('gpus').value, 10) || 0;
    const primary = pipe.results[0] ? pipe.results[0].path.trim() : '';
    const mirrors = pipe.results.slice(1).map(function (c) { return c.path.trim(); }).filter(Boolean);
    const staging = !!pipe.workspace;

    const acct = el('account').value;
    const lines = [
      '#!/bin/bash',
      '#SBATCH --job-name=' + (el('jobName').value.trim() || t.defaultJobName),
      '#SBATCH --time=' + (el('time').value.trim() || '03:00:00'),
    ];
    // no account line when empty: sbatch then uses the user's default association
    if (acct) { lines.splice(2, 0, '#SBATCH --account=' + acct); }
    lines.push(
      '#SBATCH --cpus-per-task=' + (el('cpus').value.trim() || '4'),
      '#SBATCH --mem=' + (el('mem').value.trim() || '8G')
    );
    if (gpus > 0) { lines.push('#SBATCH --gpus-per-node=' + gpus); }
    lines.push('#SBATCH --output=' + primary + '/slurm-%j.out');
    lines.push('');
    lines.push('set -euo pipefail');
    lines.push('mkdir -p "' + primary + '"');
    lines.push(t.apptainerLoad);
    lines.push('');
    // Manifests: the produced-files list from $OUT is cheap and always on
    // (staging mode); full destination before/after diffs cost a file scan of
    // each destination and are opt-in via the trackDiff checkbox.
    const trackDiff = el('trackDiff').checked;
    const allDests = [primary].concat(mirrors);
    lines.push('META="$HOME/.hpcsync_jobs/meta/$SLURM_JOB_ID"');
    lines.push('mkdir -p "$META"');
    lines.push('find "$HOME/.hpcsync_jobs/meta" -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null || true');
    lines.push('manifest() { find "$1" -type f -printf "%P|%s\\n" 2>/dev/null | sort; }');
    if (trackDiff) {
      lines.push(': > "$META/dests.txt"');
      allDests.forEach(function (d, i) {
        lines.push('echo "' + d + '" >> "$META/dests.txt"');
        lines.push('echo "[hpc-sync] scanning destination ' + (i + 1) + '/' + allDests.length + ' for diff (before)"');
        lines.push('manifest "' + d + '" > "$META/before_' + i + '.txt"');
      });
    }
    lines.push('');

    let envLines;
    if (staging) {
      lines.push('# --- pipeline: stage-in -> compute on node-local NVMe -> copy-back ---');
      lines.push('IN="$SLURM_TMPDIR/input"');
      lines.push('OUT="$SLURM_TMPDIR/out"');
      lines.push('mkdir -p "$IN" "$OUT"');
      for (const c of pipe.inputs) {
        const paths = c.paths.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean);
        for (const p of paths) {
          if (/\\.tar(\\.(gz|zst|bz2))?$/.test(p)) {
            lines.push('echo "[hpc-sync] extracting ' + p + ' -> $IN"; tar -xf "' + p + '" -C "$IN"');
          } else {
            lines.push('echo "[hpc-sync] staging in ' + p + ' -> $IN"; rsync -a "' + p + '" "$IN/"');
          }
        }
      }
      lines.push('# deliver results to every destination, even on failure/time-limit');
      const copies = ['manifest "$OUT" > "$META/produced.txt"'];
      copies.push('awk -F"|" \\'{n++; s+=$2} END{printf "[hpc-sync] produced %d files (%.1f MB)\\\\n", n, s/1048576}\\' "$META/produced.txt"');
      copies.push('mkdir -p "' + primary + '"; rsync -a "$OUT"/ "' + primary + '"/ || true');
      for (const mdir of mirrors) {
        copies.push('mkdir -p "' + mdir + '"; rsync -a "$OUT"/ "' + mdir + '"/ || true');
      }
      if (trackDiff) {
        allDests.forEach(function (d, i) {
          copies.push('manifest "' + d + '" > "$META/after_' + i + '.txt"');
        });
      }
      // Reentry guard: on SIGTERM the TERM trap runs, then errexit exits the
      // shell and fires the EXIT trap again — without the guard, stage-out
      // would run twice inside Slurm's kill window. set +e inside keeps one
      // failed destination (e.g. quota) from aborting the remaining copies.
      lines.push('stageout() { [ -n "\${HPCSYNC_STAGED:-}" ] && return 0; HPCSYNC_STAGED=1; set +e; echo "[hpc-sync] staging out results to destination(s)"; ' + copies.join('; ') + '; }');
      lines.push('trap stageout EXIT TERM');
      lines.push('');
      envLines = [
        '  --bind "$SLURM_TMPDIR" \\\\',
        '  --env OUTPUT_DIR="$OUT" \\\\',
        '  --env INPUT_DIR="$IN" \\\\'
      ];
    } else {
      envLines = ['  --env OUTPUT_DIR="' + primary + '" \\\\'];
    }

    // bind project mounts referenced by the pipeline into the container and
    // expose each as HPC_MOUNT_<NAME> so code can find it without hardcoding
    const bindPaths = [];
    const mountEnvs = [];
    const noteBind = function (storId) {
      const p = stor(storId);
      if (p && p.bind && p.base && bindPaths.indexOf(p.base) < 0) {
        bindPaths.push(p.base);
        if (p.mountName) {
          mountEnvs.push('HPC_MOUNT_' + p.mountName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() + '="' + p.base + '"');
        }
      }
    };
    for (const c of pipe.inputs) { noteBind(c.storId); }
    for (const c of pipe.results) { noteBind(c.storId); }

    lines.push('apptainer exec \\\\');
    lines.push('  --bind ' + t.remoteProjectDir + ':' + t.containerWorkdir + ' \\\\');
    for (const bp of bindPaths) { lines.push('  --bind ' + bp + ' \\\\'); }
    for (const me of mountEnvs) { lines.push('  --env ' + me + ' \\\\'); }
    for (const l of envLines) { lines.push(l); }
    lines.push('  --env PYTHONUNBUFFERED=1 \\\\');
    lines.push('  ' + t.sifPath + ' \\\\');
    lines.push('  python -u ' + t.containerWorkdir + '/' + init.script + (args ? ' ' + args : ''));
    if (!staging && mirrors.length) {
      lines.push('');
      lines.push('# mirror results to secondary destinations');
      for (const mdir of mirrors) {
        lines.push('mkdir -p "' + mdir + '"; rsync -a "' + primary + '"/ "' + mdir + '"/');
      }
    }
    if (!staging && trackDiff) {
      lines.push('');
      allDests.forEach(function (d, i) {
        lines.push('manifest "' + d + '" > "$META/after_' + i + '.txt"');
      });
    }
    lines.push('');
    return lines.join('\\n');
  }

  function regen() {
    if (!init) { return; }
    if (mode === 'job') {
      el('preview').value = gen();
    } else {
      const args = el('args').value.trim();
      el('quickPreview').value =
        'apptainer exec --bind ' + init.tpl.remoteProjectDir + ':' + init.tpl.containerWorkdir +
        ' --env OUTPUT_DIR=' + el('quickOut').value.trim() +
        ' ' + init.tpl.sifPath + ' python -u ' + init.tpl.containerWorkdir + '/' + init.script +
        (args ? ' ' + args : '') + '\\n(runs on the login node over the shared SSH session)';
    }
  }

  function go() {
    if (!init) { return; }
    if (mode === 'job' && (!pipe.results[0] || !pipe.results[0].path.trim())) {
      setStatusNote('Set a path on the primary destination first.');
      return;
    }
    el('status').textContent = mode === 'quick' ? 'Starting…' : 'Submitting…';
    vscode.postMessage({
      command: 'launch',
      mode: mode,
      script: init.script,
      args: el('args').value.trim(),
      outputDir: el('quickOut').value.trim(),
      jobName: el('jobName').value.trim() || init.tpl.defaultJobName,
      content: el('preview').value,
      saveLocal: el('saveLocal').checked
    });
  }
</script>
</body>
</html>`;
  }
}
