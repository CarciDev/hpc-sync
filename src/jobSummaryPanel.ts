import * as vscode from 'vscode';
import { shq } from './config';
import { parseSlurmDuration } from './jobsMonitor';
import { SshManager } from './sshManager';

// ── parsing helpers (exported for smoke tests) ──

export function parseScontrol(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z][\w:/]*)=(\S*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!(m[1] in out)) {
      out[m[1]] = m[2];
    }
  }
  return out;
}

/** "123K" / "1.5G" / "8000M" → bytes (1024 base, as Slurm uses). */
export function parseMemBytes(s: string): number | undefined {
  const m = /^([\d.]+)\s*([KMGTP]?)/i.exec((s || '').trim());
  if (!m) {
    return undefined;
  }
  const v = parseFloat(m[1]);
  if (Number.isNaN(v)) {
    return undefined;
  }
  const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return v * (mult[m[2].toUpperCase()] ?? 1);
}

export interface ManifestEntry {
  p: string;
  s: number;
}

export function parseManifest(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of text.split('\n')) {
    const i = line.lastIndexOf('|');
    if (i > 0) {
      const size = parseInt(line.slice(i + 1), 10);
      if (!Number.isNaN(size)) {
        map.set(line.slice(0, i), size);
      }
    }
  }
  return map;
}

export interface ManifestDiff {
  added: ManifestEntry[];
  modified: ManifestEntry[];
  removed: string[];
  addedBytes: number;
}

export function diffManifests(before: Map<string, number>, after: Map<string, number>): ManifestDiff {
  const added: ManifestEntry[] = [];
  const modified: ManifestEntry[] = [];
  const removed: string[] = [];
  let addedBytes = 0;
  for (const [p, s] of after) {
    const prev = before.get(p);
    if (prev === undefined) {
      added.push({ p, s });
      addedBytes += s;
    } else if (prev !== s) {
      modified.push({ p, s });
    }
  }
  for (const p of before.keys()) {
    if (!after.has(p)) {
      removed.push(p);
    }
  }
  added.sort((a, b) => b.s - a.s);
  modified.sort((a, b) => b.s - a.s);
  return { added, modified, removed, addedBytes };
}

interface SacctRow {
  [k: string]: string;
}

const SACCT_FIELDS = [
  'JobID', 'JobName', 'State', 'Account', 'Partition', 'Elapsed', 'Timelimit',
  'TotalCPU', 'AllocCPUS', 'ReqMem', 'MaxRSS', 'NNodes', 'Submit', 'Start', 'End', 'ExitCode', 'ReqTRES',
];

export function parseSacct(text: string): { parent?: SacctRow; maxRssBytes?: number } {
  let parent: SacctRow | undefined;
  let maxRssBytes: number | undefined;
  for (const line of text.split('\n')) {
    const f = line.split('|');
    if (f.length < SACCT_FIELDS.length) {
      continue;
    }
    const row: SacctRow = {};
    SACCT_FIELDS.forEach((k, i) => (row[k] = f[i] ?? ''));
    if (!row.JobID.includes('.')) {
      parent = parent ?? row;
    }
    const rss = parseMemBytes(row.MaxRSS);
    if (rss !== undefined && (maxRssBytes === undefined || rss > maxRssBytes)) {
      maxRssBytes = rss;
    }
  }
  return { parent, maxRssBytes };
}

// ── the panel ──

interface DestChange {
  path: string;
  added: number;
  addedBytes: number;
  modified: number;
  removed: number;
  topAdded: ManifestEntry[];
}

export class JobSummaryPanel {
  private static readonly panels = new Map<string, JobSummaryPanel>();

