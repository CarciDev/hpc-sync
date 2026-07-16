import * as vscode from 'vscode';
import { getConfig } from './config';
import { agentSocket, discoverKeys } from './sshKeys';
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hpcSync')) {
        this.postState();
      }
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: { command: string; key?: string; value?: string }) => {
      switch (msg.command) {
        case 'setConfig':
          if (msg.key) {
            void vscode.workspace
              .getConfiguration('hpcSync')
              .update(msg.key, (msg.value ?? '').trim(), vscode.ConfigurationTarget.Global)
              .then(() => this.postState());
          }
          break;
        case 'connect':
          void vscode.commands.executeCommand('hpcSync.connect');
          break;
        case 'disconnect':
          void vscode.commands.executeCommand('hpcSync.disconnect');
          break;
        case 'sshKey':
          void vscode.commands.executeCommand('hpcSync.showPublicKey');
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
    const keys = discoverKeys(cfg);
    const agent = !!agentSocket();
    let keyLabel = 'no key or agent found';
    if (agent && keys.length) {
      keyLabel = `agent + ${keys[0].path}`;
    } else if (agent) {
      keyLabel = 'SSH agent available';
    } else if (keys.length) {
      keyLabel = keys[0].path;
    }
    void this.view.webview.postMessage({
      type: 'state',
      status: this.ssh.status,
      cfg: { host: cfg.host, user: cfg.user, allocGroup: cfg.allocGroup },
      key: { ready: agent || keys.length > 0, label: keyLabel },
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
  button:disabled { opacity: 0.45; cursor: default; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.wide { width: 100%; }
  input[type=text] { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 7px; font-family: inherit; font-size: inherit; }
  input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
  .actions button.wide2 { grid-column: span 2; }
  .steps { list-style: none; padding: 0; margin: 0; }
  .step { display: flex; gap: 8px; padding: 5px 2px; align-items: flex-start; }
  .icon { width: 16px; text-align: center; flex-shrink: 0; line-height: 1.4; }
  .icon.done { color: #2ea043; }
  .icon.error { color: #f85149; }
  .icon.skipped { color: #8b949e; }
  .spinner { display: inline-block; width: 11px; height: 11px; border: 2px solid var(--vscode-progressBar-background, #0078d4); border-top-color: transparent; border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .step-body { flex: 1; min-width: 0; }
  .step.skipped .step-label { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
  .step-detail { color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow-wrap: anywhere; }
  .step.error .step-detail { color: #f85149; }
  .bar { height: 4px; background: var(--vscode-progressBar-background, #0078d4); border-radius: 2px; margin-top: 4px; transition: width 0.3s; }
  .bar-track { background: var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); border-radius: 2px; margin-top: 4px; }
  .bar-track .bar { margin-top: 0; }
  .title { font-weight: 600; margin: 4px 0 6px; }
  .links { margin-top: 10px; font-size: 0.92em; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 4px 2px; }
  /* setup wizard */
  .wz { counter-reset: none; }
  .wzstep { display: flex; gap: 9px; padding: 8px 0; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.12)); }
  .wznum { flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; background: var(--vscode-editorWidget-border, rgba(128,128,128,0.3)); color: var(--vscode-foreground); font-size: 0.8em; display: flex; align-items: center; justify-content: center; font-weight: 700; }
  .wznum.done { background: #2ea043; color: #fff; }
  .wzbody { flex: 1; min-width: 0; }
  .wzlabel { font-size: 0.92em; font-weight: 600; margin-bottom: 3px; }
  .wzlabel .req { color: #f85149; font-weight: 400; font-size: 0.85em; }
  .wzhint { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 3px; overflow-wrap: anywhere; }
  .wzintro { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .hidden { display: none !important; }
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

  <!-- Setup wizard (shown until connected) -->
  <div class="card wz" id="wizard">
    <div class="title">Get started</div>
    <div class="wzintro">Fill these once. Host, username and account are saved to your <b>user</b> settings, so they apply to every project and sync across machines with VS Code Settings Sync.</div>

    <div class="wzstep">
      <span class="wznum" id="n1">1</span>
      <div class="wzbody">
        <div class="wzlabel">Cluster login node <span class="req">required</span></div>
        <input type="text" id="in-host" placeholder="e.g. narval.alliancecan.ca">
      </div>
    </div>

    <div class="wzstep">
      <span class="wznum" id="n2">2</span>
      <div class="wzbody">
        <div class="wzlabel">Your username on the cluster <span class="req">required</span></div>
        <input type="text" id="in-user" placeholder="your cluster login name">
      </div>
    </div>

    <div class="wzstep">
      <span class="wznum" id="n3">3</span>
      <div class="wzbody">
        <div class="wzlabel">Allocation / account</div>
        <input type="text" id="in-alloc" placeholder="e.g. def-yourpi (optional)">
        <div class="wzhint">Used for job submission and project-storage paths. Leave blank to use your cluster default.</div>
      </div>
    </div>

    <div class="wzstep">
      <span class="wznum" id="n4">4</span>
      <div class="wzbody">
        <div class="wzlabel">SSH key</div>
        <div class="wzhint" id="keyStatus"></div>
        <div style="margin-top:5px"><button class="secondary" id="btnKey">Show public key / register on cluster website</button></div>
      </div>
    </div>

    <div class="wzstep" style="border-bottom:none">
      <span class="wznum" id="n5">5</span>
      <div class="wzbody">
        <div class="wzlabel">Connect</div>
        <div style="margin-top:5px"><button id="btnConnect2" class="wide">Connect to cluster</button></div>
        <div class="wzhint">You will be asked for your password/2FA once; the session is then reused.</div>
      </div>
    </div>
  </div>

  <!-- Actions (shown once connected) -->
  <div class="actions hidden" id="actions">
    <button id="btnSync" class="wide2" title="Auto-detect fast/slow path">Sync</button>
    <button id="btnDry" class="secondary">Dry Run</button>
    <button id="btnRebuild" class="secondary" title="Force docker save + apptainer build">Force Rebuild</button>
    <button id="btnRun" class="secondary" title="Sync, then run a script in the container">Run Script…</button>
    <button id="btnSubmit" class="secondary" title="Sync, then submit a Slurm job">Submit Job…</button>
  </div>

  <div class="card" id="progressCard">
    <div class="title" id="syncTitle">No sync yet</div>
    <ul class="steps" id="steps"><li class="empty">Connect, then press Sync. Steps and progress appear here.</li></ul>
    <div style="margin-top:8px"><button id="btnCancel" class="secondary" style="display:none">Cancel</button></div>
  </div>

  <div class="links"><a id="lnkProject">Project</a> · <a id="lnkSetup">SSH setup…</a> · <a id="lnkLog">Log</a> · <a id="lnkSettings">All settings</a></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let state = null;
  let editing = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }
  function cmd(c) { vscode.postMessage({ command: c }); }
  function setCfg(key, value) { vscode.postMessage({ command: 'setConfig', key: key, value: value }); }

  // save on change/blur, and remember focus so live re-renders don't fight typing
  function wire(inputId, key) {
    const input = el(inputId);
    input.addEventListener('focus', function () { editing = true; });
    input.addEventListener('blur', function () { editing = false; setCfg(key, input.value); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { input.blur(); } });
  }
  wire('in-host', 'host');
  wire('in-user', 'user');
  wire('in-alloc', 'allocGroup');

  el('btnKey').onclick = function () { cmd('sshKey'); };
  el('btnConnect2').onclick = function () { cmd('connect'); };
  el('btnSync').onclick = function () { cmd('sync'); };
  el('btnDry').onclick = function () { cmd('dryRun'); };
  el('btnRebuild').onclick = function () { cmd('forceRebuild'); };
  el('btnRun').onclick = function () { cmd('run'); };
  el('btnSubmit').onclick = function () { cmd('submitJob'); };
  el('btnCancel').onclick = function () { cmd('cancelSync'); };
  el('lnkProject').onclick = function () { cmd('project'); };
  el('lnkSetup').onclick = function () { cmd('setup'); };
  el('lnkLog').onclick = function () { cmd('showLog'); };
  el('lnkSettings').onclick = function () { cmd('openSettings'); };
  el('connBtn').onclick = function () {
    if (state && state.status === 'disconnected') { cmd('connect'); } else { cmd('disconnect'); }
  };

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'state') { state = e.data; render(); }
  });

  function markStep(numId, ok) { el(numId).className = 'wznum' + (ok ? ' done' : ''); }

  function render() {
    if (!state) { return; }
    const c = state.cfg;

    el('dot').className = 'dot ' + state.status;
    el('target').textContent = (c.user || '?') + '@' + (c.host || 'not set');
    el('connBtn').textContent = state.status === 'disconnected' ? 'Connect' : 'Disconnect';
    const hints = {
      disconnected: 'Not connected. Fill the steps below, then Connect.',
      connecting: 'Connecting…',
      authenticating: 'Answer the password/2FA prompt at the top of the window.',
      connected: 'Connected — one shared session, no more 2FA prompts.'
    };
    el('connHint').textContent = hints[state.status] || '';

    // wizard field values (don't clobber while the user types)
    if (!editing) {
      el('in-host').value = c.host || '';
      el('in-user').value = c.user || '';
      el('in-alloc').value = c.allocGroup || '';
    }
    markStep('n1', !!c.host);
    markStep('n2', !!c.user);
    markStep('n3', !!c.allocGroup);
    markStep('n4', state.key.ready);
    markStep('n5', state.status === 'connected');
    el('keyStatus').textContent = state.key.ready
      ? 'Found: ' + state.key.label + '. If the cluster rejects it, register the public key on the cluster website (button below).'
      : 'No SSH key or agent detected. Click below to generate one, then register it on the cluster website.';
    el('btnConnect2').disabled = !(c.host && c.user) || state.status !== 'disconnected';

    const connected = state.status === 'connected';
    el('wizard').classList.toggle('hidden', connected);
    el('actions').classList.toggle('hidden', !connected);

    // sync progress
    const sync = state.sync;
    const busy = sync.active;
    ['btnSync', 'btnDry', 'btnRebuild', 'btnRun', 'btnSubmit'].forEach(function (id) { el(id).disabled = busy; });
    el('btnCancel').style.display = busy ? '' : 'none';

    const title = el('syncTitle');
    if (sync.steps.length === 0) {
      title.textContent = connected ? 'Ready — press Sync' : 'No sync yet';
    } else {
      let t = sync.title;
      if (sync.active) { t += ' — running…'; }
      else if (sync.error) { t += ' — ' + (sync.error === 'Cancelled by user' ? 'cancelled' : 'failed'); }
      else if (sync.finishedAt && sync.startedAt) { t += ' — done in ' + Math.round((sync.finishedAt - sync.startedAt) / 1000) + 's'; }
      title.textContent = t;
    }

    const ul = el('steps');
    if (sync.steps.length === 0) {
      ul.innerHTML = '<li class="empty">' + (connected ? 'Press Sync. Steps and progress appear here.' : 'Connect, then press Sync.') + '</li>';
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
