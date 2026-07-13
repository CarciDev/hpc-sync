import * as path from 'path';
import * as vscode from 'vscode';
import { UsageAnalytics } from './analytics';
import { ClusterMonitor } from './clusterMonitor';
import { ClusterViewProvider } from './clusterView';
import { getConfig, shq } from './config';
import { JobOutputPanel } from './jobOutputPanel';
import { JobSummaryPanel } from './jobSummaryPanel';
import { JobsMonitor } from './jobsMonitor';
import { JobsViewProvider } from './jobsView';
import { LaunchPanel } from './launchPanel';
import { log } from './log';
import { PipelineViewProvider } from './pipelineView';
import { ProjectManagerPanel } from './projectManager';
import { setupCommand } from './setup';
import { SshManager } from './sshManager';
import { StorageBench } from './storageBench';
import { SyncEngine } from './syncEngine';

export function activate(context: vscode.ExtensionContext): void {
  const ssh = new SshManager(getConfig, context.globalState);
  const monitor = new JobsMonitor(ssh);
  const cluster = new ClusterMonitor(ssh);
  const analytics = new UsageAnalytics(ssh, context.globalState);
  const bench = new StorageBench(ssh, context.globalState);
  // Per-host, insertion-ordered store: numeric job IDs collide across
  // clusters, and object-key eviction would delete the LOWEST id, not the
  // oldest entry.
  const outputsKey = () => `hpcSync.jobOutputs.${getConfig().host}`;
  const recordJobOutput = (jobId: string, outPath: string) => {
    const arr = context.globalState
      .get<Array<{ id: string; path: string }>>(outputsKey(), [])
      .filter((e) => e.id !== jobId);
    arr.push({ id: jobId, path: outPath });
    while (arr.length > 100) {
      arr.shift();
    }
    void context.globalState.update(outputsKey(), arr);
  };
  const engine = new SyncEngine(ssh, () => void monitor.refreshNow(), recordJobOutput);
  const pipelineView = new PipelineViewProvider(ssh, engine);
  const jobsView = new JobsViewProvider(ssh, monitor, context.globalState);
  const clusterView = new ClusterViewProvider(ssh, cluster, analytics, bench, context.globalState);

  // Refresh the (cached) submission pattern in the background once connected.
  context.subscriptions.push(
    ssh.onStatusChanged((s) => {
      if (s === 'connected') {
        void analytics.ensure(false);
      }
    })
  );

  context.subscriptions.push(
    ssh,
    monitor,
    cluster,
    analytics,
    bench,
    engine,
    vscode.window.registerWebviewViewProvider(PipelineViewProvider.viewId, pipelineView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(JobsViewProvider.viewId, jobsView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ClusterViewProvider.viewId, clusterView, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Refresh the Project paths widget when .hpcproject.json changes.
  const projWatcher = vscode.workspace.createFileSystemWatcher('**/.hpcproject.json');
  context.subscriptions.push(
    projWatcher,
    projWatcher.onDidChange(() => clusterView.postState()),
    projWatcher.onDidCreate(() => clusterView.postState()),
    projWatcher.onDidDelete(() => clusterView.postState())
  );

  // ── Status bar: connection + live job counts ──
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'hpcSync.jobs.focus';
  context.subscriptions.push(statusItem);

  const updateStatusBar = () => {
    const snap = monitor.getSnapshot();
    if (ssh.status === 'connected') {
      const running = snap.active.filter((j) => j.state === 'RUNNING').length;
      const pending = snap.active.filter((j) => j.state === 'PENDING').length;
      statusItem.text = `$(server) HPC ✓ ${running}R ${pending}PD`;
      statusItem.tooltip = `Connected to ${ssh.target} — ${running} running, ${pending} pending. Click for jobs.`;
    } else if (ssh.status === 'disconnected') {
      statusItem.text = '$(server) HPC: off';
      statusItem.tooltip = 'HPC Sync: not connected. Click to open the jobs view.';
    } else {
      statusItem.text = '$(server) HPC: connecting…';
      statusItem.tooltip = 'HPC Sync: authenticating (answer the 2FA prompt).';
    }
    statusItem.show();
  };
  updateStatusBar();
  context.subscriptions.push(
    ssh.onStatusChanged(updateStatusBar),
    monitor.onDidUpdate(updateStatusBar)
  );

  // Restart the poll timer when its interval setting changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hpcSync.jobsPollIntervalSeconds') && ssh.status === 'connected') {
        monitor.start();
      }
      if (e.affectsConfiguration('hpcSync.clusterPollIntervalSeconds') && ssh.status === 'connected') {
        cluster.start();
      }
    })
  );

  // ── Commands ──
  const register = (id: string, fn: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // Slurm job IDs are numeric with optional array/step suffixes. Reject
  // anything else before it reaches an unquoted `scontrol/scancel <id>`.
  const validJobId = (id: unknown): id is string =>
    typeof id === 'string' && /^\d+(?:_\d+)?(?:\.\w+)?$/.test(id);

  register('hpcSync.connect', async () => {
    try {
      await ssh.ensureConnected();
    } catch (e) {
      const choice = await vscode.window.showErrorMessage(
        `HPC Sync: connection failed — ${(e as Error).message}`,
        'Setup SSH',
        'Show Log'
      );
      if (choice === 'Setup SSH') {
        void vscode.commands.executeCommand('hpcSync.setup');
      } else if (choice === 'Show Log') {
        log.show(true);
      }
    }
  });

  register('hpcSync.setup', () => void setupCommand(ssh));
  register('hpcSync.projectManager', () => ProjectManagerPanel.show(ssh, engine, context.globalState));

  register('hpcSync.disconnect', () => ssh.disconnect());

  register('hpcSync.sync', () => void engine.sync());
  register('hpcSync.markEnvBuilt', async () => {
    const pick = await vscode.window.showWarningMessage(
      'Mark the current Dockerfile / requirements.txt as already built on the cluster? ' +
        'Only do this if the .sif on the HPC really matches your current environment — ' +
        'the next sync will skip the rebuild.',
      { modal: true },
      'Mark as built'
    );
    if (pick === 'Mark as built') {
      engine.markEnvironmentBuilt();
    }
  });
  register('hpcSync.forceRebuild', () => void engine.sync({ forceRebuild: true }));
  register('hpcSync.dryRun', () => void engine.sync({ dryRun: true }));
  register('hpcSync.cancelSync', () => engine.cancel());
  register('hpcSync.showLog', () => log.show(false));
  register('hpcSync.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:david-carciente.hpc-sync')
  );

  register('hpcSync.launch', async (uri?: vscode.Uri) => {
    const cfg = getConfig();
    if (!cfg.localProjectDir) {
      void vscode.window.showErrorMessage('HPC Sync: open the project folder as a workspace first.');
      return;
    }
    let fsPath = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!fsPath || !fsPath.endsWith('.py') || !fsPath.startsWith(cfg.localProjectDir)) {
      const uris = await vscode.workspace.findFiles('**/*.py', '**/node_modules/**', 500);
      const items = uris
        .map((u) => path.relative(cfg.localProjectDir, u.fsPath).split(path.sep).join('/'))
        .filter((r) => !r.startsWith('..'))
        .sort();
      const pick = await vscode.window.showQuickPick(items, {
        title: 'HPC Sync — launch which Python file?',
        ignoreFocusOut: true,
      });
      if (!pick) {
        return;
      }
      fsPath = path.join(cfg.localProjectDir, pick);
    }
    const rel = path.relative(cfg.localProjectDir, fsPath).split(path.sep).join('/');
    await LaunchPanel.open(rel, ssh, engine, cluster, analytics, bench);
  });

  register('hpcSync.run', async () => {
    const cmd = await vscode.window.showInputBox({
      title: 'HPC Sync — run script on HPC',
      prompt: 'Script (and args) to run inside the container after syncing',
      placeHolder: 'e.g. train.py --epochs 10',
      ignoreFocusOut: true,
    });
    if (cmd) {
      void engine.sync({ runCmd: cmd });
    }
  });

  register('hpcSync.submitJob', async () => {
    const uris = await vscode.workspace.findFiles('**/*.sh', '**/node_modules/**', 200);
    const cfg = getConfig();
    const items = uris
      .map((u) => path.relative(cfg.localProjectDir, u.fsPath).split(path.sep).join('/'))
      .filter((rel) => !rel.startsWith('..'))
      .sort((a, b) => {
        const aSlurm = a.toLowerCase().includes('slurm') ? 0 : 1;
        const bSlurm = b.toLowerCase().includes('slurm') ? 0 : 1;
        return aSlurm - bSlurm || a.localeCompare(b);
      });
    if (items.length === 0) {
      void vscode.window.showWarningMessage('HPC Sync: no .sh scripts found in the workspace.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'HPC Sync — submit Slurm job',
      placeHolder: 'Script to sbatch (synced first; runs from the remote project dir)',
      ignoreFocusOut: true,
    });
    if (pick) {
      void engine.sync({ submitScript: pick });
    }
  });

  register('hpcSync.refreshJobs', () => void monitor.refreshNow());
  register('hpcSync.refreshCluster', () => void cluster.refreshNow());
  register('hpcSync.rebuildUsagePattern', () => void analytics.ensure(true));
  register('hpcSync.benchmarkStorage', () => void bench.run());

  register('hpcSync.jobDetails', (jobId?: string) => {
    if (validJobId(jobId)) {
      JobSummaryPanel.show(jobId, ssh);
    }
  });

  const resolveJobStdout = async (jobId: string): Promise<string | undefined> => {
    const cfg = getConfig();
    const fname = `slurm-${jobId}.out`;
    const candidates: string[] = [];
    const add = (p?: string) => {
      if (p && p !== '(null)' && !candidates.includes(p)) {
        candidates.push(p);
      }
    };
    add(
      context.globalState
        .get<Array<{ id: string; path: string }>>(outputsKey(), [])
        .find((e) => e.id === jobId)?.path
    );
    const info = await ssh.exec(`scontrol show job ${jobId}`);
    add(/StdOut=(\S+)/.exec(info.stdout)?.[1]);
    const wd = /WorkDir=(\S+)/.exec(info.stdout)?.[1];
    if (wd) {
      add(`${wd}/${fname}`);
    }
    // Jobs built by the Launch panel default to <outputDir>/slurm-%j.out.
    try {
      add(`${await ssh.expandRemotePath(cfg.outputDir)}/${fname}`);
      add(`${await ssh.expandRemotePath(cfg.remoteProjectDir)}/${fname}`);
    } catch {
      /* not connected paths are checked below anyway */
    }
    const sa = await ssh.exec(`sacct -j ${jobId} -X -n -P -o WorkDir`);
    const w2 = sa.stdout.trim().split('\n')[0]?.trim();
    if (w2) {
      add(`${w2}/${fname}`);
    }
    // Return the first candidate that actually exists (guesses are worthless).
    if (candidates.length > 0) {
      const probe = await ssh.exec(
        `for p in ${candidates.map(shq).join(' ')}; do if [ -f "$p" ]; then echo "$p"; break; fi; done`
      );
      const hit = probe.stdout.trim().split('\n').pop()?.trim();
      if (hit) {
        return hit;
      }
    }
    // Last resort: shallow search of the likely output roots.
    try {
      const roots = [
        await ssh.expandRemotePath(cfg.outputDir),
        await ssh.expandRemotePath(cfg.remoteProjectDir),
        '$HOME',
        '$SCRATCH',
      ];
      const found = await ssh.exec(
        `find ${roots.map((r) => (r.startsWith('$') ? `"${r}"` : shq(r))).join(' ')} -maxdepth 3 -name ${shq(fname)} 2>/dev/null | head -n 1`
      );
      const hit = found.stdout.trim();
      if (hit) {
        return hit;
      }
    } catch {
      /* give up below */
    }
    return undefined;
  };

  register('hpcSync.jobOutput', (jobId?: string) => {
    if (!validJobId(jobId)) {
      return;
    }
    JobOutputPanel.show(jobId, ssh, resolveJobStdout, (id) =>
      monitor.getSnapshot().active.some((j) => j.id === id)
    );
  });

  register('hpcSync.cancelJob', async (jobId?: string) => {
    if (!validJobId(jobId)) {
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `Cancel Slurm job ${jobId}?`,
      { modal: true },
      'Cancel job'
    );
    if (pick !== 'Cancel job') {
      return;
    }
    try {
      await ssh.execChecked(`scancel ${jobId}`);
      void vscode.window.showInformationMessage(`HPC Sync: job ${jobId} cancelled.`);
      await monitor.refreshNow();
    } catch (e) {
      void vscode.window.showErrorMessage(`HPC Sync: ${(e as Error).message}`);
    }
  });

  log.appendLine('HPC Sync extension activated.');
}

export function deactivate(): void {
  /* disposables handle cleanup */
}
