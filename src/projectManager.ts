import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig, shq } from './config';
import { log } from './log';
import {
  BUILTIN_TEMPLATES,
  loadProjectConfig,
  ProjectTemplate,
  saveProjectConfig,
  syncDockerfileMountEnv,
} from './projectConfig';
import { SshManager } from './sshManager';
import { SyncEngine } from './syncEngine';

const TEMPLATES_KEY = 'hpcSync.projectTemplates';

/** After the extension edits the Dockerfile, apply it per hpcSync.autoRebuildDevcontainer. */
async function maybeRebuildContainer(reason: string): Promise<void> {
  const mode = vscode.workspace
    .getConfiguration('hpcSync')
    .get<string>('autoRebuildDevcontainer', 'prompt');
  if (mode === 'never') {
    return;
  }
  if (vscode.env.remoteName !== 'dev-container') {
    log.appendLine(`[project] ${reason} — rebuild the dev container next time you open it to apply.`);
    return;
  }
  if (mode === 'always') {
    log.appendLine(`[project] ${reason} — auto-rebuilding the dev container`);
    void vscode.commands.executeCommand('remote-containers.rebuildContainer');
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `${reason}. Rebuild the dev container now to apply it? (This restarts the container and reloads the window.)`,
    'Rebuild now',
    'Later'
  );
  if (pick === 'Rebuild now') {
    void vscode.commands.executeCommand('remote-containers.rebuildContainer');
  }
}

interface Msg {
  command: string;
  name?: string;
  path?: string;
  purpose?: string;
  dockerfile?: string;
  devcontainer?: string;
  requirements?: string;
  overwrite?: boolean;
  mounts?: string[];
  dest?: string;
}

/**
 * Interactive project manager: detects whether this workspace is set up for
 * the HPC workflow (dev container config locally, .sif on the cluster),
 * scaffolds new projects from CRUD-able templates, exports the environment
 * (.sif build), and manages "project mounts" — named cluster directories the
 * project depends on, stored in .hpcproject.json and surfaced in the Launch
 * panel's storage palette.
 */
export class ProjectManagerPanel {
  private static current?: ProjectManagerPanel;

