import * as vscode from 'vscode';
import { AtlasModel } from './atlasModel';
import { ClusterMonitor } from './clusterMonitor';
import { getConfig, shq } from './config';
import { log } from './log';
import { SshManager } from './sshManager';

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (n >= 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  }
  return `${(n / 1024).toFixed(0)} KB`;
}

/**
 * Sidebar inventory of every project on the cluster: manifest mounts, .sif
 * size, and which mounts are shared with which other projects. Read-only for
 * foreign projects except deleting a stale .sif.
 */
export class ProjectsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'hpcSync.projects';
  private view?: vscode.WebviewView;

  constructor(
    private readonly ssh: SshManager,
    private readonly atlas: AtlasModel,
    private readonly cluster: ClusterMonitor
  ) {
    ssh.onStatusChanged(() => this.postState());
    atlas.onDidUpdate(() => this.postState());
    cluster.onDidUpdate(() => this.postState());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: { command: string; name?: string; text?: string }) => {
      switch (msg.command) {
        case 'refresh':
          void vscode.commands.executeCommand('hpcSync.refreshProjects');
          break;
        case 'connect':
          void vscode.commands.executeCommand('hpcSync.connect');
          break;
        case 'atlas':
          void vscode.commands.executeCommand('hpcSync.projectAtlas');
          break;
        case 'sync':
          void vscode.commands.executeCommand('hpcSync.sync');
          break;
        case 'launch':
          void vscode.commands.executeCommand('hpcSync.launch');
          break;
        case 'bundle':
          void vscode.commands.executeCommand('hpcSync.projectManager');
          break;
        case 'copy':
          if (msg.text) {
            void vscode.env.clipboard.writeText(msg.text);
            void vscode.window.showInformationMessage(`HPC Sync: copied ${msg.text}`);
          }
          break;
        case 'deleteSif':
          if (msg.name) {
            void this.deleteSif(msg.name);
          }
          break;
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postState();
      }
    });
    this.postState();
  }

  private async deleteSif(projectName: string): Promise<void> {
    const safe = projectName.replace(/[^\w.-]/g, '_');
    const pick = await vscode.window.showWarningMessage(
      `Delete ${safe}.sif on the cluster? The project "${projectName}" will need a full rebuild before its jobs can run again.`,
      { modal: true },
      'Delete .sif'
    );
    if (pick !== 'Delete .sif') {
      return;
    }
    try {
      const sifDir = await this.ssh.expandRemotePath(getConfig().remoteSifDir);
      await this.ssh.execChecked(`rm -f ${shq(`${sifDir}/${safe}.sif`)}`);
      log.appendLine(`[atlas] deleted ${sifDir}/${safe}.sif`);
      await this.atlas.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`HPC Sync: ${(e as Error).message}`);
    }
  }

  postState(): void {
    if (!this.view) {
      return;
    }
    const snap = this.atlas.getSnapshot();
    const storage = this.cluster.getSnapshot().storage ?? [];
    void this.view.webview.postMessage({
      type: 'state',
      status: this.ssh.status,
      current: this.atlas.currentProjectName(),
      snapshot: snap
        ? {
            ...snap,
            projects: snap.projects.map((p) => ({
              ...p,
              sifSize: p.sifSizeBytes !== undefined ? fmtBytes(p.sifSizeBytes) : undefined,
            })),
          }
        : undefined,
      quota: storage.map((f) => `${f.label} ${f.used} / ${f.quota}`).join(' · '),
    });
  }

  html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 10px; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 4px 2px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.88em; }
  .topbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .topbar .meta { flex: 1; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 3px 9px; cursor: pointer; font-family: inherit; font-size: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.wide { width: 100%; margin-top: 8px; }
  details.proj { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); border-radius: 6px; margin-bottom: 6px; background: var(--vscode-editorWidget-background); }
  details.proj[open] { padding-bottom: 6px; }
  details.proj > summary { list-style: none; cursor: pointer; padding: 6px 9px; display: flex; align-items: baseline; gap: 7px; }
  details.proj > summary::-webkit-details-marker { display: none; }
  .pname { font-weight: 600; overflow-wrap: anywhere; }
  .pname .you { color: var(--vscode-textLink-foreground); font-weight: 400; font-size: 0.85em; }
  .psub { flex: 1; text-align: right; }
  .pbody { padding: 0 9px; }
  .mrow { padding: 3px 0; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.08)); font-size: 0.92em; }
  .mpath { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.86em; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  .shared { color: var(--vscode-charts-orange, #d29922); }
  .acts { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
  .warn { color: var(--vscode-charts-orange, #d29922); }
  .foot { margin-top: 8px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15)); padding-top: 6px; }
</style>
</head>
<body>
  <div id="root"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let data = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function post(m) { vscode.postMessage(m); }
  function agoText(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'state') { data = e.data; render(); }
  });

  function sharedWith(mountPath, self) {
    if (!data.snapshot) { return []; }
    const node = data.snapshot.mounts.find(function (n) { return n.path === mountPath; });
    return node ? node.projects.filter(function (p) { return p !== self; }) : [];
  }

  function render() {
    const root = document.getElementById('root');
    if (!data) { return; }
    if (data.status !== 'connected' && !data.snapshot) {
      root.innerHTML = '<div class="empty">Not connected to the cluster.</div>' +
        (data.status === 'disconnected' ? '<button id="btnConn">Connect</button>' : '');
      const b = document.getElementById('btnConn');
      if (b) { b.onclick = function () { post({ command: 'connect' }); }; }
      return;
    }
    const snap = data.snapshot;
    if (!snap || !snap.scannedAt) {
      root.innerHTML = '<div class="empty">No cluster scan yet.</div><button id="btnScan">Scan projects</button>';
      document.getElementById('btnScan').onclick = function () { post({ command: 'refresh' }); };
      return;
    }

    let html = '<div class="topbar"><span class="meta">' + esc(snap.projectsParent) + ' · scanned ' + agoText(snap.scannedAt) + '</span><a id="lnkRefresh">⟳</a></div>';
    if (snap.error) { html += '<div class="warn">' + esc(snap.error) + '</div>'; }

    for (const p of snap.projects) {
      const isCurrent = p.name === data.current;
      const shares = [];
      for (const m of p.mounts) {
        for (const o of sharedWith(m.path, p.name)) {
          if (shares.indexOf(o) < 0) { shares.push(o); }
        }
      }
      html += '<details class="proj"' + (isCurrent ? ' open' : '') + '>';
      html += '<summary><span class="pname">' + esc(p.name) + (isCurrent ? ' <span class="you">← this workspace</span>' : '') + '</span>';
      html += '<span class="psub meta">' + (p.sifSize ? '.sif ' + esc(p.sifSize) : 'no .sif') +
        (p.mounts.length ? ' · ' + p.mounts.length + ' mount' + (p.mounts.length > 1 ? 's' : '') : '') + '</span></summary>';
      html += '<div class="pbody">';
      if (!p.hasManifest) {
        html += '<div class="meta warn">no manifest — not synced by HPC Sync</div>';
      }
      for (const m of p.mounts) {
        const others = sharedWith(m.path, p.name);
        html += '<div class="mrow">📁 <b>' + esc(m.name) + '</b>' +
          (others.length ? ' <span class="shared">· shared with ' + esc(others.join(', ')) + '</span>' : '') +
          '<div class="mpath">' + esc(m.path) + (m.purpose ? ' · ' + esc(m.purpose) : '') + '</div></div>';
      }
      html += '<div class="acts">';
      if (isCurrent) {
        html += '<button data-act="sync">Sync</button><button class="secondary" data-act="launch">Launch</button><button class="secondary" data-act="bundle">Bundle…</button>';
      } else {
        html += '<a data-copy="' + esc(p.remoteDir) + '">copy path</a>' +
          (p.sifSize ? ' · <a data-del="' + esc(p.name) + '">delete .sif</a>' : '');
      }
      html += '</div></div></details>';
    }

    const sharedMounts = snap.mounts.filter(function (m) { return m.projects.length > 1; });
    html += '<div class="foot meta">' + snap.mounts.length + ' mount path(s)' +
      (sharedMounts.length ? ' · ' + sharedMounts.map(function (m) { return esc(m.names[0]) + ' ×' + m.projects.length; }).join(' · ') : '') + '</div>';
    if (data.quota) { html += '<div class="meta">' + esc(data.quota) + '</div>'; }
    html += '<button class="wide secondary" id="btnAtlas">Open Project Atlas ⤢</button>';

    root.innerHTML = html;
    const r = document.getElementById('lnkRefresh');
    if (r) { r.onclick = function () { post({ command: 'refresh' }); }; }
    document.getElementById('btnAtlas').onclick = function () { post({ command: 'atlas' }); };
    root.querySelectorAll('[data-act]').forEach(function (b) {
      b.onclick = function () { post({ command: b.getAttribute('data-act') }); };
    });
    root.querySelectorAll('[data-copy]').forEach(function (a) {
      a.onclick = function (ev) { ev.preventDefault(); post({ command: 'copy', text: a.getAttribute('data-copy') }); };
    });
    root.querySelectorAll('[data-del]').forEach(function (a) {
      a.onclick = function (ev) { ev.preventDefault(); post({ command: 'deleteSif', name: a.getAttribute('data-del') }); };
    });
  }
</script>
</body>
</html>`;
  }
}
