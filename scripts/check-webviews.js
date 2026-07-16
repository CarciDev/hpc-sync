// Extract each webview's <script> and syntax-check it with the VM compiler.
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

const vm = require('vm');
const path = require('path');
const base = path.join(__dirname, '..', 'out') + path.sep;
const stubSsh = { onStatusChanged: eventFn, status: 'disconnected', target: '' };
const stubMon = { onDidUpdate: eventFn, getSnapshot: () => ({ active: [], recent: [], pollIntervalSec: 15 }) };
const stubMem = { get: (_k, d) => d, update: async () => {} };
const stubSvc = { onDidUpdate: eventFn, get: () => undefined, busy: false };

function check(name, htmlGetter) {
  let html;
  try {
    html = htmlGetter();
  } catch (e) {
    console.log(name + ': FAILED to build html — ' + e.message);
    return;
  }
  const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) { console.log(name + ': no <script> found'); return; }
  try {
    new vm.Script(m[1]);
    console.log(name + ': script syntax OK (' + m[1].length + ' chars)');
  } catch (e) {
    process.exitCode = 1;
    console.log(name + ': SYNTAX ERROR — ' + e.message);
    const lines = m[1].split('\n');
    const ln = parseInt(/:(\d+)/.exec(e.stack || '')?.[1] || '0', 10);
    for (let i = Math.max(0, ln - 3); i < Math.min(lines.length, ln + 2); i++) {
      console.log('   ' + (i + 1) + ': ' + lines[i]);
    }
  }
}

const { JobsViewProvider } = require(base + 'jobsView.js');
check('jobsView', () => new JobsViewProvider(stubSsh, stubMon, stubMem).html());

const { PipelineViewProvider } = require(base + 'pipelineView.js');
check('pipelineView', () => new PipelineViewProvider(stubSsh, { onDidChange: eventFn, getState: () => ({ active: false, steps: [] }) }).html());

const { ClusterViewProvider } = require(base + 'clusterView.js');
check('clusterView', () => new ClusterViewProvider(stubSsh, { onDidUpdate: eventFn, getSnapshot: () => ({}) , refreshNow: async()=>{} }, stubSvc, stubSvc, stubMem).html());

const { JobOutputPanel } = require(base + 'jobOutputPanel.js');
check('jobOutputPanel', () => {
  const p = Object.create(JobOutputPanel.prototype);
  return p.html ? p.html() : (JobOutputPanel.prototype.html.call(p));
});

const { LaunchPanel } = require(base + 'launchPanel.js');
check('launchPanel', () => LaunchPanel.prototype.html.call(Object.create(LaunchPanel.prototype)));

const { JobSummaryPanel } = require(base + 'jobSummaryPanel.js');
check('jobSummaryPanel', () => JobSummaryPanel.prototype.html.call(Object.create(JobSummaryPanel.prototype)));

const { ProjectManagerPanel } = require(base + 'projectManager.js');
check('projectManager', () => ProjectManagerPanel.prototype.html.call(Object.create(ProjectManagerPanel.prototype)));

const { ProjectsViewProvider } = require(base + 'projectsView.js');
check('projectsView', () => new ProjectsViewProvider(stubSsh, { onDidUpdate: eventFn, getSnapshot: () => undefined, currentProjectName: () => 'p' }, { onDidUpdate: eventFn, getSnapshot: () => ({ storage: [] }) }).html());

const { AtlasPanel } = require(base + 'atlasPanel.js');
check('atlasPanel', () => AtlasPanel.prototype.html.call(Object.create(AtlasPanel.prototype)));