  static show(jobId: string, ssh: SshManager): void {
    const existing = JobSummaryPanel.panels.get(jobId);
    if (existing) {
      existing.panel.reveal(undefined, true);
      void existing.load();
      return;
    }
    JobSummaryPanel.panels.set(jobId, new JobSummaryPanel(jobId, ssh));
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly jobId: string,
    private readonly ssh: SshManager
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'hpcSyncJobSummary',
      `Job ${jobId} — summary`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => JobSummaryPanel.panels.delete(this.jobId));
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg: { command: string }) => {
      if (msg.command === 'ready' || msg.command === 'refresh') {
        void this.load();
      } else if (msg.command === 'console') {
        void vscode.commands.executeCommand('hpcSync.jobOutput', this.jobId);
      }
    });
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private async load(): Promise<void> {
    try {
      await this.ssh.ensureConnected();
      const id = this.jobId;

      // Prefer scontrol (live jobs, rich); fall back to sacct (finished).
      const sc = await this.ssh.exec(`scontrol show job ${id} 2>/dev/null`);
      const kv = sc.code === 0 && sc.stdout.trim() ? parseScontrol(sc.stdout) : undefined;

      const sa = await this.ssh.exec(
        `sacct -j ${id} -n -P -o ${SACCT_FIELDS.map((f) => (f === 'JobName' ? 'JobName%40' : f)).join(',')}`
      );
      const acct = sa.code === 0 ? parseSacct(sa.stdout) : {};
      const p = acct.parent;

      const state = (kv?.JobState ?? p?.State ?? 'UNKNOWN').split(' ')[0];
      const pendingLike = state === 'PENDING';

      const elapsedSec = parseSlurmDuration(kv?.RunTime ?? p?.Elapsed ?? '');
      const limitSec = parseSlurmDuration(kv?.TimeLimit ?? p?.Timelimit ?? '');
      const submit = kv?.SubmitTime ?? p?.Submit;
      const start = kv?.StartTime ?? p?.Start;
      const end = kv?.EndTime ?? p?.End;
      const waitSec =
        submit && start && !start.startsWith('Unknown') && !start.startsWith('N/A')
          ? Math.max(0, (new Date(start).getTime() - new Date(submit).getTime()) / 1000)
          : undefined;

      const cpus = parseInt(kv?.NumCPUs ?? p?.AllocCPUS ?? '', 10) || undefined;
      const gpuM = /gres\/gpu[:=](\d+)/.exec((kv?.TresPerNode ?? '') + ' ' + (p?.ReqTRES ?? ''));

      // Efficiency (finished jobs with accounting)
      let efficiency: { cpuPct?: number; memPct?: number; maxRss?: number; reqMemBytes?: number; totalCpu?: string } | undefined;
      if (p && elapsedSec > 0 && cpus) {
        const totalCpuSec = parseSlurmDuration(p.TotalCPU ?? '');
        const reqMemRaw = (p.ReqMem ?? '').replace(/[nc]$/i, '');
        const perCpu = /c$/i.test(p.ReqMem ?? '');
        let reqMemBytes = parseMemBytes(reqMemRaw);
        if (reqMemBytes !== undefined && perCpu) {
          reqMemBytes *= cpus;
        }
        efficiency = {
          cpuPct: totalCpuSec > 0 ? Math.min(100, Math.round((totalCpuSec / (elapsedSec * cpus)) * 100)) : undefined,
          memPct:
            acct.maxRssBytes !== undefined && reqMemBytes
              ? Math.min(100, Math.round((acct.maxRssBytes / reqMemBytes) * 100))
              : undefined,
          maxRss: acct.maxRssBytes,
          reqMemBytes,
          totalCpu: p.TotalCPU,
        };
      }

      // Priority breakdown for pending jobs
      let sprio: string | undefined;
      if (pendingLike) {
        const pr = await this.ssh.exec(`sprio -j ${id} -l 2>/dev/null`);
        if (pr.code === 0 && pr.stdout.trim()) {
          sprio = pr.stdout;
        }
      }

      // Changes from manifests written by generated job scripts
      let changes: { dests: DestChange[]; produced?: { files: number; bytes: number } } | undefined;
      const home = await this.ssh.getHomeDir();
      const meta = `${home}/.hpcsync_jobs/meta/${id}`;
      const dests = await this.ssh.exec(`cat ${shq(meta + '/dests.txt')} 2>/dev/null`);
      if (dests.code === 0 && dests.stdout.trim()) {
        const destPaths = dests.stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
        const destChanges: DestChange[] = [];
        for (let i = 0; i < destPaths.length; i++) {
          const before = await this.ssh.exec(`cat ${shq(`${meta}/before_${i}.txt`)} 2>/dev/null`);
          const after = await this.ssh.exec(`cat ${shq(`${meta}/after_${i}.txt`)} 2>/dev/null`);
          if (after.code !== 0) {
            continue; // job still running — after-manifest not written yet
          }
          const d = diffManifests(parseManifest(before.stdout), parseManifest(after.stdout));
          destChanges.push({
            path: destPaths[i],
            added: d.added.length,
            addedBytes: d.addedBytes,
            modified: d.modified.length,
            removed: d.removed.length,
            topAdded: d.added.slice(0, 40),
          });
        }
        let produced: { files: number; bytes: number } | undefined;
        const prod = await this.ssh.exec(`cat ${shq(meta + '/produced.txt')} 2>/dev/null`);
        if (prod.code === 0 && prod.stdout.trim()) {
          const man = parseManifest(prod.stdout);
          let bytes = 0;
          for (const s of man.values()) {
            bytes += s;
          }
          produced = { files: man.size, bytes };
        }
        if (destChanges.length || produced) {
          changes = { dests: destChanges, produced };
        }
      }

      this.post({
        type: 'data',
        jobId: id,
        state,
        name: kv?.JobName ?? p?.JobName ?? '',
        account: kv?.Account ?? p?.Account,
        partition: kv?.Partition ?? p?.Partition,
        reason: kv?.Reason,
        exitCode: kv?.ExitCode ?? p?.ExitCode,
        nodes: kv?.NumNodes ?? p?.NNodes,
        nodeList: kv?.NodeList,
        cpus,
        gpus: gpuM ? parseInt(gpuM[1], 10) : undefined,
        elapsedSec,
        limitSec,
        elapsed: kv?.RunTime ?? p?.Elapsed,
        limit: kv?.TimeLimit ?? p?.Timelimit,
        submit,
        start,
        end,
        waitSec,
        efficiency,
        sprio,
        changes,
        raw: (kv ? sc.stdout : '') + (sa.stdout ? '\n# sacct\n' + sa.stdout : ''),
      });
    } catch (e) {
      this.post({ type: 'error', text: (e as Error).message });
    }
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 14px 18px; max-width: 860px; }
  h2 { margin: 0; font-size: 1.2em; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h3 { margin: 18px 0 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .badge { font-size: 0.72em; font-weight: 700; border-radius: 3px; padding: 2px 8px; letter-spacing: 0.03em; }
  .badge.RUNNING { background: #2ea043; color: #fff; }
  .badge.PENDING { background: #d29922; color: #fff; }
  .badge.COMPLETED { background: #3fb950; color: #fff; }
  .badge.FAILED, .badge.NODE_FAIL, .badge.OUT_OF_MEMORY { background: #f85149; color: #fff; }
  .badge.TIMEOUT { background: #db6d28; color: #fff; }
  .badge.other { background: #8b949e; color: #fff; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin-top: 12px; }
  .tile { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); border-radius: 6px; padding: 8px 10px; }
  .tile .k { font-size: 0.76em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
  .tile .v { font-size: 1.05em; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }
  .timeline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; font-size: 0.92em; }
  .tl { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); border-radius: 12px; padding: 3px 12px; }
  .tl b { font-weight: 600; }
  .tlarrow { color: var(--vscode-descriptionForeground); }
  .tldur { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .bar-track { background: var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); border-radius: 3px; height: 7px; margin-top: 5px; }
  .bar { height: 7px; border-radius: 3px; background: #2ea043; }
  .bar.warn { background: #d29922; }
  .bar.crit { background: #f85149; }
  .eff { margin-bottom: 10px; }
  .eff .row { display: flex; justify-content: space-between; font-size: 0.92em; }
  .eff .hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 2px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th { text-align: left; color: var(--vscode-descriptionForeground); font-weight: 600; padding: 3px 8px 3px 0; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); }
  td { padding: 3px 8px 3px 0; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.08)); overflow-wrap: anywhere; }
  td.num { text-align: right; white-space: nowrap; }
  .destcard { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; }
  .destcard .head { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .destcard .sum b { color: #2ea043; }
  pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; overflow-x: auto; background: var(--vscode-editor-background); padding: 8px; border-radius: 4px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 0.9em; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; padding: 4px 12px; cursor: pointer; font-family: inherit; font-size: 0.9em; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .error { color: #f85149; }
</style>
</head>
<body>
  <div id="root"><span class="empty">loading…</span></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtBytes(n) {
    if (n >= 1073741824) { return (n / 1073741824).toFixed(2) + ' GB'; }
    if (n >= 1048576) { return (n / 1048576).toFixed(1) + ' MB'; }
    if (n >= 1024) { return (n / 1024).toFixed(1) + ' KB'; }
    return n + ' B';
  }
  function fmtDur(sec) {
    if (sec == null || sec < 0) { return '—'; }
    sec = Math.round(sec);
    if (sec < 60) { return sec + 's'; }
    const m = Math.floor(sec / 60);
    if (m < 60) { return m + 'm ' + (sec % 60) + 's'; }
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function barClass(p) { return p >= 90 ? 'bar crit' : p >= 70 ? 'bar warn' : 'bar'; }
  function badge(state) {
    const known = ['RUNNING','PENDING','COMPLETED','FAILED','NODE_FAIL','OUT_OF_MEMORY','TIMEOUT'];
    const cls = known.indexOf(state) >= 0 ? state : 'other';
    return '<span class="badge ' + cls + '">' + esc(state) + '</span>';
  }
  function tile(k, v) {
    return v == null || v === '' ? '' : '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  }
  function effBlock(label, pct, valueText, hint) {
    if (pct == null) { return ''; }
    return '<div class="eff"><div class="row"><span>' + esc(label) + '</span><span>' + esc(valueText) + '</span></div>' +
      '<div class="bar-track"><div class="' + barClass(100 - pct) + '" style="width:' + Math.max(2, pct) + '%"></div></div>' +
      (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  window.addEventListener('message', function (e) {
    const m = e.data;
    const root = document.getElementById('root');
    if (m.type === 'error') { root.innerHTML = '<div class="error">' + esc(m.text) + '</div>'; return; }
    if (m.type !== 'data') { return; }

    let html = '<h2>' + badge(m.state) + esc(m.name || 'job') + ' <span class="meta">#' + esc(m.jobId) + '</span>' +
      '<span style="flex:1"></span><button id="btnConsole">Console</button><button id="btnRefresh">Refresh</button></h2>';

    // timeline: submitted → started (queued X) → ended (ran Y)
    html += '<div class="timeline">';
    if (m.submit) { html += '<span class="tl">submitted <b>' + esc(String(m.submit).replace('T', ' ')) + '</b></span>'; }
    if (m.waitSec != null) { html += '<span class="tlarrow">→</span><span class="tldur">queued ' + fmtDur(m.waitSec) + '</span><span class="tlarrow">→</span>'; }
    if (m.start && !String(m.start).startsWith('Unknown')) { html += '<span class="tl">started <b>' + esc(String(m.start).replace('T', ' ')) + '</b></span>'; }
    if (m.end && !String(m.end).startsWith('Unknown') && m.state !== 'RUNNING' && m.state !== 'PENDING') {
      html += '<span class="tlarrow">→</span><span class="tldur">ran ' + fmtDur(m.elapsedSec) + '</span><span class="tlarrow">→</span>' +
        '<span class="tl">ended <b>' + esc(String(m.end).replace('T', ' ')) + '</b></span>';
    }
    html += '</div>';

    html += '<div class="tiles">' +
      tile('elapsed / limit', esc(m.elapsed || '—') + ' / ' + esc(m.limit || '—')) +
      tile('cpus', m.cpus) +
      tile('gpus', m.gpus) +
      tile('nodes', esc(m.nodes || '') + (m.nodeList ? ' · ' + esc(m.nodeList) : '')) +
      tile('account', esc(m.account)) +
      tile('partition', esc((m.partition || '').split(',')[0])) +
      tile('exit code', esc(m.exitCode)) +
      '</div>';
    if (m.state === 'RUNNING' && m.elapsedSec >= 0 && m.limitSec > 0) {
      const pct = Math.min(100, Math.round((m.elapsedSec / m.limitSec) * 100));
      html += '<div class="bar-track" style="margin-top:8px"><div class="' + barClass(pct) + '" style="width:' + pct + '%"></div></div>';
    }

    html += '<h3>Resource efficiency</h3>';
    if (m.efficiency && (m.efficiency.cpuPct != null || m.efficiency.memPct != null)) {
      html += effBlock('CPU', m.efficiency.cpuPct,
        (m.efficiency.cpuPct != null ? m.efficiency.cpuPct + '%' : '—') + ' of allocated CPU time used (' + esc(m.efficiency.totalCpu || '') + ')',
        m.efficiency.cpuPct != null && m.efficiency.cpuPct < 40 ? 'well under allocation — consider requesting fewer CPUs next time' : '');
      html += effBlock('Memory', m.efficiency.memPct,
        (m.efficiency.maxRss != null ? fmtBytes(m.efficiency.maxRss) : '—') + ' peak of ' + (m.efficiency.reqMemBytes != null ? fmtBytes(m.efficiency.reqMemBytes) : '—') + ' requested',
        m.efficiency.memPct != null && m.efficiency.memPct < 40 ? 'well under allocation — consider requesting less memory next time' : (m.efficiency.memPct != null && m.efficiency.memPct > 90 ? 'close to the limit — request more next time to avoid OOM kills' : ''));
    } else if (m.state === 'RUNNING') {
      html += '<div class="empty">⏳ Measured from Slurm accounting when the job finishes — CPU and memory efficiency will appear here after completion (hit Refresh then).</div>';
    } else if (m.state === 'PENDING') {
      html += '<div class="empty">Available once the job has run.</div>';
    } else {
      html += '<div class="empty">No accounting data available for this job.</div>';
    }

    if (m.sprio) {
      html += '<h3>Priority breakdown (pending)</h3><pre>' + esc(m.sprio) + '</pre>';
    }

    html += '<h3>Changes (what this job wrote)</h3>';
    if (m.changes) {
      if (m.changes.produced) {
        html += '<div class="meta" style="margin-bottom:6px">produced in workspace: <b>' + m.changes.produced.files + ' files, ' + fmtBytes(m.changes.produced.bytes) + '</b></div>';
      }
      if (m.changes.dests.length === 0) {
        html += m.state === 'RUNNING' || m.state === 'PENDING'
          ? '<div class="empty">⏳ Change tracking is active for this job — destination diffs are finalized at stage-out when the job ends.</div>'
          : '<div class="empty">Manifests are incomplete for this job (it may have been killed before stage-out could run).</div>';
      }
      for (const d of m.changes.dests) {
        html += '<div class="destcard"><div class="head"><span class="meta" title="' + esc(d.path) + '">' + esc(d.path) + '</span>' +
          '<span class="sum"><b>+' + d.added + '</b> new (' + fmtBytes(d.addedBytes) + ') · ' + d.modified + ' modified · ' + d.removed + ' removed</span></div>';
        if (d.topAdded.length) {
          html += '<details' + (d.topAdded.length <= 8 ? ' open' : '') + '><summary>new files</summary><table><tr><th>file</th><th class="num">size</th></tr>';
          for (const f of d.topAdded) {
            html += '<tr><td>' + esc(f.p) + '</td><td class="num">' + fmtBytes(f.s) + '</td></tr>';
          }
          html += '</table></details>';
        }
        html += '</div>';
      }
    } else if (m.state === 'RUNNING' || m.state === 'PENDING') {
      html += '<div class="empty">This job was not launched with change tracking (Launch panel, v0.9.0+), so no diff will be recorded for it.</div>';
    } else {
      html += '<div class="empty">Not tracked — this job predates change tracking or was not launched through the extension.</div>';
    }

    if (m.raw) {
      html += '<details><summary>Raw scontrol / sacct output</summary><pre>' + esc(m.raw) + '</pre></details>';
    }

    root.innerHTML = html;
    document.getElementById('btnConsole').onclick = function () { vscode.postMessage({ command: 'console' }); };
    document.getElementById('btnRefresh').onclick = function () { vscode.postMessage({ command: 'refresh' }); };
  });

  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
