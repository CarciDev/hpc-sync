import * as vscode from 'vscode';
import { ClientChannel } from 'ssh2';
import { shq } from './config';
import { SshManager } from './sshManager';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Live console for a Slurm job: streams `tail -F` of the job's stdout file
 * over the shared SSH session while the job is active, and shows the full
 * tail after completion. One panel per job id.
 */
export class JobOutputPanel {
  private static readonly panels = new Map<string, JobOutputPanel>();

  static show(
    jobId: string,
    ssh: SshManager,
    resolvePath: (id: string) => Promise<string | undefined>,
    isActive: (id: string) => boolean
  ): void {
    const existing = JobOutputPanel.panels.get(jobId);
    if (existing) {
      existing.panel.reveal(undefined, true);
      return;
    }
    JobOutputPanel.panels.set(jobId, new JobOutputPanel(jobId, ssh, resolvePath, isActive));
  }

  private readonly panel: vscode.WebviewPanel;
  private channel?: ClientChannel;
  private outPath?: string;
  private following = false;

  private constructor(
    private readonly jobId: string,
    private readonly ssh: SshManager,
    private readonly resolvePath: (id: string) => Promise<string | undefined>,
    private readonly isActive: (id: string) => boolean
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'hpcSyncJobOut',
      `Job ${jobId} — console`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      this.stopStream();
      JobOutputPanel.panels.delete(this.jobId);
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg: { command: string; on?: boolean }) => {
      switch (msg.command) {
        case 'ready':
          void this.begin();
          break;
        case 'refresh':
          void this.loadStatic();
          break;
        case 'follow':
          if (msg.on) {
            this.startFollow();
          } else {
            void this.loadStatic();
          }
          break;
        case 'openEditor':
          void this.openInEditor();
          break;
      }
    });
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private async begin(): Promise<void> {
    try {
      this.outPath = await this.resolvePath(this.jobId);
    } catch {
      this.outPath = undefined;
    }
    const active = this.isActive(this.jobId);
    this.post({ type: 'meta', jobId: this.jobId, path: this.outPath ?? '(unknown)', active });
    if (!this.outPath) {
      this.post({
        type: 'set',
        text:
          'Could not locate the output file for this job.\n' +
          'The path is recorded for jobs submitted through the extension; for others it is read from ' +
          'scontrol/sacct, which may have already expired.',
      });
      return;
    }
    if (active) {
      this.startFollow();
    } else {
      await this.loadStatic();
    }
  }

  private startFollow(): void {
    if (!this.outPath) {
      return;
    }
    this.stopStream();
    this.following = true;
    this.post({ type: 'follow', on: true });
    this.post({ type: 'set', text: '' });
    // -F keeps retrying until the file appears (pending jobs have no file yet).
    void this.ssh
      .execStream(`tail -n 1000 -F ${shq(this.outPath)} 2>/dev/null`)
      .then((ch) => {
        this.channel = ch;
        ch.on('data', (d: Buffer) => this.post({ type: 'append', text: d.toString().replace(ANSI, '') }));
        ch.stderr.on('data', (d: Buffer) =>
          this.post({ type: 'append', text: d.toString().replace(ANSI, '') })
        );
        ch.on('close', () => {
          if (this.following) {
            this.post({ type: 'append', text: '\n── stream closed ──\n' });
            this.post({ type: 'follow', on: false });
            this.following = false;
          }
        });
      })
      .catch((e: Error) => this.post({ type: 'set', text: `Failed to stream output: ${e.message}` }));
  }

  private async loadStatic(): Promise<void> {
    if (!this.outPath) {
      return;
    }
    this.stopStream();
    this.post({ type: 'follow', on: false });
    try {
      const r = await this.ssh.exec(`tail -n 3000 ${shq(this.outPath)} 2>&1`);
      this.post({
        type: 'set',
        text: r.code === 0 ? r.stdout.replace(ANSI, '') || '(output file is empty)' : r.stdout + r.stderr,
      });
      this.post({ type: 'meta', jobId: this.jobId, path: this.outPath, active: this.isActive(this.jobId) });
    } catch (e) {
      this.post({ type: 'set', text: `Failed to read output: ${(e as Error).message}` });
    }
  }

  private async openInEditor(): Promise<void> {
    if (!this.outPath) {
      return;
    }
    try {
      const r = await this.ssh.exec(`tail -n 10000 ${shq(this.outPath)} 2>&1`);
      const doc = await vscode.workspace.openTextDocument({
        content: `# job ${this.jobId} — ${this.outPath} — ${new Date().toLocaleString()}\n\n${r.stdout.replace(ANSI, '')}`,
        language: 'log',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (e) {
      void vscode.window.showErrorMessage(`HPC Sync: ${(e as Error).message}`);
    }
  }

  private stopStream(): void {
    this.following = false;
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        /* already closed */
      }
      this.channel = undefined;
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
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); flex-shrink: 0; flex-wrap: wrap; }
  .chip { font-size: 0.8em; font-weight: 700; border-radius: 3px; padding: 1px 7px; }
  .chip.live { background: #2ea043; color: #fff; }
  .chip.done { background: #8b949e; color: #fff; }
  .path { color: var(--vscode-descriptionForeground); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 120px; }
  label { font-size: 0.85em; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; padding: 2px 10px; cursor: pointer; font-family: inherit; font-size: 0.88em; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #out { flex: 1; overflow: auto; margin: 0; padding: 10px 14px; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-editor-background); }
</style>
</head>
<body>
  <div class="bar">
    <span id="state" class="chip done">…</span>
    <span id="path" class="path"></span>
    <label><input type="checkbox" id="followCb"> follow (live)</label>
    <label title="scroll up to pause; scroll to the bottom to resume"><input type="checkbox" id="scrollCb" checked> autoscroll</label>
    <button id="btnRefresh">Refresh</button>
    <button id="btnEditor">Open in editor</button>
  </div>
  <pre id="out">loading…</pre>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const out = document.getElementById('out');
  const followCb = document.getElementById('followCb');
  const scrollCb = document.getElementById('scrollCb');
  const MAX = 1500000; // chars kept in the view (~deep scrollback)

  // Terminal-style stickiness: scrolling up pauses auto-scroll so you can
  // read; scrolling back to the bottom resumes following the tail.
  let stick = true;
  out.addEventListener('scroll', function () {
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 12;
    if (stick !== atBottom) {
      stick = atBottom;
      scrollCb.checked = atBottom;
    }
  });
  scrollCb.onchange = function () {
    stick = scrollCb.checked;
    if (stick) { out.scrollTop = out.scrollHeight; }
  };

  window.addEventListener('message', function (e) {
    const m = e.data;
    if (m.type === 'set') {
      out.textContent = m.text;
      stick = true;
      scrollCb.checked = true;
      scroll();
    } else if (m.type === 'append') {
      out.textContent += m.text;
      if (out.textContent.length > MAX) {
        out.textContent = out.textContent.slice(out.textContent.length - MAX);
      }
      scroll();
    } else if (m.type === 'follow') {
      followCb.checked = !!m.on;
    } else if (m.type === 'meta') {
      const st = document.getElementById('state');
      st.textContent = m.active ? 'LIVE' : 'FINISHED';
      st.className = 'chip ' + (m.active ? 'live' : 'done');
      document.getElementById('path').textContent = m.path;
      document.getElementById('path').title = m.path;
    }
  });

  function scroll() {
    if (stick) { out.scrollTop = out.scrollHeight; }
  }

  followCb.onchange = function () { vscode.postMessage({ command: 'follow', on: followCb.checked }); };
  document.getElementById('btnRefresh').onclick = function () { vscode.postMessage({ command: 'refresh' }); };
  document.getElementById('btnEditor').onclick = function () { vscode.postMessage({ command: 'openEditor' }); };
  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
