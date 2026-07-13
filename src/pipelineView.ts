import * as vscode from 'vscode';
import { getConfig } from './config';
import { SshManager } from './sshManager';
import { SyncEngine } from './syncEngine';

export class PipelineViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'hpcSync.pipeline';
  private view?: vscode.WebviewView;

  constructor(
    private readonly ssh: SshManager,
    private readonly engine: SyncEngine
  ) {
    ssh.onStatusChanged(() => this.postState());
    engine.onDidChange(() => this.postState());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: { command: string }) => {
      switch (msg.command) {
        case 'connect':
          void vscode.commands.executeCommand('hpcSync.connect');
          break;
        case 'disconnect':
          void vscode.commands.executeCommand('hpcSync.disconnect');
          break;
        case 'sync':
          void vscode.commands.executeCommand('hpcSync.sync');
          break;
        case 'forceRebuild':
          void vscode.commands.executeCommand('hpcSync.forceRebuild');
          break;
        case 'dryRun':
          void vscode.commands.executeCommand('hpcSync.dryRun');
          break;
        case 'run':
          void vscode.commands.executeCommand('hpcSync.run');
          break;
        case 'submitJob':
          void vscode.commands.executeCommand('hpcSync.submitJob');
          break;
        case 'cancelSync':
          void vscode.commands.executeCommand('hpcSync.cancelSync');
          break;
        case 'showLog':
          void vscode.commands.executeCommand('hpcSync.showLog');
          break;
        case 'openSettings':
          void vscode.commands.executeCommand('hpcSync.openSettings');
          break;
        case 'setup':
          void vscode.commands.executeCommand('hpcSync.setup');
          break;
        case 'project':
          void vscode.commands.executeCommand('hpcSync.projectManager');
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

  postState(): void {
    if (!this.view) {
      return;
    }
    const cfg = getConfig();
    void this.view.webview.postMessage({
      type: 'state',
      ssh: { status: this.ssh.status, target: `${cfg.user}@${cfg.host}` },
      sync: this.engine.getState(),
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
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 10px; }
  .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; }
  .conn { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .dot.disconnected { background: #8b949e; }
  .dot.connecting, .dot.authenticating { background: #d29922; animation: pulse 1s infinite; }
  .dot.connected { background: #2ea043; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .target { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.92em; margin-top: 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer; font-family: inherit; font-size: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.45; cursor: default; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
  .actions button.wide { grid-column: span 2; }
  .steps { list-style: none; padding: 0; margin: 0; }
  .step { display: flex; gap: 8px; padding: 5px 2px; align-items: flex-start; }
  .icon { width: 16px; text-align: center; flex-shrink: 0; line-height: 1.4; }
  .icon.done { color: #2ea043; }
  .icon.error { color: #f85149; }
  .icon.skipped { color: #8b949e; }
  .spinner { display: inline-block; width: 11px; height: 11px; border: 2px solid var(--vscode-progressBar-background, #0078d4); border-top-color: transparent; border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .step-body { flex: 1; min-width: 0; }
  .step-label { }
  .step.skipped .step-label { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
  .step-detail { color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow-wrap: anywhere; }
  .step.error .step-detail { color: #f85149; }
  .bar { height: 4px; background: var(--vscode-progressBar-background, #0078d4); border-radius: 2px; margin-top: 4px; transition: width 0.3s; }
  .bar-track { background: var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); border-radius: 2px; margin-top: 4px; }
  .bar-track .bar { margin-top: 0; }
  .title { font-weight: 600; margin: 4px 0 6px; }
  .footer { margin-top: 8px; display: flex; gap: 6px; }
  .links { margin-top: 10px; font-size: 0.92em; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 4px 2px; }
</style>
</head>
<body>
  <div class="card">
    <div class="conn">
      <span id="dot" class="dot disconnected"></span>
      <span id="target" class="target"></span>
      <button id="connBtn" class="secondary"></button>
    </div>
    <div class="hint" id="connHint"></div>
  </div>

  <div class="actions">
    <button id="btnSync" class="wide" title="Auto-detect fast/slow path (like ./hpc-sync.sh)">Sync</button>
    <button id="btnDry" class="secondary" title="Preview what would happen">Dry Run</button>
    <button id="btnRebuild" class="secondary" title="Force the slow path: docker save, upload, apptainer build">Force Rebuild</button>
    <button id="btnRun" class="secondary" title="Sync, then run a script inside the container">Run Script…</button>
    <button id="btnSubmit" class="secondary" title="Sync, then sbatch a Slurm script">Submit Job…</button>
  </div>

  <div class="card" id="progressCard">
    <div class="title" id="syncTitle">No sync yet</div>
    <ul class="steps" id="steps"><li class="empty">Press Sync to start. Steps and progress appear here.</li></ul>
    <div class="footer">
      <button id="btnCancel" class="secondary" style="display:none">Cancel</button>
    </div>
  </div>

  <div class="links"><a id="lnkProject">Project</a> · <a id="lnkSetup">Setup SSH</a> · <a id="lnkLog">Show full log</a> · <a id="lnkSettings">Settings</a></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let state = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function cmd(c) { vscode.postMessage({ command: c }); }

  document.getElementById('btnSync').onclick = function () { cmd('sync'); };
  document.getElementById('btnDry').onclick = function () { cmd('dryRun'); };
  document.getElementById('btnRebuild').onclick = function () { cmd('forceRebuild'); };
  document.getElementById('btnRun').onclick = function () { cmd('run'); };
  document.getElementById('btnSubmit').onclick = function () { cmd('submitJob'); };
  document.getElementById('btnCancel').onclick = function () { cmd('cancelSync'); };
  document.getElementById('lnkProject').onclick = function () { cmd('project'); };
  document.getElementById('lnkSetup').onclick = function () { cmd('setup'); };
  document.getElementById('lnkLog').onclick = function () { cmd('showLog'); };
  document.getElementById('lnkSettings').onclick = function () { cmd('openSettings'); };
  document.getElementById('connBtn').onclick = function () {
    if (state && state.ssh.status === 'disconnected') { cmd('connect'); } else { cmd('disconnect'); }
  };

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'state') { state = e.data; render(); }
  });

  function render() {
    if (!state) { return; }
    const ssh = state.ssh;
    const sync = state.sync;

    document.getElementById('dot').className = 'dot ' + ssh.status;
    document.getElementById('target').textContent = ssh.target;
    const connBtn = document.getElementById('connBtn');
    connBtn.textContent = ssh.status === 'disconnected' ? 'Connect' : 'Disconnect';
    const hints = {
      disconnected: 'Not connected. One connection is shared by all syncs and job polling — 2FA is asked only once.',
      connecting: 'Connecting…',
      authenticating: 'Authenticating — answer the prompt at the top of the window (2FA).',
      connected: 'Connected — session shared across all operations; no more 2FA prompts.'
    };
    document.getElementById('connHint').textContent = hints[ssh.status] || '';

    const busy = sync.active;
    ['btnSync', 'btnDry', 'btnRebuild', 'btnRun', 'btnSubmit'].forEach(function (id) {
      document.getElementById(id).disabled = busy;
    });
    document.getElementById('btnCancel').style.display = busy ? '' : 'none';

    const title = document.getElementById('syncTitle');
    if (sync.steps.length === 0) {
      title.textContent = 'No sync yet';
    } else {
      let t = sync.title;
      if (sync.active) { t += ' — running…'; }
      else if (sync.error) { t += ' — ' + (sync.error === 'Cancelled by user' ? 'cancelled' : 'failed'); }
      else if (sync.finishedAt && sync.startedAt) {
        t += ' — done in ' + Math.round((sync.finishedAt - sync.startedAt) / 1000) + 's';
      }
      title.textContent = t;
    }

    const ul = document.getElementById('steps');
    if (sync.steps.length === 0) {
      ul.innerHTML = '<li class="empty">Press Sync to start. Steps and progress appear here.</li>';
      return;
    }
    let html = '';
    for (const s of sync.steps) {
      let icon;
      if (s.status === 'running') { icon = '<span class="spinner"></span>'; }
      else if (s.status === 'done') { icon = '<span class="icon done">✓</span>'; }
      else if (s.status === 'error') { icon = '<span class="icon error">✗</span>'; }
      else if (s.status === 'skipped') { icon = '<span class="icon skipped">↷</span>'; }
      else { icon = '<span class="icon">○</span>'; }
      html += '<li class="step ' + s.status + '"><span class="icon">' + icon + '</span><div class="step-body">';
      html += '<div class="step-label">' + esc(s.label) + '</div>';
      if (s.detail) { html += '<div class="step-detail">' + esc(s.detail) + '</div>'; }
      if (typeof s.progress === 'number' && s.status === 'running') {
        const pct = Math.max(0, Math.min(100, Math.round(s.progress * 100)));
        html += '<div class="bar-track"><div class="bar" style="width:' + pct + '%"></div></div>';
      }
      html += '</div></li>';
    }
    ul.innerHTML = html;
  }
</script>
</body>
</html>`;
  }
}
