import * as vscode from 'vscode';
import { getConfig } from './config';
import { JobsMonitor } from './jobsMonitor';
import { SshManager } from './sshManager';

/**
 * Slurm jobs dashboard, styled after slurm-web: color-coded state badges,
 * elapsed-vs-timelimit progress bars, pending reasons, per-job actions
 * (details / output / cancel) and a live auto-refresh indicator.
 */
export class JobsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'hpcSync.jobs';
  private view?: vscode.WebviewView;

  constructor(
    private readonly ssh: SshManager,
    private readonly monitor: JobsMonitor,
    private readonly memento: vscode.Memento
  ) {
    monitor.onDidUpdate(() => this.postState());
    ssh.onStatusChanged(() => this.postState());
  }

  private dismissedKey(): string {
    return `hpcSync.dismissedJobs.${getConfig().host}`;
  }

  private getDismissed(): Set<string> {
    return new Set(this.memento.get<string[]>(this.dismissedKey(), []));
  }

  private async dismiss(ids: string[]): Promise<void> {
    const merged = Array.from(new Set([...this.getDismissed(), ...ids])).slice(-500);
    await this.memento.update(this.dismissedKey(), merged);
    this.postState();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: { command: string; id?: string }) => {
      switch (msg.command) {
        case 'dismiss':
          if (msg.id) {
            void this.dismiss([msg.id]);
          }
          break;
        case 'clearRecent': {
          const dismissed = this.getDismissed();
          const visible = this.monitor
            .getSnapshot()
            .recent.filter((j) => !dismissed.has(j.id))
            .map((j) => j.id);
          void this.dismiss(visible);
          break;
        }
        case 'refresh':
          void vscode.commands.executeCommand('hpcSync.refreshJobs');
          break;
        case 'connect':
          void vscode.commands.executeCommand('hpcSync.connect');
          break;
        case 'details':
          void vscode.commands.executeCommand('hpcSync.jobDetails', msg.id);
          break;
        case 'output':
          void vscode.commands.executeCommand('hpcSync.jobOutput', msg.id);
          break;
        case 'cancelJob':
          void vscode.commands.executeCommand('hpcSync.cancelJob', msg.id);
          break;
        case 'atlas':
          void vscode.commands.executeCommand('hpcSync.projectAtlas', { jobId: msg.id });
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
    const snap = this.monitor.getSnapshot();
    const dismissed = this.getDismissed();
    void this.view.webview.postMessage({
      type: 'jobs',
      sshStatus: this.ssh.status,
      snapshot: { ...snap, recent: snap.recent.filter((j) => !dismissed.has(j.id)) },
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
  .summary { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
  .chip { border-radius: 10px; padding: 1px 9px; font-size: 0.9em; font-weight: 600; }
  .chip.running { background: rgba(46,160,67,0.18); color: #2ea043; }
  .chip.pending { background: rgba(210,153,34,0.18); color: #d29922; }
  .chip.other { background: rgba(139,148,158,0.18); color: #8b949e; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-left: auto; white-space: nowrap; }
  .job { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-left: 3px solid #8b949e; border-radius: 5px; padding: 7px 9px; margin-bottom: 7px; }
  .job.RUNNING { border-left-color: #2ea043; }
  .job.PENDING { border-left-color: #d29922; }
  .job.COMPLETING, .job.CONFIGURING { border-left-color: #58a6ff; }
  .head { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .badge { font-size: 0.78em; font-weight: 700; border-radius: 3px; padding: 1px 6px; flex-shrink: 0; letter-spacing: 0.03em; }
  .badge.RUNNING { background: #2ea043; color: #fff; }
  .badge.PENDING { background: #d29922; color: #fff; }
  .badge.COMPLETING, .badge.CONFIGURING { background: #58a6ff; color: #fff; }
  .badge.COMPLETED { background: #3fb950; color: #fff; }
  .badge.FAILED, .badge.NODE_FAIL, .badge.OUT_OF_MEMORY { background: #f85149; color: #fff; }
  .badge.TIMEOUT { background: #db6d28; color: #fff; }
  .badge.other { background: #8b949e; color: #fff; }
  .jname { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .jid { color: var(--vscode-descriptionForeground); font-size: 0.9em; flex-shrink: 0; }
  .info { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-top: 3px; overflow-wrap: anywhere; }
  .bar-track { background: var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); border-radius: 2px; margin-top: 5px; height: 4px; }
  .bar { height: 4px; background: #2ea043; border-radius: 2px; transition: width 1s linear; }
  .bar.pending { background: #d29922; }
  .row-actions { display: flex; gap: 5px; margin-top: 6px; }
  .row-actions button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; padding: 2px 8px; cursor: pointer; font-size: 0.86em; font-family: inherit; }
  .row-actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .row-actions button.danger:hover { background: #f85149; color: #fff; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 8px 2px; }
  .error { color: #f85149; font-size: 0.9em; margin: 6px 0; overflow-wrap: anywhere; }
  h4 { margin: 12px 0 6px; font-size: 0.95em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; }
  .recent { display: flex; align-items: baseline; gap: 7px; padding: 3px 2px; font-size: 0.92em; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.12)); min-width: 0; }
  .recent .jname { font-weight: 400; }
  .recent .end { color: var(--vscode-descriptionForeground); font-size: 0.88em; flex-shrink: 0; }
  .recent .ra { flex-shrink: 0; font-size: 0.86em; white-space: nowrap; color: var(--vscode-descriptionForeground); }
  .recent .dx:hover { color: #f85149; }
  .hclear { font-size: 0.85em; font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 6px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 4px 12px; cursor: pointer; font-family: inherit; font-size: inherit; }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
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

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'jobs') { data = e.data; render(); }
  });

  setInterval(function () {
    const el = document.getElementById('updated');
    if (el && data && data.snapshot.updatedAt) {
      el.textContent = agoText();
    }
  }, 1000);

  function agoText() {
    const s = Math.max(0, Math.round((Date.now() - data.snapshot.updatedAt) / 1000));
    return 'updated ' + s + 's ago · auto ' + data.snapshot.pollIntervalSec + 's';
  }

  function estStart(s, offMin) {
    if (!s || s === 'N/A' || s === '(null)' || s === 'NONE') { return null; }
    // squeue reports cluster-local wall time with no timezone — convert via
    // the cluster's UTC offset instead of parsing in the viewer's timezone.
    let t = null;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (m && typeof offMin === 'number') {
      t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offMin * 60000;
    } else {
      const d = new Date(s);
      if (isNaN(d.getTime())) { return null; }
      t = d.getTime();
    }
    const diff = t - Date.now();
    if (diff <= 60000) { return 'any moment'; }
    const mins = Math.round(diff / 60000);
    let rel;
    if (mins < 60) { rel = 'in ~' + mins + 'm'; }
    else if (mins < 60 * 48) { rel = 'in ~' + Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm'; }
    else { rel = 'in ~' + Math.round(mins / 1440) + 'd'; }
    return rel;
  }

  function compactNum(n) {
    if (n >= 1000000) { return (n / 1000000).toFixed(2) + 'M'; }
    if (n >= 10000) { return Math.round(n / 1000) + 'k'; }
    return String(n);
  }

  function badgeClass(state) {
    const known = ['RUNNING','PENDING','COMPLETING','CONFIGURING','COMPLETED','FAILED','NODE_FAIL','OUT_OF_MEMORY','TIMEOUT'];
    for (const k of known) { if (state.indexOf(k) === 0) { return k; } }
    return 'other';
  }

  function render() {
    const root = document.getElementById('root');
    if (!data) { return; }
    const snap = data.snapshot;

    if (data.sshStatus !== 'connected') {
      const msg = data.sshStatus === 'disconnected'
        ? 'Not connected to the cluster.'
        : 'Connecting… (' + esc(data.sshStatus) + ')';
      root.innerHTML = '<div class="empty">' + msg + '</div>' +
        (data.sshStatus === 'disconnected' ? '<button class="primary" id="btnConnect">Connect</button>' : '');
      const b = document.getElementById('btnConnect');
      if (b) { b.onclick = function () { vscode.postMessage({ command: 'connect' }); }; }
      return;
    }

    const running = snap.active.filter(function (j) { return j.state === 'RUNNING'; }).length;
    const pending = snap.active.filter(function (j) { return j.state === 'PENDING'; }).length;
    const other = snap.active.length - running - pending;

    let html = '<div class="summary">' +
      '<span class="chip running">' + running + ' running</span>' +
      '<span class="chip pending">' + pending + ' pending</span>' +
      (other > 0 ? '<span class="chip other">' + other + ' other</span>' : '') +
      '<span class="meta" id="updated">' + (snap.updatedAt ? agoText() : '') + '</span>' +
      '</div>';

    if (snap.error) {
      html += '<div class="error">' + esc(snap.error) + '</div>';
    }

    if (snap.active.length === 0) {
      html += '<div class="empty">No active jobs in the queue.</div>';
    }

    for (const j of snap.active) {
      const bc = badgeClass(j.state);
      const parts = (j.partition || '').split(',');
      const partShort = parts[0] + (parts.length > 1 ? ' +' + (parts.length - 1) : '');
      html += '<div class="job ' + bc + '" data-id="' + esc(j.id) + '">';
      html += '<div class="head"><span class="badge ' + bc + '">' + esc(j.state) + '</span>' +
        '<span class="jname" title="' + esc(j.name) + '">' + esc(j.name) + '</span>' +
        '<span class="jid">#' + esc(j.id) + '</span></div>';
      let info = esc(j.cpus) + ' cpu · ' + esc(j.nodes) + ' node' + (j.nodes === '1' ? '' : 's') +
        ' · <span title="' + esc(j.partition) + '">' + esc(partShort) + '</span>';
      if (j.state === 'RUNNING') {
        info += ' · ' + esc(j.elapsed) + ' / ' + esc(j.timeLimit) + (j.timeLeft ? ' (' + esc(j.timeLeft) + ' left)' : '');
        if (j.reason) { info += ' · ' + esc(j.reason); }
      } else if (j.state === 'PENDING') {
        info += ' · limit ' + esc(j.timeLimit);
      } else {
        info += ' · ' + esc(j.elapsed);
      }
      html += '<div class="info">' + info + '</div>';
      if (j.state === 'PENDING') {
        const bits = [];
        const est = estStart(j.startTime, snap.clusterUtcOffsetMin);
        if (est) { bits.push('<b>est. start ' + esc(est) + '</b>'); }
        else { bits.push('<span title="Slurm backfill has not planned this job yet — an estimate usually appears as it nears the front of the queue">est: awaiting scheduler</span>'); }
        if (j.queuePos != null) { bits.push('queue <b>#' + j.queuePos + '</b> of ' + j.queueTotal); }
        if (j.priority != null) { bits.push('priority ' + compactNum(j.priority)); }
        let reason = j.reason || '';
        if (reason.charAt(0) === '(') { reason = reason.slice(1); }
        if (reason.charAt(reason.length - 1) === ')') { reason = reason.slice(0, -1); }
        if (reason && reason !== 'Priority' && reason !== 'None') { bits.push(esc(reason)); }
        if (bits.length) { html += '<div class="info">' + bits.join(' · ') + '</div>'; }
        if (j.queuePos != null && j.queueTotal > 0) {
          // queue progression: front of the queue = full bar
          const pct = Math.max(2, Math.min(100, Math.round((1 - (j.queuePos - 1) / j.queueTotal) * 100)));
          html += '<div class="bar-track"><div class="bar pending" style="width:' + pct + '%"></div></div>';
        }
      }
      if (j.state === 'RUNNING' && j.elapsedSec >= 0 && j.limitSec > 0) {
        const pct = Math.max(1, Math.min(100, Math.round((j.elapsedSec / j.limitSec) * 100)));
        html += '<div class="bar-track"><div class="bar" style="width:' + pct + '%"></div></div>';
      }
      html += '<div class="row-actions">' +
        '<button data-act="details">Details</button>' +
        '<button data-act="output">Console</button>' +
        '<button data-act="atlas" title="Mount relations for this run (Project Atlas)">Relations</button>' +
        '<button data-act="cancelJob" class="danger">Cancel</button>' +
        '</div></div>';
    }

    if (snap.recent.length > 0) {
      html += '<h4>Recent (' + snap.recent.length + ') <a id="clearRecent" class="hclear">clear all</a></h4>';
      for (const j of snap.recent.slice(0, 30)) {
        const bc = badgeClass(j.state);
        html += '<div class="recent" data-id="' + esc(j.id) + '"><span class="badge ' + bc + '">' + esc(j.state) + '</span>' +
          '<span class="jname" title="' + esc(j.name) + '">' + esc(j.name) + '</span>' +
          '<span class="jid">#' + esc(j.id) + '</span>' +
          '<span class="end">' + esc(j.elapsed) + '</span>' +
          '<span class="ra"><a data-act="details">details</a> · <a data-act="output">console</a> · <a data-act="dismiss" class="dx" title="remove from list">✕</a></span></div>';
      }
    }

    html += '<div style="margin-top:10px"><a id="lnkRefresh">Refresh now</a></div>';
    root.innerHTML = html;

    root.querySelectorAll('.row-actions button').forEach(function (btn) {
      btn.onclick = function () {
        const id = btn.closest('.job').getAttribute('data-id');
        vscode.postMessage({ command: btn.getAttribute('data-act'), id: id });
      };
    });
    root.querySelectorAll('.recent a[data-act]').forEach(function (a) {
      a.onclick = function () {
        const id = a.closest('.recent').getAttribute('data-id');
        vscode.postMessage({ command: a.getAttribute('data-act'), id: id });
      };
    });
    const lnk = document.getElementById('lnkRefresh');
    if (lnk) { lnk.onclick = function () { vscode.postMessage({ command: 'refresh' }); }; }
    const clr = document.getElementById('clearRecent');
    if (clr) { clr.onclick = function () { vscode.postMessage({ command: 'clearRecent' }); }; }
  }
</script>
</body>
</html>`;
  }
}