  static show(ssh: SshManager, engine: SyncEngine, memento: vscode.Memento): void {
    if (ProjectManagerPanel.current) {
      ProjectManagerPanel.current.panel.reveal(undefined, true);
      void ProjectManagerPanel.current.sendState();
      return;
    }
    ProjectManagerPanel.current = new ProjectManagerPanel(ssh, engine, memento);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly ssh: SshManager,
    private readonly engine: SyncEngine,
    private readonly memento: vscode.Memento
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'hpcSyncProject',
      'HPC Project Manager',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      if (ProjectManagerPanel.current === this) {
        ProjectManagerPanel.current = undefined;
      }
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg: Msg) => void this.onMessage(msg));
  }

  private templates(): ProjectTemplate[] {
    const custom = this.memento.get<ProjectTemplate[]>(TEMPLATES_KEY, []);
    return [...BUILTIN_TEMPLATES, ...custom.map((t) => ({ ...t, builtin: false }))];
  }

  private async onMessage(msg: Msg): Promise<void> {
    const cfg = getConfig();
    switch (msg.command) {
      case 'ready':
      case 'refresh':
        await this.sendState();
        break;
      case 'scaffold':
        await this.scaffold(msg.name ?? '', msg.overwrite === true);
        break;
      case 'saveTemplate': {
        if (!msg.name?.trim()) {
          break;
        }
        const custom = this.memento
          .get<ProjectTemplate[]>(TEMPLATES_KEY, [])
          .filter((t) => t.name !== msg.name);
        custom.push({
          name: msg.name.trim(),
          dockerfile: msg.dockerfile ?? '',
          devcontainer: msg.devcontainer ?? '',
          requirements: msg.requirements ?? '',
        });
        await this.memento.update(TEMPLATES_KEY, custom);
        void vscode.window.showInformationMessage(`HPC Sync: template '${msg.name}' saved.`);
        await this.sendState();
        break;
      }
      case 'templateFromProject': {
        // capture the current project's files as a new template
        const df = fs.existsSync(cfg.dockerfilePath) ? fs.readFileSync(cfg.dockerfilePath, 'utf8') : '';
        const dc = path.join(cfg.localProjectDir, '.devcontainer', 'devcontainer.json');
        const dcText = fs.existsSync(dc) ? fs.readFileSync(dc, 'utf8') : '';
        const req = fs.existsSync(cfg.requirementsPath) ? fs.readFileSync(cfg.requirementsPath, 'utf8') : '';
        this.post({ type: 'editTemplate', name: '', dockerfile: df, devcontainer: dcText, requirements: req });
        break;
      }
      case 'editTemplate': {
        const t = this.templates().find((x) => x.name === msg.name);
        if (t) {
          this.post({
            type: 'editTemplate',
            name: t.builtin ? t.name + '-custom' : t.name,
            dockerfile: t.dockerfile,
            devcontainer: t.devcontainer,
            requirements: t.requirements,
          });
        }
        break;
      }
      case 'deleteTemplate': {
        const custom = this.memento
          .get<ProjectTemplate[]>(TEMPLATES_KEY, [])
          .filter((t) => t.name !== msg.name);
        await this.memento.update(TEMPLATES_KEY, custom);
        await this.sendState();
        break;
      }
      case 'addMount': {
        if (!msg.name?.trim() || !msg.path?.trim()) {
          break;
        }
        const pc = loadProjectConfig();
        pc.mounts = pc.mounts.filter((m) => m.name !== msg.name!.trim());
        pc.mounts.push({ name: msg.name.trim(), path: msg.path.trim().replace(/\/+$/, ''), purpose: msg.purpose?.trim() || undefined });
        saveProjectConfig(pc);
        log.appendLine(`[project] mount added: ${msg.name} -> ${msg.path}`);
        if (syncDockerfileMountEnv(cfg.dockerfilePath, pc.mounts)) {
          log.appendLine('[project] Dockerfile ENV block synced (excluded from rebuild detection)');
          void maybeRebuildContainer('Mount ENV defaults were written to the Dockerfile');
        }
        await this.sendState();
        break;
      }
      case 'removeMount': {
        const pc = loadProjectConfig();
        pc.mounts = pc.mounts.filter((m) => m.name !== msg.name);
        saveProjectConfig(pc);
        if (syncDockerfileMountEnv(cfg.dockerfilePath, pc.mounts)) {
          log.appendLine('[project] Dockerfile ENV block synced (excluded from rebuild detection)');
          void maybeRebuildContainer('Mount ENV defaults were updated in the Dockerfile');
        }
        await this.sendState();
        break;
      }
      case 'export': {
        const pc = loadProjectConfig();
        if (pc.mounts.length > 0) {
          const pick = await vscode.window.showInformationMessage(
            `This project depends on ${pc.mounts.length} mounted director${pc.mounts.length === 1 ? 'y' : 'ies'} (${pc.mounts
              .map((m) => m.name)
              .join(', ')}). ` +
              'These are NOT baked into the image — they are bind-mounted at run time by jobs that use them, ' +
              'which keeps the image small and the data in one canonical place. Continue with the build?',
            { modal: true },
            'Build .sif'
          );
          if (pick !== 'Build .sif') {
            break;
          }
        }
        void this.engine.sync({ forceRebuild: true });
        break;
      }
      case 'browse': {
        if (!msg.path) {
          break;
        }
        try {
          await this.ssh.ensureConnected();
          const { entries, truncated } = await this.ssh.listDir(msg.path);
          this.post({ type: 'dir', path: msg.path, entries, truncated });
        } catch (e) {
          this.post({ type: 'dir', path: msg.path, entries: [], error: (e as Error).message });
        }
        break;
      }
      case 'bundle': {
        await this.buildBundle(msg.mounts ?? [], msg.dest ?? '');
        break;
      }
      case 'shim': {
        await this.generateShim();
        break;
      }
      case 'verifyMounts': {
        try {
          await this.ssh.ensureConnected();
          const pc = loadProjectConfig();
          const results: string[] = [];
          for (const m of pc.mounts) {
            const r = await this.ssh.exec(`test -d ${shq(m.path)} && du -sh ${shq(m.path)} 2>/dev/null | cut -f1`);
            results.push(r.code === 0 ? `✓ ${m.name} — ${m.path} (${r.stdout.trim() || 'exists'})` : `✗ ${m.name} — ${m.path} MISSING`);
          }
          this.post({ type: 'mountCheck', results });
        } catch (e) {
          this.post({ type: 'mountCheck', results: ['connection failed: ' + (e as Error).message] });
        }
        break;
      }
    }
  }

  /**
   * Deployable bundle: one tar on the cluster containing the .sif, the synced
   * project code, and the selected mount directories — everything someone
   * else needs to run this project. Paths keep their absolute hierarchy
   * (extract with `tar -xf bundle.tar -C /` or inspect with `tar -tf`).
   */
  private async buildBundle(mountNames: string[], dest: string): Promise<void> {
    const cfg = getConfig();
    try {
      await this.ssh.ensureConnected();
      const remoteBase = await this.ssh.expandRemotePath(cfg.remoteProjectDir);
      const sifPath = `${await this.ssh.expandRemotePath(cfg.remoteSifDir)}/${cfg.sifName}`;
      const selected = loadProjectConfig().mounts.filter((m) => mountNames.includes(m.name));
      const destPath = (await this.ssh.expandRemotePath(dest)).trim();
      if (!destPath.endsWith('.tar')) {
        void vscode.window.showErrorMessage('HPC Sync: bundle destination must end in .tar');
        return;
      }
      if (!destPath.startsWith('/')) {
        void vscode.window.showErrorMessage(
          'HPC Sync: bundle destination must be an absolute path (e.g. /project/…/bundles/x.tar)'
        );
        return;
      }
      const paths = [sifPath, remoteBase, ...selected.map((m) => m.path)];
      const pick = await vscode.window.showWarningMessage(
        `Create deployable bundle at ${destPath}?\n\nIncludes:\n${paths.join('\n')}\n\n` +
          (selected.length
            ? 'Bundled mount directories can be very large — the tar runs on the cluster and may take a while.'
            : 'No mounts selected — bundle contains the environment (.sif) and project code only.'),
        { modal: true },
        'Create bundle'
      );
      if (pick !== 'Create bundle') {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'HPC Sync: building bundle', cancellable: false },
        async (progress) => {
          progress.report({ message: 'tar running on the cluster…' });
          const members = paths.map((p) => shq(p.replace(/^\//, ''))).join(' ');
          const cut = destPath.lastIndexOf('/');
          const destDir = cut > 0 ? destPath.slice(0, cut) : '';
          await this.ssh.execChecked(
            `${destDir ? `mkdir -p ${shq(destDir)} && ` : ''}tar -cf ${shq(destPath)} -C / ${members}`,
            { onStderr: (c) => log.append(c), onStdout: (c) => log.append(c) }
          );
          const sz = await this.ssh.exec(`du -h ${shq(destPath)} | cut -f1`);
          const size = sz.stdout.trim();
          log.appendLine(`[project] bundle created: ${destPath} (${size})`);
          void vscode.window.showInformationMessage(
            `HPC Sync: bundle created — ${destPath} (${size}). Hand it over and extract with: tar -xf ${destPath.split('/').pop()} -C /desired/root`
          );
        }
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`HPC Sync: bundle failed — ${(e as Error).message}`);
    }
  }

  /**
   * Portability shim: plain files committed with the repo so mounts resolve
   * WITHOUT this extension, VS Code, or the cluster.
   *   hpcproject.py       — mount("name") with env > local override > canonical
   *   hpcproject.env.sh   — `source` to export HPC_MOUNT_* in any shell
   *   .hpcproject.local.json (gitignored) — per-machine path overrides
   */
  private async generateShim(): Promise<void> {
    const ws = getConfig().localProjectDir;
    if (!ws) {
      return;
    }
    const py = [
      '"""Resolve project data paths (mounts) without any tooling.',
      '',
      'Precedence: HPC_MOUNT_<NAME> env var > .hpcproject.local.json > .hpcproject.json',
      'Works on the cluster, on a laptop, inside or outside containers.',
      'Generated by the HPC Sync extension; safe to edit or vendor.',
      '"""',
      'import json',
      'import os',
      'import re',
      'from pathlib import Path',
      'from typing import Optional',
      '',
      '_ROOT = Path(__file__).resolve().parent',
      '',
      '',
      'def _load(fname):',
      '    p = _ROOT / fname',
      '    if p.exists():',
      '        try:',
      '            return {m["name"]: m["path"] for m in json.loads(p.read_text()).get("mounts", [])}',
      '        except Exception:',
      '            pass',
      '    return {}',
      '',
      '',
      'def mount(name: str) -> Path:',
      '    """Path of a named project mount (see .hpcproject.json)."""',
      '    env = "HPC_MOUNT_" + re.sub(r"[^A-Za-z0-9]", "_", name).upper()',
      '    if env in os.environ:',
      '        return Path(os.environ[env])',
      '    local = _load(".hpcproject.local.json")',
      '    if name in local:',
      '        return Path(local[name])',
      '    canonical = _load(".hpcproject.json")',
      '    if name in canonical:',
      '        return Path(canonical[name])',
      '    raise KeyError(',
      '        f"unknown mount {name!r} — define it in .hpcproject.json, override it in "',
      '        f".hpcproject.local.json, or set {env}"',
      '    )',
      '',
      '',
      'def output_dir() -> Path:',
      '    d = Path(os.environ.get("OUTPUT_DIR", str(_ROOT / "output")))',
      '    d.mkdir(parents=True, exist_ok=True)',
      '    return d',
      '',
      '',
      'def input_dir() -> Optional[Path]:',
      '    v = os.environ.get("INPUT_DIR")',
      '    return Path(v) if v else None',
      '',
    ].join('\n');

    const sh = [
      '#!/usr/bin/env bash',
      '# source this file to export HPC_MOUNT_* for the project mounts —',
      '# works in any shell on any machine, no extension or VS Code needed.',
      '# .hpcproject.local.json (gitignored) overrides .hpcproject.json per machine.',
      '_hpcproj_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      '_hpcproj_emit() {',
      "python3 - \"$1\" <<'PYEOF'",
      'import json, re, sys',
      'try:',
      '    for m in json.load(open(sys.argv[1])).get("mounts", []):',
      '        env = "HPC_MOUNT_" + re.sub(r"[^A-Za-z0-9]", "_", m["name"]).upper()',
      '        print("export {}=\\"{}\\"".format(env, m["path"]))',
      'except (FileNotFoundError, ValueError):',
      '    pass',
      'PYEOF',
      '}',
      'eval "$(_hpcproj_emit "$_hpcproj_root/.hpcproject.json")"',
      'eval "$(_hpcproj_emit "$_hpcproj_root/.hpcproject.local.json")"',
      'unset -f _hpcproj_emit',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(ws, 'hpcproject.py'), py);
    fs.writeFileSync(path.join(ws, 'hpcproject.env.sh'), sh);
    // keep per-machine overrides out of version control
    const gi = path.join(ws, '.gitignore');
    const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!giText.includes('.hpcproject.local.json')) {
      fs.writeFileSync(gi, giText.replace(/\n*$/, '\n') + '.hpcproject.local.json\n');
    }
    log.appendLine('[project] portability shim written: hpcproject.py, hpcproject.env.sh');
    void vscode.window.showInformationMessage(
      'HPC Sync: portability shim written (hpcproject.py, hpcproject.env.sh). ' +
        'Code can now use `from hpcproject import mount` anywhere — cluster, laptop, or an extracted bundle ' +
        '(point .hpcproject.local.json at the local data).'
    );
  }

  private async scaffold(templateName: string, overwrite: boolean): Promise<void> {
    const cfg = getConfig();
    const t = this.templates().find((x) => x.name === templateName);
    if (!t || !cfg.localProjectDir) {
      return;
    }
    const targets: Array<{ p: string; content: string }> = [
      { p: path.join(cfg.localProjectDir, '.devcontainer', 'Dockerfile'), content: t.dockerfile },
      { p: path.join(cfg.localProjectDir, '.devcontainer', 'devcontainer.json'), content: t.devcontainer },
      { p: path.join(cfg.localProjectDir, 'requirements.txt'), content: t.requirements },
    ];
    const existing = targets.filter((x) => fs.existsSync(x.p));
    if (existing.length && !overwrite) {
      const pick = await vscode.window.showWarningMessage(
        `These files already exist:\n${existing.map((x) => path.relative(cfg.localProjectDir, x.p)).join('\n')}\n\nOverwrite them with template '${t.name}'?`,
        { modal: true },
        'Overwrite'
      );
      if (pick !== 'Overwrite') {
        return;
      }
    }
    fs.mkdirSync(path.join(cfg.localProjectDir, '.devcontainer'), { recursive: true });
    for (const x of targets) {
      fs.writeFileSync(x.p, x.content.replace(/\r\n/g, '\n'));
    }
    // carry existing mounts into the fresh Dockerfile as baked ENV defaults
    syncDockerfileMountEnv(path.join(cfg.localProjectDir, '.devcontainer', 'Dockerfile'), loadProjectConfig().mounts);
    log.appendLine(`[project] scaffolded dev container from template '${t.name}'`);
    void vscode.window.showInformationMessage(
      `HPC Sync: project scaffolded from '${t.name}'. Reopen in the dev container (Rebuild Container) to build it, then export the .sif.`
    );
    void maybeRebuildContainer('The dev container config was scaffolded');
    await this.sendState();
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private async sendState(): Promise<void> {
    const cfg = getConfig();
    const dcJson = path.join(cfg.localProjectDir, '.devcontainer', 'devcontainer.json');
    const status = {
      hasDevcontainer: fs.existsSync(dcJson),
      hasDockerfile: fs.existsSync(cfg.dockerfilePath),
      hasRequirements: fs.existsSync(cfg.requirementsPath),
      sifOnCluster: undefined as boolean | undefined,
      remoteDirExists: undefined as boolean | undefined,
      connected: this.ssh.status === 'connected',
    };
    let discovered: string[] = [];
    if (this.ssh.status === 'connected') {
      try {
        const sifPath = `${await this.ssh.expandRemotePath(cfg.remoteSifDir)}/${cfg.sifName}`;
        status.sifOnCluster = (await this.ssh.exec(`test -f ${shq(sifPath)}`)).code === 0;
        const remoteBase = await this.ssh.expandRemotePath(cfg.remoteProjectDir);
        status.remoteDirExists = (await this.ssh.exec(`test -d ${shq(remoteBase)}`)).code === 0;
        const disc = await this.ssh.exec(
          `for d in ~/projects/*/ ~/project/ /project/${cfg.allocGroup}/${cfg.user}/*/ "$SCRATCH"/*/; do [ -d "$d" ] && echo "$d"; done 2>/dev/null | sort -u`
        );
        if (disc.code === 0) {
          discovered = disc.stdout
            .split('\n')
            .map((l) => l.trim().replace(/\/+$/, ''))
            .filter(Boolean)
            .slice(0, 60);
        }
      } catch {
        /* status stays undefined */
      }
    }
    this.post({
      type: 'state',
      projectName: path.basename(cfg.localProjectDir || 'project'),
      status,
      templates: this.templates().map((t) => ({ name: t.name, builtin: !!t.builtin })),
      mounts: loadProjectConfig().mounts,
      discovered,
      sifName: cfg.sifName,
      remoteProjectDir: cfg.remoteProjectDir,
      bundleDefaultDest: `/project/${cfg.allocGroup}/${cfg.user}/bundles/${path
        .basename(cfg.localProjectDir || 'project')
        .replace(/[^\w.-]/g, '_')}_bundle.tar`,
    });
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
  h2 { margin: 0 0 4px; font-size: 1.2em; }
  h3 { margin: 20px 0 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .check { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; font-size: 0.95em; }
  .ok { color: #2ea043; }
  .bad { color: #f85149; }
  .unk { color: var(--vscode-descriptionForeground); }
  .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); border-radius: 6px; padding: 10px 14px; margin: 8px 0; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
  input[type=text], select, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 7px; font-family: inherit; font-size: inherit; }
  textarea { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; width: 100%; box-sizing: border-box; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 5px 14px; cursor: pointer; font-family: inherit; font-size: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.small { padding: 2px 9px; font-size: 0.86em; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
  td, th { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.1)); text-align: left; overflow-wrap: anywhere; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  .pill { font-size: 0.76em; border-radius: 8px; padding: 0 7px; background: rgba(139,148,158,0.18); color: var(--vscode-descriptionForeground); }
  .banner { border-left: 3px solid #d29922; background: rgba(210,153,34,0.08); padding: 8px 12px; border-radius: 4px; margin: 8px 0; font-size: 0.92em; }
  .expl { display: grid; grid-template-columns: 260px 1fr; gap: 14px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); border-radius: 6px; padding: 10px; min-height: 220px; }
  .explLeft { border-right: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15)); padding-right: 10px; overflow-y: auto; max-height: 380px; }
  .explRight { min-width: 0; overflow-y: auto; max-height: 380px; }
  .rootitem { padding: 4px 7px; border-radius: 4px; cursor: pointer; font-size: 0.88em; overflow-wrap: anywhere; }
  .rootitem:hover { background: rgba(128,128,128,0.12); }
  .rootitem.sel { background: rgba(88,166,255,0.16); }
  .rootitem .pill { margin-right: 4px; }
  .hidden { display: none !important; }
  .checkline { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; padding: 2px 0; }
</style>
</head>
<body>
  <h2 id="title">Project Manager</h2>
  <div class="meta">set up, export, and wire this project into the cluster</div>

  <h3>Status</h3>
  <div class="card" id="statusCard">loading…</div>
  <div class="banner hidden" id="setupBanner">
    No dev container config here and no .sif on the cluster — this project is not set up yet.
    Pick a template below to scaffold <b>.devcontainer/Dockerfile</b>, <b>devcontainer.json</b> and <b>requirements.txt</b>.
  </div>

  <h3>Setup from template</h3>
  <div class="banner hidden" id="setupGuard" style="border-left-color:#8b949e;background:rgba(139,148,158,0.08)">
    This project already has dev-container config — scaffolding is hidden to protect it.
    <a id="lnkShowSetup">show anyway</a>
  </div>
  <div id="setupControls" class="row">
    <select id="tplSelect"></select>
    <button id="btnScaffold">Scaffold project</button>
    <button class="small secondary" id="btnEditTpl">Edit</button>
    <button class="small secondary" id="btnDeleteTpl">Delete</button>
    <button class="small secondary" id="btnFromProject" title="Capture this project's current Dockerfile/devcontainer/requirements as a new template">Save current project as template…</button>
  </div>
  <div id="tplEditor" class="card hidden">
    <div class="row"><input type="text" id="tplName" placeholder="template name" style="flex:1"></div>
    <div class="meta">Dockerfile</div>
    <textarea id="tplDocker" rows="8" spellcheck="false"></textarea>
    <div class="meta" style="margin-top:6px">.devcontainer/devcontainer.json</div>
    <textarea id="tplDevc" rows="6" spellcheck="false"></textarea>
    <div class="meta" style="margin-top:6px">requirements.txt</div>
    <textarea id="tplReq" rows="4" spellcheck="false"></textarea>
    <div class="row"><button id="btnSaveTpl">Save template</button><button class="secondary" id="btnCancelTpl">Cancel</button></div>
  </div>

  <h3>Export environment</h3>
  <div class="card">
    <div class="meta">Builds the Docker image tar locally and converts it to <span id="sifName">.sif</span> on the cluster (slow path). Requires the docker CLI where the extension runs. Project mounts are <b>not</b> baked in — they stay bind-mounted at run time.</div>
    <div class="row"><button id="btnExport">Build &amp; upload .sif</button><button class="secondary" id="btnBundleToggle">Export deployable bundle…</button></div>
    <div id="bundleForm" class="hidden" style="margin-top:8px">
      <div class="meta">One tar on the cluster with <b>everything baked in</b> — the .sif, the project code, and any mounts you tick — ready to hand to someone else (extract with <code>tar -xf bundle.tar -C /</code>).</div>
      <div id="bundleMounts" class="row"></div>
      <div class="row"><input type="text" id="bundleDest" style="flex:1;min-width:260px"><button class="small" id="btnBundleGo">Create bundle</button></div>
    </div>
  </div>

  <h3>Project mounts (shared directories this project uses)</h3>
  <div class="meta" style="margin-bottom:6px">
    Mounts are named cluster directories — a datasets project, a shared cache — stored in <b>.hpcproject.json</b>
    (versionable, standard paths for the whole team). They appear as storages in the Launch panel's pipeline and are
    bind-mounted into jobs that use them.
  </div>
  <table id="mountTable"></table>

  <h3>Cluster explorer</h3>
  <div class="meta" style="margin-bottom:6px">Select a directory on the left to preview its files; drill into subfolders on the right, then “use as mount path”.</div>
  <div class="expl">
    <div class="explLeft" id="explRoots"><div class="meta">connect to discover directories…</div></div>
    <div class="explRight">
      <div class="row" style="justify-content:space-between;margin:0 0 4px">
        <b id="brPath" class="meta" style="overflow-wrap:anywhere">no directory selected</b>
        <span style="white-space:nowrap"><a id="brUse" title="fill the mount-path field with this directory">use as mount path</a> · <a id="brUp">⬆ up</a></span>
      </div>
      <div id="brError" class="bad hidden"></div>
      <div id="brNote" class="meta hidden"></div>
      <table id="brTable"></table>
    </div>
  </div>

  <div class="row">
    <input type="text" id="mName" placeholder="name (e.g. datasets)" style="width:130px">
    <input type="text" id="mCustom" placeholder="mount path (fill via explorer or type)" style="flex:1; min-width:220px">
    <input type="text" id="mPurpose" placeholder="purpose (optional)" style="width:150px">
    <button class="small" id="btnAddMount">Add mount</button>
  </div>
  <div class="row"><button class="small secondary" id="btnVerify">Verify mounts on cluster</button><button class="small secondary" id="btnShim" title="write hpcproject.py + hpcproject.env.sh so mounts resolve without this tool, VS Code, or the cluster">Generate portability shim</button><a id="lnkRefresh">refresh</a></div>
  <div id="mountCheck"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let state = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }

  window.addEventListener('message', function (e) {
    const m = e.data;
    if (m.type === 'state') { state = m; render(); }
    else if (m.type === 'editTemplate') {
      el('tplEditor').classList.remove('hidden');
      el('tplName').value = m.name;
      el('tplDocker').value = m.dockerfile;
      el('tplDevc').value = m.devcontainer;
      el('tplReq').value = m.requirements;
    } else if (m.type === 'mountCheck') {
      el('mountCheck').innerHTML = m.results.map(function (r) {
        return '<div class="checkline ' + (r.indexOf('✓') === 0 ? 'ok' : 'bad') + '">' + esc(r) + '</div>';
      }).join('');
    } else if (m.type === 'dir') {
      renderDir(m);
    }
  });

  let brCurrent = '';
  function browse(p) {
    brCurrent = p;
    el('brPath').textContent = p;
    el('brError').classList.add('hidden');
    el('brNote').classList.add('hidden');
    el('brTable').innerHTML = '<tr><td class="meta">loading…</td></tr>';
    vscode.postMessage({ command: 'browse', path: p });
    // highlight the matching root, if any
    document.querySelectorAll('.rootitem').forEach(function (r) {
      r.classList.toggle('sel', r.getAttribute('data-root') === p);
    });
  }

  function fmtSize(n) {
    if (n >= 1073741824) { return (n / 1073741824).toFixed(1) + ' GB'; }
    if (n >= 1048576) { return (n / 1048576).toFixed(1) + ' MB'; }
    if (n >= 1024) { return (n / 1024).toFixed(1) + ' KB'; }
    return n + ' B';
  }

  function renderDir(m) {
    if (m.path !== brCurrent) { return; }
    el('brPath').textContent = m.path;
    if (m.error) {
      el('brError').textContent = m.error;
      el('brError').classList.remove('hidden');
      el('brTable').innerHTML = '';
      return;
    }
    if (m.truncated) {
      el('brNote').textContent = 'large directory — showing the first ' + m.entries.length + ' entries';
      el('brNote').classList.remove('hidden');
    }
    let html = '';
    if (!m.entries.length) { html = '<tr><td class="meta">(empty directory)</td></tr>'; }
    for (const e of m.entries) {
      html += '<tr><td>' + (e.isDir ? '📁 <a data-cd="' + esc(e.name) + '">' + esc(e.name) + '</a>' : '📄 ' + esc(e.name)) + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' + (e.isDir ? '' : fmtSize(e.size)) + '</td></tr>';
    }
    el('brTable').innerHTML = html;
    document.querySelectorAll('[data-cd]').forEach(function (a) {
      a.onclick = function () { browse(brCurrent.replace(/\\/+$/, '') + '/' + a.getAttribute('data-cd')); };
    });
  }

  el('brUp').onclick = function () {
    const parts = brCurrent.replace(/\\/+$/, '').split('/');
    if (parts.length > 2) { parts.pop(); browse(parts.join('/') || '/'); }
  };
  el('brUse').onclick = function () {
    if (brCurrent) {
      el('mCustom').value = brCurrent;
      if (!el('mName').value) { el('mName').value = brCurrent.split('/').filter(Boolean).pop() || ''; }
      el('mCustom').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  function checkRow(ok, label) {
    const cls = ok === true ? 'ok' : ok === false ? 'bad' : 'unk';
    const icon = ok === true ? '✓' : ok === false ? '✗' : '?';
    return '<div class="check"><span class="' + cls + '">' + icon + '</span><span>' + esc(label) + '</span></div>';
  }

  function render() {
    el('title').textContent = 'Project Manager — ' + state.projectName;
    const s = state.status;
    el('statusCard').innerHTML =
      checkRow(s.hasDevcontainer, '.devcontainer/devcontainer.json') +
      checkRow(s.hasDockerfile, 'Dockerfile') +
      checkRow(s.hasRequirements, 'requirements.txt') +
      checkRow(s.connected ? s.sifOnCluster : undefined, state.sifName + ' on the cluster' + (s.connected ? '' : ' (connect to check)')) +
      checkRow(s.connected ? s.remoteDirExists : undefined, 'remote project dir ' + state.remoteProjectDir + (s.connected ? '' : ' (connect to check)'));

    const notSetUp = !s.hasDevcontainer && !s.hasDockerfile && s.sifOnCluster === false;
    el('setupBanner').classList.toggle('hidden', !notSetUp);

    // Guard: hide scaffolding when the project already has config — overwriting
    // a working setup by accident is the dangerous path.
    const alreadySetUp = s.hasDevcontainer || s.hasDockerfile;
    if (alreadySetUp && !setupRevealed) {
      el('setupGuard').classList.remove('hidden');
      el('setupControls').classList.add('hidden');
    } else {
      el('setupGuard').classList.add('hidden');
      el('setupControls').classList.remove('hidden');
    }

    const sel = el('tplSelect');
    sel.innerHTML = '';
    for (const t of state.templates) {
      const o = document.createElement('option');
      o.value = t.name;
      o.textContent = t.name + (t.builtin ? ' (built-in)' : '');
      sel.appendChild(o);
    }
    el('sifName').textContent = state.sifName;

    let mt = '<tr><th>name</th><th>path</th><th>purpose</th><th></th></tr>';
    if (!state.mounts.length) {
      mt += '<tr><td colspan="4" class="meta">no mounts yet — add the directories your jobs read from or write to</td></tr>';
    }
    for (const m of state.mounts) {
      mt += '<tr><td><span class="pill">📁</span> ' + esc(m.name) + '</td>' +
        '<td><a data-browse="' + esc(m.path) + '" title="browse files">' + esc(m.path) + '</a></td>' +
        '<td>' + esc(m.purpose || '') + '</td>' +
        '<td><a data-browse="' + esc(m.path) + '">browse</a> · <a data-rm="' + esc(m.name) + '">remove</a></td></tr>';
    }
    el('mountTable').innerHTML = mt;
    document.querySelectorAll('[data-rm]').forEach(function (a) {
      a.onclick = function () { vscode.postMessage({ command: 'removeMount', name: a.getAttribute('data-rm') }); };
    });
    document.querySelectorAll('[data-browse]').forEach(function (a) {
      a.onclick = function () { browse(a.getAttribute('data-browse')); };
    });

    // bundle form: mount checkboxes + default destination
    let bm = '<span class="meta">include mounts:</span>';
    if (!state.mounts.length) { bm = '<span class="meta">no mounts defined — bundle will contain the .sif and project code only</span>'; }
    for (const m of state.mounts) {
      bm += '<label><input type="checkbox" class="bMount" value="' + esc(m.name) + '"> ' + esc(m.name) + '</label>';
    }
    el('bundleMounts').innerHTML = bm;
    if (!el('bundleDest').value) { el('bundleDest').value = state.bundleDefaultDest || ''; }

    // left explorer column: discovered roots + defined mounts
    const roots = [];
    const seen = {};
    for (const m2 of state.mounts) {
      if (!seen[m2.path]) { seen[m2.path] = 1; roots.push({ path: m2.path, label: '📁 ' + m2.name, mount: true }); }
    }
    for (const d of state.discovered) {
      if (!seen[d]) { seen[d] = 1; roots.push({ path: d, label: d, mount: false }); }
    }
    const er = el('explRoots');
    er.innerHTML = roots.length
      ? ''
      : '<div class="meta">' + (state.status.connected ? 'no directories discovered' : 'connect to discover directories') + '</div>';
    for (const r of roots) {
      const d = document.createElement('div');
      d.className = 'rootitem' + (r.path === brCurrent ? ' sel' : '');
      d.setAttribute('data-root', r.path);
      d.title = r.path;
      d.textContent = r.label;
      d.onclick = function () { browse(r.path); };
      er.appendChild(d);
    }
  }

  el('btnScaffold').onclick = function () { vscode.postMessage({ command: 'scaffold', name: el('tplSelect').value }); };
  el('btnEditTpl').onclick = function () { vscode.postMessage({ command: 'editTemplate', name: el('tplSelect').value }); };
  el('btnDeleteTpl').onclick = function () { vscode.postMessage({ command: 'deleteTemplate', name: el('tplSelect').value }); };
  el('btnFromProject').onclick = function () { vscode.postMessage({ command: 'templateFromProject' }); };
  el('btnSaveTpl').onclick = function () {
    vscode.postMessage({
      command: 'saveTemplate',
      name: el('tplName').value,
      dockerfile: el('tplDocker').value,
      devcontainer: el('tplDevc').value,
      requirements: el('tplReq').value
    });
    el('tplEditor').classList.add('hidden');
  };
  el('btnCancelTpl').onclick = function () { el('tplEditor').classList.add('hidden'); };
  el('btnExport').onclick = function () { vscode.postMessage({ command: 'export' }); };
  el('btnBundleToggle').onclick = function () { el('bundleForm').classList.toggle('hidden'); };
  el('btnBundleGo').onclick = function () {
    const mounts = Array.from(document.querySelectorAll('.bMount:checked')).map(function (c) { return c.value; });
    vscode.postMessage({ command: 'bundle', mounts: mounts, dest: el('bundleDest').value.trim() });
  };
  let setupRevealed = false;
  el('lnkShowSetup').onclick = function () {
    setupRevealed = true;
    el('setupGuard').classList.add('hidden');
    el('setupControls').classList.remove('hidden');
  };
  el('btnAddMount').onclick = function () {
    const p = el('mCustom').value.trim() || brCurrent;
    if (!p) { return; }
    vscode.postMessage({ command: 'addMount', name: el('mName').value || p.split('/').filter(Boolean).pop(), path: p, purpose: el('mPurpose').value });
    el('mName').value = ''; el('mCustom').value = ''; el('mPurpose').value = '';
  };
  el('btnVerify').onclick = function () { el('mountCheck').innerHTML = '<div class="meta">checking…</div>'; vscode.postMessage({ command: 'verifyMounts' }); };
  el('btnShim').onclick = function () { vscode.postMessage({ command: 'shim' }); };
  el('lnkRefresh').onclick = function () { vscode.postMessage({ command: 'refresh' }); };

  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
