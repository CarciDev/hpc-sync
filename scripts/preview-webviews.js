// Render webviews with realistic sample data into preview/*.html so layout
// changes can be eyeballed in a plain browser BEFORE packaging. The harness
// stubs acquireVsCodeApi (postMessage calls land in the devtools console) and
// defines the --vscode-* theme variables the webviews rely on.
//
// Usage: npm run compile && node scripts/preview-webviews.js
//        then open preview/<name>.html in a browser.
const Module = require('module');
const origLoad = Module._load;
const disposable = { dispose() {} };
const eventFn = () => disposable;
const vscodeStub = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {} }),
    createWebviewPanel: () => ({
      webview: { html: '', onDidReceiveMessage: eventFn, postMessage: async () => true },
      onDidDispose: eventFn,
      reveal() {},
      dispose() {},
    }),
  },
  workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeConfiguration: eventFn, createFileSystemWatcher: () => ({ onDidChange: eventFn, onDidCreate: eventFn, onDidDelete: eventFn, dispose() {} }) },
  EventEmitter: class {
    get event() { return eventFn; }
    fire() {}
    dispose() {}
  },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { Active: -1, Beside: -2 },
};
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, [request, ...rest]);
};

const fs = require('fs');
const path = require('path');
const base = path.join(__dirname, '..', 'out') + path.sep;
const outDir = path.join(__dirname, '..', 'preview');
fs.mkdirSync(outDir, { recursive: true });

// Dark-modern-ish values for the CSS variables VS Code normally injects.
const THEME = `<style>:root{
  --vscode-font-family: "Segoe UI", system-ui, sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, monospace;
  --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d;
  --vscode-editor-background: #1f1f1f; --vscode-editorWidget-background: #252526;
  --vscode-widget-border: #454545; --vscode-editorWidget-border: #454545;
  --vscode-textLink-foreground: #4daafc; --vscode-focusBorder: #007fd4;
  --vscode-button-background: #0e639c; --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-secondaryBackground: #3a3d41; --vscode-button-secondaryForeground: #f0f0f0;
  --vscode-button-secondaryHoverBackground: #45494e;
  --vscode-input-background: #3c3c3c; --vscode-input-foreground: #cccccc; --vscode-input-border: #3c3c3c;
  --vscode-progressBar-background: #0e70c0; --vscode-charts-orange: #d29922;
} body { background: var(--vscode-editor-background); }</style>`;

function write(name, html, messages, widthNote, cssWidth) {
  const nonce = /nonce-([a-z0-9]+)/.exec(html)?.[1] || '';
  // Sidebar views: constrain the body to the real view width — headless
  // screenshots at small --window-size are unreliable under display scaling.
  const clamp = cssWidth
    ? `<style>body { max-width: ${cssWidth}px; box-sizing: border-box; border-right: 1px dashed #666; min-height: 100vh; }</style>`
    : '';
  const boot = `<script nonce="${nonce}">window.acquireVsCodeApi = function () { return {
    postMessage: function (m) { console.log('[webview→ext]', JSON.stringify(m)); },
    setState: function () {}, getState: function () { return undefined; } }; };</script>`;
  const feeder = `<script nonce="${nonce}">window.addEventListener('load', function () {
    ${messages.map((m) => `window.postMessage(${JSON.stringify(m)}, '*');`).join('\n    ')}
  });</script>`;
  let out = html.replace('</head>', THEME + clamp + boot + '</head>');
  out = out.replace('</body>', feeder + '</body>');
  const file = path.join(outDir, name + '.html');
  fs.writeFileSync(file, out);
  console.log('preview: ' + path.relative(process.cwd(), file) + (widthNote ? '  (' + widthNote + ')' : ''));
}

// ── shared sample data ──
const SNAPSHOT = {
  host: 'rorqual.alliancecan.ca',
  scannedAt: Date.now() - 4 * 60000,
  projectsParent: '/home/dcarcien/projects',
  projects: [
    { name: 'nisar_test_extension', remoteDir: '/home/dcarcien/projects/nisar_test_extension', hasManifest: true, sifSizeBytes: 2254857830, sifSize: '2.1 GB', localEdits: true,
      mounts: [
        { name: 'landsat_cache', path: '$SCRATCH/shared/landsat', purpose: 'L8 tiles' },
        { name: 'dem_tiles', path: '~/projects/shared_dem' },
      ] },
    { name: 'flood_mapping', remoteDir: '/home/dcarcien/projects/flood_mapping', hasManifest: true, sifSizeBytes: 4294967296, sifSize: '4.0 GB',
      mounts: [
        { name: 'landsat', path: '$SCRATCH/shared/landsat' },
        { name: 'era5', path: '$SCRATCH/shared/era5_hourly', purpose: 'reanalysis' },
      ] },
    { name: 'glacier_ml', remoteDir: '/home/dcarcien/projects/glacier_ml', hasManifest: true, mounts: [] },
    { name: 'scratch_experiments', remoteDir: '/home/dcarcien/projects/scratch_experiments', hasManifest: false, mounts: [] },
  ],
  mounts: [
    { path: '/scratch/dcarcien/shared/landsat', display: '$SCRATCH/shared/landsat', names: ['landsat_cache', 'landsat'], purposes: ['L8 tiles'], projects: ['nisar_test_extension', 'flood_mapping'] },
    { path: '/home/dcarcien/projects/shared_dem', display: '~/projects/shared_dem', names: ['dem_tiles'], purposes: [], projects: ['nisar_test_extension'] },
    { path: '/scratch/dcarcien/shared/era5_hourly', display: '$SCRATCH/shared/era5_hourly', names: ['era5'], purposes: ['reanalysis'], projects: ['flood_mapping'] },
  ],
};

