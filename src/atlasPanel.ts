import * as vscode from 'vscode';
import { AtlasModel } from './atlasModel';

/** Optional scoping: show only one project + the mounts a run binds + 1-hop neighbours. */
export interface AtlasScope {
  label: string;
  project: string;
  /** normalized mount paths bound by the run */
  mountPaths: string[];
}

/**
 * "Project Atlas": bipartite projects ↔ mounts graph. Deterministic
 * two-column layout with SVG edges — deliberately NOT force-directed, and no
 * external libraries (repo webview rule).
 */
export class AtlasPanel {
  private static instance?: AtlasPanel;
  private readonly panel: vscode.WebviewPanel;
  private scope?: AtlasScope;

  static show(atlas: AtlasModel, scope?: AtlasScope): void {
    if (AtlasPanel.instance) {
      AtlasPanel.instance.scope = scope;
      AtlasPanel.instance.panel.reveal();
      AtlasPanel.instance.postState(atlas);
      return;
    }
    AtlasPanel.instance = new AtlasPanel(atlas, scope);
  }

  private constructor(
    private readonly atlas: AtlasModel,
    scope?: AtlasScope
  ) {
    this.scope = scope;
    this.panel = vscode.window.createWebviewPanel(
      'hpcSyncAtlas',
      'Project Atlas',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg: { command: string }) => {
      if (msg.command === 'refresh') {
        void vscode.commands.executeCommand('hpcSync.refreshProjects');
      }
    });
    const sub = atlas.onDidUpdate(() => this.postState(atlas));
    this.panel.onDidDispose(() => {
      sub.dispose();
      AtlasPanel.instance = undefined;
    });
    this.postState(atlas);
  }

  private postState(atlas: AtlasModel): void {
    void this.panel.webview.postMessage({
      type: 'state',
      snapshot: atlas.getSnapshot(),
      current: atlas.currentProjectName(),
      scope: this.scope,
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
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 14px 18px; }
  h2 { margin: 0 0 4px; font-size: 1.15em; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .topbar .grow { flex: 1; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .chip { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4)); border-radius: 12px; padding: 2px 10px; font-size: 0.88em; cursor: pointer; }
  .chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 20px 0; }
  #stage { position: relative; }
  #edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  #cols { display: flex; gap: 130px; align-items: flex-start; position: relative; }
  .col { flex: 1; min-width: 220px; max-width: 380px; display: flex; flex-direction: column; gap: 10px; }
  .colhead { font-size: 0.8em; font-weight: 700; letter-spacing: 0.07em; color: var(--vscode-descriptionForeground); }
  .card { position: relative; z-index: 1; background: var(--vscode-editorWidget-background); border: 1.5px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 8px; padding: 7px 11px; cursor: pointer; transition: opacity 0.12s; }
  .card .t { font-weight: 600; overflow-wrap: anywhere; }
  .card .s { color: var(--vscode-descriptionForeground); font-size: 0.85em; overflow-wrap: anywhere; }
  .card.mount .t::before { content: '📁 '; }
  .card.you { border-color: var(--vscode-textLink-foreground); }
  .card.nomanifest { border-style: dashed; opacity: 0.75; }
  .card.dim { opacity: 0.25; }
  .card.hot { border-color: var(--vscode-charts-orange, #d29922); }
  path.edge { stroke: var(--vscode-descriptionForeground); stroke-opacity: 0.45; stroke-width: 1.6; fill: none; }
  path.edge.dim { stroke-opacity: 0.08; }
  path.edge.hot { stroke: var(--vscode-charts-orange, #d29922); stroke-opacity: 0.95; stroke-width: 2.4; }
  #detail { margin-top: 14px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); padding-top: 8px; min-height: 1.4em; }
</style>
</head>
<body>
  <div class="topbar">
    <div><h2 id="title">Project Atlas</h2><div class="meta" id="sub"></div></div>
    <div class="grow"></div>
    <span class="chip" id="chipAll">All</span>
    <span class="chip" id="chipScope" style="display:none"></span>
    <a id="lnkRefresh">⟳ rescan</a>
  </div>
  <div id="stage">
    <svg id="edges"></svg>
    <div id="cols">
      <div class="col" id="colP"><div class="colhead">PROJECTS</div></div>
      <div class="col" id="colM"><div class="colhead">MOUNTS</div></div>
    </div>
  </div>
  <div id="detail" class="meta"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let data = null;
  let scoped = false;
  let pinned = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'state') {
      data = e.data;
      scoped = !!data.scope;
      pinned = null;
      render();
    }
  });
  window.addEventListener('resize', function () { drawEdges(); });

  el('lnkRefresh').onclick = function () { vscode.postMessage({ command: 'refresh' }); };
  el('chipAll').onclick = function () { scoped = false; render(); };
  el('chipScope').onclick = function () { if (data && data.scope) { scoped = true; render(); } };

  function visibleSets() {
    const snap = data.snapshot;
    const all = { projects: snap.projects, mounts: snap.mounts, hidden: 0 };
    if (!scoped || !data.scope) { return all; }
    const paths = data.scope.mountPaths || [];
    const mounts = snap.mounts.filter(function (m) { return paths.indexOf(m.path) >= 0; });
    const projNames = { };
    projNames[data.scope.project] = true;
    mounts.forEach(function (m) { m.projects.forEach(function (p) { projNames[p] = true; }); });
    const projects = snap.projects.filter(function (p) { return projNames[p.name]; });
    const hidden = (snap.projects.length - projects.length) + (snap.mounts.length - mounts.length);
    return { projects: projects, mounts: mounts, hidden: hidden };
  }

  function render() {
    if (!data) { return; }
    const snap = data.snapshot;
    const colP = el('colP');
    const colM = el('colM');
    colP.innerHTML = '<div class="colhead">PROJECTS</div>';
    colM.innerHTML = '<div class="colhead">MOUNTS</div>';
    el('chipScope').style.display = data.scope ? '' : 'none';
    if (data.scope) {
      el('chipScope').textContent = data.scope.label;
      el('chipScope').className = 'chip' + (scoped ? ' on' : '');
    }
    el('chipAll').className = 'chip' + (scoped ? '' : ' on');

    if (!snap || !snap.scannedAt) {
      el('sub').textContent = 'No cluster scan yet — connect and press rescan.';
      el('edges').innerHTML = '';
      return;
    }
    const vis = visibleSets();
    el('sub').textContent = snap.projectsParent + ' · ' + vis.projects.length + ' project(s), ' + vis.mounts.length + ' mount(s)' +
      (vis.hidden ? ' · ' + vis.hidden + ' node(s) hidden by job scope' : '') + ' · scanned ' + new Date(snap.scannedAt).toLocaleTimeString();

    for (const p of vis.projects) {
      const d = document.createElement('div');
      d.className = 'card' + (p.name === data.current ? ' you' : '') + (p.hasManifest ? '' : ' nomanifest');
      d.setAttribute('data-node', 'P:' + p.name);
      d.innerHTML = '<div class="t">' + esc(p.name) + '</div><div class="s">' +
        (p.sifSizeBytes ? (p.sifSizeBytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB .sif' : 'no .sif') +
        (p.hasManifest ? '' : ' · not synced by HPC Sync') + '</div>';
      colP.appendChild(d);
    }
    for (const m of vis.mounts) {
      const d = document.createElement('div');
      d.className = 'card mount';
      d.setAttribute('data-node', 'M:' + m.path);
      d.innerHTML = '<div class="t">' + esc(m.names.join(' / ')) + '</div><div class="s">' + esc(m.path) +
        (m.purposes.length ? ' · ' + esc(m.purposes.join('; ')) : '') + '</div>';
      colM.appendChild(d);
    }

    document.querySelectorAll('.card').forEach(function (c) {
      c.addEventListener('mouseenter', function () { if (!pinned) { highlight(c.getAttribute('data-node')); } });
      c.addEventListener('mouseleave', function () { if (!pinned) { highlight(null); } });
      c.addEventListener('click', function () {
        const id = c.getAttribute('data-node');
        pinned = pinned === id ? null : id;
        highlight(pinned);
        showDetail(pinned);
      });
    });

    drawEdges();
    showDetail(null);
  }

  function edgeList() {
    const vis = visibleSets();
    const edges = [];
    for (const m of vis.mounts) {
      for (const pn of m.projects) {
        if (vis.projects.some(function (p) { return p.name === pn; })) {
          edges.push({ from: 'P:' + pn, to: 'M:' + m.path });
        }
      }
    }
    return edges;
  }

  function drawEdges() {
    if (!data || !data.snapshot) { return; }
    const svg = el('edges');
    const stage = el('stage');
    const sb = stage.getBoundingClientRect();
    svg.setAttribute('viewBox', '0 0 ' + sb.width + ' ' + sb.height);
    let html = '';
    for (const e of edgeList()) {
      const a = document.querySelector('[data-node="' + CSS.escape(e.from) + '"]');
      const b = document.querySelector('[data-node="' + CSS.escape(e.to) + '"]');
      if (!a || !b) { continue; }
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const x1 = ra.right - sb.left, y1 = ra.top + ra.height / 2 - sb.top;
      const x2 = rb.left - sb.left, y2 = rb.top + rb.height / 2 - sb.top;
      const mx = (x1 + x2) / 2;
      html += '<path class="edge" data-from="' + esc(e.from) + '" data-to="' + esc(e.to) + '" d="M ' + x1 + ' ' + y1 +
        ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + x2 + ' ' + y2 + '"/>';
    }
    svg.innerHTML = html;
  }

  function highlight(nodeId) {
    const cards = document.querySelectorAll('.card');
    const edges = document.querySelectorAll('path.edge');
    if (!nodeId) {
      cards.forEach(function (c) { c.classList.remove('dim', 'hot'); });
      edges.forEach(function (p) { p.classList.remove('dim', 'hot'); });
      return;
    }
    const hot = { };
    hot[nodeId] = true;
    edges.forEach(function (p) {
      const on = p.getAttribute('data-from') === nodeId || p.getAttribute('data-to') === nodeId;
      p.classList.toggle('hot', on);
      p.classList.toggle('dim', !on);
      if (on) { hot[p.getAttribute('data-from')] = true; hot[p.getAttribute('data-to')] = true; }
    });
    cards.forEach(function (c) {
      const id = c.getAttribute('data-node');
      c.classList.toggle('hot', !!hot[id] && id !== nodeId);
      c.classList.toggle('dim', !hot[id]);
    });
  }

  function showDetail(nodeId) {
    const box = el('detail');
    if (!nodeId || !data.snapshot) {
      box.textContent = 'Hover to highlight relations · click to pin · click a mount to see every project that depends on it.';
      return;
    }
    if (nodeId.slice(0, 2) === 'M:') {
      const m = data.snapshot.mounts.find(function (x) { return 'M:' + x.path === nodeId; });
      if (m) {
        box.innerHTML = '<b>' + esc(m.names.join(' / ')) + '</b> — ' + esc(m.path) +
          '<br>used by: ' + esc(m.projects.join(', ')) +
          (m.purposes.length ? '<br>' + esc(m.purposes.join('; ')) : '');
      }
    } else {
      const p = data.snapshot.projects.find(function (x) { return 'P:' + x.name === nodeId; });
      if (p) {
        box.innerHTML = '<b>' + esc(p.name) + '</b> — ' + esc(p.remoteDir) +
          '<br>' + (p.mounts.length ? 'mounts: ' + esc(p.mounts.map(function (m) { return m.name; }).join(', ')) : 'no mounts') +
          (p.hasManifest ? '' : '<br>⚠ no .hpcproject.json manifest on the cluster');
      }
    }
  }
</script>
</body>
</html>`;
  }
}
