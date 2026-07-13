import * as vscode from 'vscode';
import { UsageAnalytics } from './analytics';
import { ClusterMonitor } from './clusterMonitor';
import { loadProjectConfig, mountEnvName } from './projectConfig';
import { SshManager } from './sshManager';
import { StorageBench } from './storageBench';

export interface ClusterLayout {
  /** Display order of all widgets (hidden ones keep a slot). */
  order: string[];
  hidden: string[];
}

const ALL_WIDGETS = [
  'insights',
  'fairshare',
  'compute',
  'pattern',
  'storage',
  'bench',
  'paths',
  'nodes',
  'partitions',
];
const DEFAULT_HIDDEN = ['nodes', 'partitions'];
const LAYOUT_KEY = 'hpcSync.clusterLayout';

/**
 * Cluster dashboard composed of widgets the user can drag to reorder,
 * hide (✕) and re-add. Layout persists in extension global state.
 */
export class ClusterViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'hpcSync.cluster';
  private view?: vscode.WebviewView;

  constructor(
    private readonly ssh: SshManager,
    private readonly monitor: ClusterMonitor,
    private readonly analytics: UsageAnalytics,
    private readonly bench: StorageBench,
    private readonly memento: vscode.Memento
  ) {
    monitor.onDidUpdate(() => this.postState());
    analytics.onDidUpdate(() => this.postState());
    bench.onDidUpdate(() => this.postState());
    ssh.onStatusChanged(() => this.postState());
  }

  getLayout(): ClusterLayout {
    const stored = this.memento.get<ClusterLayout>(LAYOUT_KEY);
    const order = (stored?.order ?? ALL_WIDGETS).filter((w) => ALL_WIDGETS.includes(w));
    for (const w of ALL_WIDGETS) {
      if (!order.includes(w)) {
        order.push(w); // new widgets from newer versions append at the end
      }
    }
    const hidden = (stored?.hidden ?? DEFAULT_HIDDEN).filter((w) => ALL_WIDGETS.includes(w));
    return { order, hidden };
  }

  private async saveLayout(layout: ClusterLayout): Promise<void> {
    await this.memento.update(LAYOUT_KEY, layout);
    this.postState();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage(
      (msg: { command: string; id?: string; order?: string[] }) => {
        switch (msg.command) {
          case 'refresh':
            void vscode.commands.executeCommand('hpcSync.refreshCluster');
            break;
          case 'connect':
            void vscode.commands.executeCommand('hpcSync.connect');
            break;
          case 'rebuildPattern':
            void vscode.commands.executeCommand('hpcSync.rebuildUsagePattern');
            break;
          case 'runBench':
            void vscode.commands.executeCommand('hpcSync.benchmarkStorage');
            break;
          case 'openProject':
            void vscode.commands.executeCommand('hpcSync.projectManager');
            break;
          case 'copyText':
            if (msg.id) {
              void vscode.env.clipboard.writeText(msg.id);
              void vscode.window.setStatusBarMessage('HPC Sync: copied to clipboard', 2000);
            }
            break;
          case 'insertText': {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
              void vscode.window.showWarningMessage('HPC Sync: no active editor to insert into.');
            } else if (msg.id) {
              const text = msg.id;
              void editor.edit((b) => b.insert(editor.selection.active, text));
            }
            break;
          }
          case 'setLayout': {
            if (!Array.isArray(msg.order)) {
              break;
            }
            const layout = this.getLayout();
            const visible = msg.order.filter((w) => ALL_WIDGETS.includes(w));
            const rest = layout.order.filter((w) => !visible.includes(w));
            void this.saveLayout({ order: [...visible, ...rest], hidden: layout.hidden });
            break;
          }
          case 'hideWidget': {
            const layout = this.getLayout();
            if (msg.id && ALL_WIDGETS.includes(msg.id) && !layout.hidden.includes(msg.id)) {
              layout.hidden.push(msg.id);
              void this.saveLayout(layout);
            }
            break;
          }
          case 'showWidget': {
            const layout = this.getLayout();
            if (msg.id) {
              layout.hidden = layout.hidden.filter((w) => w !== msg.id);
              // re-added widgets go to the end
              layout.order = [...layout.order.filter((w) => w !== msg.id), msg.id];
              void this.saveLayout(layout);
            }
            break;
          }
        }
      }
    );
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postState();
        void this.monitor.refreshNow();
      }
    });
    this.postState();
  }

  postState(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'cluster',
      sshStatus: this.ssh.status,
      snapshot: this.monitor.getSnapshot(),
      pattern: this.analytics.get(),
      patternBusy: this.analytics.busy,
      bench: this.bench.get(),
      benchBusy: this.bench.busy,
      layout: this.getLayout(),
      paths: loadProjectConfig().mounts.map((m) => ({
        name: m.name,
        path: m.path,
        env: mountEnvName(m.name),
        purpose: m.purpose,
      })),
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
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 10px; --chartBar: #3b82d9; }
  body.vscode-dark, body.vscode-high-contrast { --chartBar: #4b95e8; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.88em; }
  .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .widget { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 6px; margin-bottom: 8px; background: var(--vscode-editorWidget-background); }
  .widget.dragging { opacity: 0.5; }
  .whead { display: flex; align-items: center; gap: 7px; padding: 4px 8px; cursor: grab; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.12)); user-select: none; }
  .whead:active { cursor: grabbing; }
  .grip { color: var(--vscode-descriptionForeground); font-size: 0.9em; letter-spacing: -1px; }
  .wtitle { font-size: 0.9em; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .whide { color: var(--vscode-descriptionForeground); cursor: pointer; padding: 0 3px; border-radius: 3px; font-size: 0.9em; }
  .whide:hover { background: rgba(248,81,73,0.2); color: #f85149; }
  .wbody { padding: 7px 9px; }
  .addrow { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 4px; }
  .addchip { border: 1px dashed var(--vscode-descriptionForeground); border-radius: 10px; padding: 1px 9px; font-size: 0.86em; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .addchip:hover { color: var(--vscode-foreground); border-color: var(--vscode-foreground); }
  .usage { margin-bottom: 8px; }
  .usage .row { display: flex; justify-content: space-between; gap: 8px; font-size: 0.92em; min-width: 0; }
  .usage .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .usage .val { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .bar-track { background: var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); border-radius: 2px; margin-top: 3px; height: 5px; }
  .bar { height: 5px; border-radius: 2px; background: #2ea043; }
  .bar.warn { background: #d29922; }
  .bar.crit { background: #f85149; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { border-radius: 10px; padding: 1px 9px; font-size: 0.88em; font-weight: 600; background: rgba(139,148,158,0.18); color: var(--vscode-foreground); }
  .chip.idle { background: rgba(46,160,67,0.18); color: #2ea043; }
  .chip.mixed { background: rgba(210,153,34,0.18); color: #d29922; }
  .chip.allocated { background: rgba(88,166,255,0.18); color: #58a6ff; }
  .chip.down, .chip.drained, .chip.draining { background: rgba(248,81,73,0.18); color: #f85149; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th { text-align: left; color: var(--vscode-descriptionForeground); font-weight: 600; padding: 3px 6px 3px 0; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); }
  td { padding: 3px 6px 3px 0; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.08)); }
  td.num, th.num { text-align: right; }
  .idle-strong { color: #2ea043; font-weight: 600; }
  .insight { padding: 4px 0 4px 2px; font-size: 0.92em; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.08)); }
  .insight:last-child { border-bottom: none; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 4px 2px; }
  .error { color: #f85149; font-size: 0.9em; margin: 6px 0; overflow-wrap: anywhere; }
  details { margin-top: 6px; }
  summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 0.9em; }
  pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; overflow-x: auto; background: var(--vscode-editor-background); padding: 6px; border-radius: 4px; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 4px 12px; cursor: pointer; font-family: inherit; font-size: inherit; }
  .chart { display: flex; align-items: flex-end; gap: 2px; height: 80px; margin-top: 6px; }
  .cbar { flex: 1; min-width: 2px; background: var(--chartBar); border-radius: 2px 2px 0 0; cursor: default; }
  .cbar:hover { filter: brightness(1.25); }
  .winline { display: flex; gap: 2px; height: 3px; margin-top: 2px; }
  .winline span { flex: 1; border-radius: 2px; }
  .winline span.on { background: var(--vscode-descriptionForeground); }
  .xaxis { display: flex; justify-content: space-between; font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .readout { font-size: 0.88em; color: var(--vscode-descriptionForeground); min-height: 1.2em; margin-top: 3px; }
</style>
</head>
<body>
  <div id="root"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let data = null;
  let dragId = null;

  const TITLES = {
    insights: 'Job planning insights',
    fairshare: 'Fair share',
    compute: 'Compute utilisation',
    pattern: 'Submission pattern',
    storage: 'Storage quotas',
    bench: 'Storage benchmark',
    paths: 'Project paths',
    nodes: 'Nodes',
    partitions: 'Partitions'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'cluster') {
      data = e.data;
      if (!dragId) { render(); } // don't yank the DOM mid-drag
    }
  });

  setInterval(function () {
    const el = document.getElementById('updated');
    if (el && data && data.snapshot.updatedAt) { el.textContent = agoText(); }
  }, 1000);

  function agoText() {
    const s = Math.max(0, Math.round((Date.now() - data.snapshot.updatedAt) / 1000));
    return 'updated ' + s + 's ago · auto ' + data.snapshot.pollIntervalSec + 's';
  }

  function barClass(pct) { return pct >= 90 ? 'bar crit' : pct >= 70 ? 'bar warn' : 'bar'; }

  function usageBlock(label, valueText, pct) {
    let html = '<div class="usage"><div class="row"><span class="label" title="' + esc(label) + '">' + esc(label) + '</span><span class="val">' + esc(valueText) + '</span></div>';
    if (typeof pct === 'number') {
      const p = Math.max(0, Math.min(100, pct));
      html += '<div class="bar-track"><div class="' + barClass(p) + '" style="width:' + p + '%"></div></div>';
    }
    html += '</div>';
    return html;
  }

  function hh(h) { return (h < 10 ? '0' : '') + h + ':00'; }

  function fmtVal(v) {
    if (v >= 1000000) { return (v / 1000000).toFixed(1) + 'M'; }
    if (v >= 1000) { return (v / 1000).toFixed(1) + 'k'; }
    return v.toFixed(v >= 100 ? 0 : 1);
  }

  // ── Widget bodies ──

  function bodyInsights(snap) {
    if (!snap.insights.length) { return '<div class="empty">No insights yet.</div>'; }
    let html = '';
    for (const i of snap.insights) { html += '<div class="insight">' + esc(i) + '</div>'; }
    return html;
  }

  function bodyFairshare(snap) {
    if (!snap.fairshare || !snap.fairshare.length) { return '<div class="empty">No fair-share data (sshare unavailable).</div>'; }
    let html = '';
    for (const r of snap.fairshare) {
      const pct = Math.round(r.fairShare * 100);
      let val = 'factor ' + r.fairShare.toFixed(3);
      if (r.ratio != null) { val += ' · usage ' + r.ratio.toFixed(2) + '× share'; }
      html += usageBlock(r.account, val, pct);
    }
    html += '<div class="meta">factor near 1 = under-used allocation (high priority); near 0 = over-used.</div>';
    const fm = snap.fairshareMeta;
    if (fm) {
      if (fm.nextResetAt) {
        const days = ((fm.nextResetAt - Date.now()) / 86400000).toFixed(1);
        html += '<div class="meta">usage hard-resets ' + esc((fm.resetPeriod || '').toLowerCase()) + ' · next reset in ' + days + ' d</div>';
      } else if (fm.halfLifeSec > 0) {
        let line = 'no hard reset — usage half-life ' + (fm.halfLifeSec / 86400).toFixed(1) + ' d';
        if (fm.ratioOneEtaSec) {
          line += ' · back to 1.0× share in ~' + (fm.ratioOneEtaSec / 86400).toFixed(1) + ' d at zero usage';
        }
        html += '<div class="meta">' + esc(line) + '</div>';
      }
    }
    return html;
  }

  function bodyCompute(snap) {
    let html = '';
    if (snap.cpu) {
      const pct = Math.round((snap.cpu.alloc / snap.cpu.total) * 100);
      html += usageBlock('CPU cores', snap.cpu.alloc.toLocaleString() + ' / ' + snap.cpu.total.toLocaleString() + ' allocated (' + snap.cpu.idle.toLocaleString() + ' idle)', pct);
    }
    if (snap.mem) {
      const pct = Math.round((snap.mem.allocMB / snap.mem.totalMB) * 100);
      const toTB = function (mb) { return (mb / 1048576).toFixed(1) + ' TiB'; };
      html += usageBlock('Memory', toTB(snap.mem.allocMB) + ' / ' + toTB(snap.mem.totalMB) + ' allocated', pct);
    }
    if (snap.gpu) {
      const pct = Math.round((snap.gpu.used / snap.gpu.total) * 100);
      html += usageBlock('GPUs', snap.gpu.used + ' / ' + snap.gpu.total + ' in use (' + (snap.gpu.total - snap.gpu.used) + ' free)', pct);
    }
    return html || '<div class="empty">No utilisation data yet.</div>';
  }

  function bodyNodes(snap) {
    const states = Object.keys(snap.nodeStates || {});
    if (!states.length) { return '<div class="empty">No node data yet.</div>'; }
    states.sort(function (a, b) { return snap.nodeStates[b] - snap.nodeStates[a]; });
    let html = '<div class="chips">';
    for (const st of states) {
      html += '<span class="chip ' + esc(st) + '">' + snap.nodeStates[st] + ' ' + esc(st) + '</span>';
    }
    return html + '</div>';
  }

  function bodyPartitions(snap) {
    if (!snap.partitions.length) { return '<div class="empty">No partition data yet.</div>'; }
    let html = '<table><tr><th>Partition</th><th class="num">idle</th><th class="num">mixed</th><th class="num">alloc</th><th class="num">total</th></tr>';
    for (const p of snap.partitions) {
      html += '<tr><td title="avail: ' + esc(p.avail) + '">' + esc(p.name) + '</td>' +
        '<td class="num' + (p.idleNodes > 0 ? ' idle-strong' : '') + '">' + p.idleNodes + '</td>' +
        '<td class="num">' + p.mixedNodes + '</td>' +
        '<td class="num">' + p.allocNodes + '</td>' +
        '<td class="num">' + p.totalNodes + '</td></tr>';
    }
    return html + '</table>';
  }

  function bodyPattern(p, busy) {
    let html = '';
    if (busy) { html += '<div class="empty">Building from cluster accounting… (can take a minute)</div>'; }
    if (!p) {
      if (!busy) { html += '<div class="empty">No data yet.</div><a id="lnkPattern">Build now</a>'; }
      return html;
    }
    const bins = p.bins;
    const max = Math.max.apply(null, bins.concat([1]));
    let best = 0, bestSum = Infinity;
    for (let h = 0; h < 24; h++) {
      const s = bins[h] + bins[(h + 1) % 24] + bins[(h + 2) % 24];
      if (s < bestSum) { bestSum = s; best = h; }
    }
    const inWin = function (h) { return h === best || h === (best + 1) % 24 || h === (best + 2) % 24; };
    let peak = 0;
    for (let h = 1; h < 24; h++) { if (bins[h] > bins[peak]) { peak = h; } }

    // Convert cluster hours to this machine's local time. The webview runs
    // locally, so its Date has the true local offset.
    let shiftH = 0;
    let haveShift = false;
    if (typeof p.clusterUtcOffsetMin === 'number') {
      const localOff = -new Date().getTimezoneOffset();
      shiftH = Math.round((localOff - p.clusterUtcOffsetMin) / 60);
      haveShift = true;
    }
    const hhL = function (h) { return hh(((h + shiftH) % 24 + 24) % 24); };
    const dual = haveShift && shiftH !== 0;
    const both = function (h) { return hh(h) + (dual ? ' cluster / ' + hhL(h) + ' local' : ''); };
    const bothRange = function (a, b) {
      let s = hh(a) + '–' + hh(b);
      if (dual) { s += ' cluster (' + hhL(a) + '–' + hhL(b) + ' your local time)'; }
      return s;
    };

    const unit = p.source === 'sacct' ? 'core·h' : 'cores';
    const title = p.source === 'sacct'
      ? 'Core-hours by submission hour — last 7 days, all users (cluster time)'
      : 'Cores in the current queue by submission hour (accounting restricted; live-queue fallback)';
    html += '<div class="meta">' + esc(title) + '</div>';
    html += '<div class="chart" id="chart">';
    for (let h = 0; h < 24; h++) {
      const px = Math.max(2, Math.round((bins[h] / max) * 78));
      html += '<div class="cbar" style="height:' + px + 'px" data-h="' + h + '" title="' + both(h) + ' — ' + fmtVal(bins[h]) + ' ' + unit + '"></div>';
    }
    html += '</div><div class="winline">';
    for (let h = 0; h < 24; h++) { html += '<span class="' + (inWin(h) ? 'on' : '') + '"></span>'; }
    html += '</div><div class="xaxis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>';
    if (dual) {
      html += '<div class="meta" style="text-align:center">axis is cluster time · your local time = cluster ' + (shiftH > 0 ? '+' : '') + shiftH + 'h</div>';
    } else if (haveShift) {
      html += '<div class="meta" style="text-align:center">cluster time = your local time</div>';
    }
    html += '<div class="readout" id="readout">peak ' + hh(peak) + ' (' + fmtVal(bins[peak]) + ' ' + unit + ') · quietest window ' + hh(best) + '–' + hh((best + 3) % 24) + '</div>';
    html += '<div class="insight">Suggested submission window: <b>' + bothRange(best, (best + 3) % 24) + '</b> — least competing demand.</div>';
    html += '<details><summary>Data table</summary><table><tr><th>Hour</th><th class="num">' + esc(unit) + '</th></tr>';
    for (let h = 0; h < 24; h++) {
      html += '<tr><td>' + hh(h) + '</td><td class="num">' + fmtVal(bins[h]) + '</td></tr>';
    }
    html += '</table></details>';
    const age = Math.round((Date.now() - p.fetchedAt) / 3600000 * 10) / 10;
    html += '<div class="meta">cached ' + age + 'h ago · <a id="lnkPattern">' + (busy ? 'rebuilding…' : 'Rebuild') + '</a></div>';
    return html;
  }

  function bodyStorage(snap) {
    let html = '';
    if (snap.storage.length) {
      for (const f of snap.storage) {
        let val = f.used + ' / ' + f.quota;
        if (f.filesUsed) { val += ' · ' + f.filesUsed + '/' + f.filesQuota + ' files'; }
        html += usageBlock(f.label, val, f.usedPct);
      }
    } else if (snap.storageError) {
      html += '<div class="empty">' + esc(snap.storageError) + '</div>';
    } else if (snap.storageRaw) {
      html += '<div class="empty">Could not parse quota table — raw output below.</div>';
    } else {
      html += '<div class="empty">No quota data yet.</div>';
    }
    if (snap.storageRaw) {
      html += '<details><summary>Raw diskusage_report output</summary><pre>' + esc(snap.storageRaw) + '</pre></details>';
    }
    return html;
  }

  function bodyBench(b, busy) {
    if (busy) { return '<div class="empty">Benchmark running on the login node…</div>'; }
    if (!b) {
      return '<div class="empty">Not run yet. Measures sequential read/write per filesystem (256 MB, O_DIRECT, on the login node — indicative, not job-node numbers).</div><a id="lnkBench">Run benchmark</a>';
    }
    const results = b.results || [];
    let html = '<table><tr><th>Storage</th><th class="num">write</th><th class="num">read</th></tr>';
    for (const r of results) {
      html += '<tr><td title="' + esc(r.path) + '">' + esc(r.label) + '</td>';
      if (r.note) {
        html += '<td colspan="2" class="num">' + esc(r.note) + '</td>';
      } else {
        html += '<td class="num">' + (r.writeMBps != null ? r.writeMBps.toFixed(0) + ' MB/s' : '—') + '</td>' +
                '<td class="num">' + (r.readMBps != null ? r.readMBps.toFixed(0) + ' MB/s' : '—') + '</td>';
      }
      html += '</tr>';
    }
    html += '</table>';
    const age = Math.round((Date.now() - b.ranAt) / 3600000 * 10) / 10;
    html += '<div class="meta">ran ' + age + 'h ago · ' + b.sizeMB + ' MB per test · <a id="lnkBench">Run again</a></div>';
    return html;
  }

  function bodyPaths() {
    const py = function (env, fb) { return 'Path(os.environ.get("' + env + '", "' + fb + '"))'; };
    const row = function (title, env, sub, fb) {
      return '<div style="padding:5px 0;border-bottom:1px solid var(--vscode-widget-border, rgba(128,128,128,0.08))">' +
        '<div style="font-size:0.93em"><b>' + esc(title) + '</b> <span style="font-family:var(--vscode-editor-font-family,monospace);font-size:0.86em;color:var(--vscode-textLink-foreground)">' + esc(env) + '</span></div>' +
        (sub ? '<div class="meta" style="overflow-wrap:anywhere">' + esc(sub) + '</div>' : '') +
        '<div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap">' +
        '<a data-copytext="' + esc(env) + '">copy env</a> · ' +
        '<a data-copytext="' + esc(py(env, fb)) + '">copy py</a> · ' +
        '<a data-inserttext="' + esc(py(env, fb)) + '">insert py</a>' +
        '</div></div>';
    };
    let html = row('outputs', 'OUTPUT_DIR', 'set by every launch — where results go', 'output');
    html += row('staged inputs', 'INPUT_DIR', 'set when staging is on — node-local input copies', 'data');
    if (!data.paths || !data.paths.length) {
      html += '<div class="empty">No mounts defined — <a id="lnkProject2">open the Project Manager</a> to add them.</div>';
    } else {
      for (const m of data.paths) {
        const fb = m.path.split('/').filter(Boolean).pop() || 'data';
        html += row('📁 ' + m.name, m.env, m.path + (m.purpose ? ' · ' + m.purpose : ''), fb);
      }
    }
    html += '<div class="meta" style="margin-top:4px">snippets need: import os · from pathlib import Path</div>';
    return html;
  }

  function widgetBody(id) {
    const snap = data.snapshot;
    switch (id) {
      case 'insights': return bodyInsights(snap);
      case 'fairshare': return bodyFairshare(snap);
      case 'compute': return bodyCompute(snap);
      case 'nodes': return bodyNodes(snap);
      case 'partitions': return bodyPartitions(snap);
      case 'pattern': return bodyPattern(data.pattern, data.patternBusy);
      case 'storage': return bodyStorage(snap);
      case 'bench': return bodyBench(data.bench, data.benchBusy);
      case 'paths': return bodyPaths();
      default: return '';
    }
  }

  function render() {
    const root = document.getElementById('root');
    if (!data) { return; }
    const snap = data.snapshot;

    if (data.sshStatus !== 'connected') {
      root.innerHTML = '<div class="empty">' +
        (data.sshStatus === 'disconnected' ? 'Not connected to the cluster.' : 'Connecting… (' + esc(data.sshStatus) + ')') +
        '</div>' +
        (data.sshStatus === 'disconnected' ? '<button class="primary" id="btnConnect">Connect</button>' : '');
      const b = document.getElementById('btnConnect');
      if (b) { b.onclick = function () { vscode.postMessage({ command: 'connect' }); }; }
      return;
    }

    const layout = data.layout || { order: Object.keys(TITLES), hidden: [] };
    let html = '<div class="topbar"><span class="meta" id="updated">' + (snap.updatedAt ? agoText() : 'refreshing…') + '</span><a id="lnkRefresh">Refresh</a></div>';
    if (snap.error) { html += '<div class="error">' + esc(snap.error) + '</div>'; }

    html += '<div id="widgets">';
    for (const id of layout.order) {
      if (layout.hidden.includes(id) || !TITLES[id]) { continue; }
      html += '<div class="widget" draggable="true" data-id="' + id + '">' +
        '<div class="whead"><span class="grip">⣿</span><span class="wtitle">' + esc(TITLES[id]) + '</span>' +
        '<span class="whide" title="Hide widget" data-hide="' + id + '">✕</span></div>' +
        '<div class="wbody">' + widgetBody(id) + '</div></div>';
    }
    html += '</div>';

    if (layout.hidden.length) {
      html += '<div class="addrow"><span class="meta">Add widget:</span>';
      for (const id of layout.hidden) {
        if (!TITLES[id]) { continue; }
        html += '<span class="addchip" data-show="' + id + '">+ ' + esc(TITLES[id]) + '</span>';
      }
      html += '</div>';
    }
    html += '<div class="meta" style="margin-top:6px">drag widgets by their header to reorder</div>';

    root.innerHTML = html;
    wire();
  }

  function wire() {
    const lnk = document.getElementById('lnkRefresh');
    if (lnk) { lnk.onclick = function () { vscode.postMessage({ command: 'refresh' }); }; }
    const lp = document.getElementById('lnkPattern');
    if (lp) { lp.onclick = function () { vscode.postMessage({ command: 'rebuildPattern' }); }; }
    const lb = document.getElementById('lnkBench');
    if (lb) { lb.onclick = function () { vscode.postMessage({ command: 'runBench' }); }; }
    const lp2 = document.getElementById('lnkProject2');
    if (lp2) { lp2.onclick = function () { vscode.postMessage({ command: 'openProject' }); }; }
    document.querySelectorAll('[data-copytext]').forEach(function (a) {
      a.onclick = function () { vscode.postMessage({ command: 'copyText', id: a.getAttribute('data-copytext') }); };
    });
    document.querySelectorAll('[data-inserttext]').forEach(function (a) {
      a.onclick = function () { vscode.postMessage({ command: 'insertText', id: a.getAttribute('data-inserttext') }); };
    });

    document.querySelectorAll('.whide').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        vscode.postMessage({ command: 'hideWidget', id: el.getAttribute('data-hide') });
      };
    });
    document.querySelectorAll('.addchip').forEach(function (el) {
      el.onclick = function () {
        vscode.postMessage({ command: 'showWidget', id: el.getAttribute('data-show') });
      };
    });

    const container = document.getElementById('widgets');
    if (container) {
      container.addEventListener('dragstart', function (e) {
        const w = e.target.closest ? e.target.closest('.widget') : null;
        if (w) {
          dragId = w.getAttribute('data-id');
          w.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', dragId); } catch (err) {}
        }
      });
      container.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (!dragId) { return; }
        const w = e.target.closest ? e.target.closest('.widget') : null;
        if (!w || w.getAttribute('data-id') === dragId) { return; }
        const dragEl = container.querySelector('.widget[data-id="' + dragId + '"]');
        if (!dragEl) { return; }
        const rect = w.getBoundingClientRect();
        if (e.clientY - rect.top < rect.height / 2) {
          container.insertBefore(dragEl, w);
        } else {
          container.insertBefore(dragEl, w.nextSibling);
        }
      });
      container.addEventListener('drop', function (e) { e.preventDefault(); });
      container.addEventListener('dragend', function () {
        const el = container.querySelector('.widget.dragging');
        if (el) { el.classList.remove('dragging'); }
        if (dragId) {
          dragId = null;
          const ids = Array.from(container.querySelectorAll('.widget')).map(function (w) {
            return w.getAttribute('data-id');
          });
          vscode.postMessage({ command: 'setLayout', order: ids });
        }
      });
    }

    const chart = document.getElementById('chart');
    const readout = document.getElementById('readout');
    if (chart && readout) {
      const base = readout.textContent;
      chart.addEventListener('mouseover', function (ev) {
        const t = ev.target;
        if (t && t.classList && t.classList.contains('cbar')) { readout.textContent = t.title; }
      });
      chart.addEventListener('mouseleave', function () { readout.textContent = base; });
    }
  }
</script>
</body>
</html>`;
  }
}