// ── Projects sidebar view (~300px wide in the sidebar) ──
const { ProjectsViewProvider } = require(base + 'projectsView.js');
const stubAtlas = { onDidUpdate: eventFn, getSnapshot: () => undefined, currentProjectName: () => 'nisar_test_extension' };
const stubCluster = { onDidUpdate: eventFn, getSnapshot: () => ({ storage: [] }) };
const QUOTA = [
  { label: '/home (user dcarcien)', used: '35GB', total: '50GB', pct: 71 },
  { label: '/scratch (user dcarcien)', used: '605MB', total: '20TB', pct: 0 },
  { label: '/project (project rrg-dclausi)', used: '2906GB', total: '95TB', pct: 3 },
  { label: '/nearline (project def-dclausi)', used: '221KB', total: '1000GB', pct: 0 },
];
// A snapshot like the user's real one: current project synced, no mounts yet.
const SNAPSHOT_BARE = {
  host: SNAPSHOT.host, scannedAt: SNAPSHOT.scannedAt, projectsParent: SNAPSHOT.projectsParent,
  projects: [{ name: 'nisar_test_extension', remoteDir: '/home/dcarcien/projects/nisar_test_extension', hasManifest: true, sifSizeBytes: 577699840, sifSize: '551 MB', mounts: [] }],
  mounts: [],
};
write('projectsView', new ProjectsViewProvider({ onStatusChanged: eventFn }, stubAtlas, stubCluster).html(), [
  { type: 'state', status: 'connected', current: 'nisar_test_extension', snapshot: SNAPSHOT, quota: QUOTA },
], 'body clamped to 300px = sidebar width', 300);
write('projectsView-bare', new ProjectsViewProvider({ onStatusChanged: eventFn }, stubAtlas, stubCluster).html(), [
  { type: 'state', status: 'connected', current: 'nisar_test_extension', snapshot: SNAPSHOT_BARE, quota: QUOTA },
], 'zero-mount project, like a fresh sync', 300);

// ── Project Atlas panel ──
const { AtlasPanel } = require(base + 'atlasPanel.js');
write('atlasPanel', AtlasPanel.prototype.html.call(Object.create(AtlasPanel.prototype)), [
  { type: 'state', snapshot: SNAPSHOT, current: 'nisar_test_extension',
    scope: { label: 'Job 12345 · nisar_test_extension', project: 'nisar_test_extension', mountPaths: ['/scratch/dcarcien/shared/landsat'] } },
]);

// ── Launch panel ──
const { LaunchPanel } = require(base + 'launchPanel.js');
const cap = (i, w, r) => ({ input: i, workspace: w, result: r });
write('launchPanel', LaunchPanel.prototype.html.call(Object.create(LaunchPanel.prototype)), [
  { type: 'init', script: 'test.py', connected: true,
    suggestions: ['Median queue wait for 4 CPU / 8G: ~6 min', 'Scratch is fastest for large writes (bench: w 1200 / r 1600 MB/s)'],
    palette: [
      { id: 'project', label: 'Project', base: '/project/rrg-x/dcarcien/nisar_out', lifetime: 'persistent · backed up', caps: cap(true, false, true), quotaText: '221 KB / 1000 GB', quotaPct: 1 },
      { id: 'scratch', label: 'Scratch', base: '/scratch/dcarcien/nisar_out', lifetime: '⚠ purged after ~60 days idle', caps: cap(true, false, true), quotaText: '605 MB / 20 TB', quotaPct: 1, benchText: 'w 1200 / r 1600 MB/s' },
      { id: 'home', label: 'Home', base: '/home/dcarcien/nisar_out', lifetime: 'small quota — avoid large outputs', caps: cap(true, false, true), quotaText: '35 GB / 50 GB', quotaPct: 71 },
      { id: 'nearline', label: 'Nearline', base: '/nearline/rrg-x/dcarcien/archive', lifetime: 'tape archive · slow retrieval, write-mostly', caps: cap(false, false, true) },
      { id: 'tmpdir', label: '$SLURM_TMPDIR', base: '$SLURM_TMPDIR', lifetime: 'per-job NVMe · fastest I/O · wiped at job end', caps: cap(false, true, false) },
      { id: 'custom', label: 'Custom path…', base: '', lifetime: 'you know best', caps: cap(true, false, true) },
      { id: 'mount:landsat_cache', label: '📁 landsat_cache', base: '$SCRATCH/shared/landsat', lifetime: 'L8 tiles', caps: cap(true, false, true), bind: true, mountName: 'landsat_cache' },
      { id: 'mount:dem_tiles', label: '📁 dem_tiles', base: '~/projects/shared_dem', lifetime: 'project mount · bind-mounted into the container', caps: cap(true, false, true), bind: true, mountName: 'dem_tiles' },
    ],
    accounts: ['rrg-x', 'rrg-x_gpu'],
    tpl: { account: 'rrg-x', apptainerLoad: 'module load apptainer', remoteProjectDir: '~/projects/nisar_test_extension', containerWorkdir: '/workspaces/nisar_test_extension', sifPath: '~/containers/nisar_test_extension.sif', defaultJobName: 'test', gpuOnly: false } },
]);

console.log('\nOpen the files above in a browser. postMessage calls appear in the devtools console.');
