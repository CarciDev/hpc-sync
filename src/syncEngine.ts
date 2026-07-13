import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import ignore, { Ignore } from 'ignore';
import { getConfig, HpcConfig, shq } from './config';
import { log } from './log';
import { stripMountEnvBlock } from './projectConfig';
import { SshManager } from './sshManager';

export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface SyncStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  /** 0..1 when a determinate progress bar makes sense (upload, file sync). */
  progress?: number;
}

export interface SyncState {
  active: boolean;
  dryRun: boolean;
  title: string;
  steps: SyncStep[];
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface SyncOptions {
  forceRebuild?: boolean;
  dryRun?: boolean;
  /** e.g. "train.py --epochs 10" — executed inside the container after syncing. */
  runCmd?: string;
  /** Overrides hpcSync.outputDir for this run (set by the Launch panel). */
  runOutputDir?: string;
  /** Workspace-relative path of an sbatch script to submit after syncing. */
  submitScript?: string;
  /** A generated sbatch script (from the Launch panel) to upload and submit. */
  submitGenerated?: { name: string; content: string };
}

interface LocalFile {
  abs: string;
  rel: string;
  size: number;
  mtimeMs: number;
}

class CancelledError extends Error {
  constructor() {
    super('Cancelled by user');
  }
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (n >= 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (n >= 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${n} B`;
}

function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) {
    return `${sec}s`;
  }
  const m = Math.floor(sec / 60);
  if (m < 60) {
    return `${m}m ${sec % 60}s`;
  }
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Rolling-window transfer speed / ETA estimator. */
class TransferMeter {
  private samples: Array<{ t: number; b: number }> = [];
  private readonly windowMs = 12000;

  update(totalBytes: number): void {
    const now = Date.now();
    this.samples.push({ t: now, b: totalBytes });
    while (this.samples.length > 2 && now - this.samples[0].t > this.windowMs) {
      this.samples.shift();
    }
  }

  bps(): number {
    if (this.samples.length < 2) {
      return 0;
    }
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    return dt > 0.5 ? Math.max(0, (last.b - first.b) / dt) : 0;
  }

  /** "12.3 MB/s · ~2m 10s left" (or '' until enough samples). */
  describe(transferred: number, total: number): string {
    const speed = this.bps();
    if (speed <= 0) {
      return '';
    }
    let out = ` · ${fmtBytes(speed)}/s`;
    if (total > transferred) {
      out += ` · ~${fmtDuration((total - transferred) / speed)} left`;
    }
    return out;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export class SyncEngine implements vscode.Disposable {
  private state: SyncState = { active: false, dryRun: false, title: '', steps: [] };
  private cancelRequested = false;
  private currentChild?: ChildProcess;
  private progressReporter?: vscode.Progress<{ message?: string }>;

  private readonly changeEmitter = new vscode.EventEmitter<SyncState>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly ssh: SshManager,
    private readonly onJobSubmitted?: (jobId: string) => void,
    private readonly recordJobOutput?: (jobId: string, outPath: string) => void
  ) {}

  getState(): SyncState {
    return this.state;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  cancel(): void {
    if (!this.state.active || this.cancelRequested) {
      return;
    }
    this.cancelRequested = true;
    this.currentChild?.kill();
    // Abort any in-flight SFTP upload instead of waiting for the file to finish.
    this.ssh.interruptSftp();
    log.appendLine('[sync] cancellation requested');
  }

  private fire(): void {
    this.changeEmitter.fire(this.state);
  }

  private throwIfCancelled(): void {
    if (this.cancelRequested) {
      throw new CancelledError();
    }
  }

  private async step<T>(
    id: string,
    label: string,
    fn: (s: SyncStep) => Promise<T>
  ): Promise<T> {
    this.throwIfCancelled();
    const s: SyncStep = { id, label, status: 'running' };
    this.state.steps.push(s);
    this.fire();
    this.progressReporter?.report({ message: label });
    log.appendLine(`\n== ${label} ==`);
    try {
      const result = await fn(s);
      if (s.status === 'running') {
        s.status = 'done';
      }
      this.fire();
      return result;
    } catch (e) {
      // A transfer killed by cancel() surfaces as a channel error — report it
      // as a cancellation, not a failure.
      const err = this.cancelRequested && !(e instanceof CancelledError) ? new CancelledError() : e;
      s.status = 'error';
      s.detail = (err as Error).message;
      this.fire();
      throw err;
    }
  }

  private skipStep(id: string, label: string, detail: string): void {
    this.state.steps.push({ id, label, status: 'skipped', detail });
    log.appendLine(`\n== ${label} == (skipped: ${detail})`);
    this.fire();
  }

  async sync(opts: SyncOptions = {}): Promise<void> {
    if (this.state.active) {
      void vscode.window.showWarningMessage('HPC Sync: an operation is already running.');
      return;
    }
    const cfg = getConfig();
    if (!cfg.localProjectDir) {
      void vscode.window.showErrorMessage('HPC Sync: open the project folder as a workspace first.');
      return;
    }

    this.cancelRequested = false;
    const titleBits: string[] = [];
    if (opts.dryRun) {
      titleBits.push('Dry run');
    } else if (opts.forceRebuild) {
      titleBits.push('Force rebuild');
    } else {
      titleBits.push('Sync');
    }
    if (opts.runCmd) {
      titleBits.push(`then run ${opts.runCmd}`);
    }
    if (opts.submitScript) {
      titleBits.push(`then sbatch ${opts.submitScript}`);
    }
    if (opts.submitGenerated) {
      titleBits.push(`then sbatch ${opts.submitGenerated.name}`);
    }
    this.state = {
      active: true,
      dryRun: !!opts.dryRun,
      title: titleBits.join(' — '),
      steps: [],
      startedAt: Date.now(),
    };
    this.fire();
    log.appendLine(`\n════════ ${this.state.title} — ${new Date().toLocaleTimeString()} ════════`);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'HPC Sync',
          cancellable: true,
        },
        async (progress, token) => {
          this.progressReporter = progress;
          token.onCancellationRequested(() => this.cancel());
          await this.runPipeline(cfg, opts);
        }
      );
      const secs = ((Date.now() - (this.state.startedAt ?? Date.now())) / 1000).toFixed(0);
      log.appendLine(`\n== Done in ${secs}s ==`);
    } catch (e) {
      const msg = (e as Error).message;
      this.state.error = msg;
      if (e instanceof CancelledError) {
        log.appendLine('[sync] cancelled');
      } else {
        log.appendLine(`[sync] FAILED: ${msg}`);
        const buttons = msg.includes('docker CLI not found')
          ? ['Mark Env As Built', 'Show Log']
          : ['Show Log'];
        void vscode.window.showErrorMessage(`HPC Sync failed: ${msg}`, ...buttons).then((pick) => {
          if (pick === 'Mark Env As Built') {
            void vscode.commands.executeCommand('hpcSync.markEnvBuilt');
          } else if (pick === 'Show Log') {
            log.show(true);
          }
        });
      }
    } finally {
      this.progressReporter = undefined;
      this.state.active = false;
      this.state.finishedAt = Date.now();
      this.fire();
    }
  }

  private async runPipeline(cfg: HpcConfig, opts: SyncOptions): Promise<void> {
    await this.step('connect', `Connect to ${cfg.user}@${cfg.host}`, async (s) => {
      await this.ssh.ensureConnected();
      s.detail = 'single session reused for all steps and job polling (2FA once)';
    });

    // ── Change detection (mirrors needs_rebuild in hpc-sync.sh) ──
    const envHash = this.computeEnvHash(cfg);
    let rebuild = false;
    let reason = '';
    await this.step('detect', 'Detect environment changes', async (s) => {
      if (opts.forceRebuild) {
        rebuild = true;
        reason = 'forced rebuild requested';
      } else if (!fs.existsSync(cfg.stateFile)) {
        rebuild = true;
        reason = 'no prior sync state';
      } else if (fs.readFileSync(cfg.stateFile, 'utf8').trim() !== envHash) {
        rebuild = true;
        reason = 'Dockerfile / requirements.txt changed';
      }
      s.detail = rebuild ? `SLOW PATH — ${reason}` : 'FAST PATH — no environment changes';
    });

    if (rebuild) {
      await this.slowPath(cfg, envHash, opts.dryRun === true);
    } else {
      this.skipStep('rebuild', 'Rebuild container image (.sif)', 'environment unchanged');
    }

    await this.fastPath(cfg, opts.dryRun === true);

    if (opts.runCmd) {
      await this.runOnHpc(cfg, opts.runCmd, opts.dryRun === true, opts.runOutputDir);
    }
    if (opts.submitScript) {
      await this.submitSbatch(cfg, opts.submitScript, opts.dryRun === true);
    }
    if (opts.submitGenerated) {
      await this.submitGeneratedJob(cfg, opts.submitGenerated, opts.dryRun === true);
    }
  }

  // ───────────────────────────── SLOW PATH ─────────────────────────────

  private async slowPath(cfg: HpcConfig, envHash: string, dryRun: boolean): Promise<void> {
    if (!cfg.dockerImageName) {
      throw new Error('Set hpcSync.dockerImageName before rebuilding (run "docker images" to find it).');
    }
    const home = await this.ssh.getHomeDir();
    const remoteTar = `${home}/${cfg.tarName}`;
    const sifDir = await this.ssh.expandRemotePath(cfg.remoteSifDir);
    const sifPath = `${sifDir}/${cfg.sifName}`;

    const tarAlreadyUploaded =
      fs.existsSync(cfg.tarStateFile) &&
      fs.readFileSync(cfg.tarStateFile, 'utf8').trim() === envHash;

    if (tarAlreadyUploaded) {
      this.skipStep('export', 'Export Docker image', 'tar already uploaded in a previous run');
      this.skipStep('upload', 'Upload image tar', 'tar already on HPC');
    } else {
      const localTar = path.join(os.tmpdir(), cfg.tarName);

      await this.step('export', `Export Docker image ${cfg.dockerImageName}`, async (s) => {
        if (dryRun) {
          s.status = 'done';
          s.detail = `[dry-run] docker save ${cfg.dockerImageName} -o ${localTar}`;
          return;
        }
        const expected = await this.dockerImageSize(cfg.dockerImageName);
        const meter = new TransferMeter();
        await this.dockerSave(cfg.dockerImageName, localTar, (bytes) => {
          meter.update(bytes);
          if (expected > 0) {
            s.progress = Math.min(bytes / expected, 0.99);
            s.detail = `${fmtBytes(bytes)} / ~${fmtBytes(expected)}${meter.describe(bytes, expected)}`;
            this.fire();
          }
        });
        s.progress = 1;
        s.detail = fmtBytes(fs.statSync(localTar).size);
      });

      await this.step('upload', `Upload image tar to ${cfg.host}`, async (s) => {
        if (dryRun) {
          s.status = 'done';
          s.detail = `[dry-run] sftp put ${localTar} -> ${remoteTar}`;
          return;
        }
        let lastFired = 0;
        const meter = new TransferMeter();
        await this.ssh.uploadFile(localTar, remoteTar, (transferred, total) => {
          meter.update(transferred);
          s.progress = total > 0 ? transferred / total : undefined;
          const now = Date.now();
          if (now - lastFired > 300) {
            lastFired = now;
            const speedEta = meter.describe(transferred, total);
            s.detail = `${fmtBytes(transferred)} / ${fmtBytes(total)}${speedEta}`;
            this.progressReporter?.report({
              message: `Uploading tar — ${Math.round((s.progress ?? 0) * 100)}%${speedEta}`,
            });
            this.fire();
          }
        });
        s.progress = 1;
        fs.rmSync(localTar, { force: true });
        fs.writeFileSync(cfg.tarStateFile, envHash);
        s.detail = 'uploaded, local tar removed';
      });
    }

    await this.step('build', 'Build .sif with Apptainer on HPC', async (s) => {
      const cmd = `${cfg.apptainerLoad} && mkdir -p ${shq(sifDir)} && apptainer build --force ${shq(
        sifPath
      )} docker-archive://${shq(remoteTar)}`;
      if (dryRun) {
        s.status = 'done';
        s.detail = `[dry-run] ssh: ${cmd}`;
        return;
      }
      let lastLine = '';
      const onData = (chunk: string) => {
        log.append(chunk);
        const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length) {
          lastLine = lines[lines.length - 1];
          s.detail = lastLine.length > 90 ? lastLine.slice(0, 90) + '…' : lastLine;
          this.fire();
        }
      };
      await this.ssh.execChecked(cmd, { onStdout: onData, onStderr: onData });
      fs.writeFileSync(cfg.stateFile, envHash);
      fs.rmSync(cfg.tarStateFile, { force: true });
      s.detail = `built ${sifPath}`;
    });
  }

  private async dockerImageSize(image: string): Promise<number> {
    try {
      const out = await this.runLocal('docker', ['image', 'inspect', '--format', '{{.Size}}', image]);
      return parseInt(out.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  private async dockerSave(
    image: string,
    outPath: string,
    onProgress: (bytes: number) => void
  ): Promise<void> {
    fs.rmSync(outPath, { force: true });
    const poll = setInterval(() => {
      try {
        onProgress(fs.statSync(outPath).size);
      } catch {
        /* file not created yet */
      }
    }, 500);
    try {
      await this.runLocal('docker', ['save', image, '-o', outPath]);
    } finally {
      clearInterval(poll);
    }
  }

  private runLocal(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      log.appendLine(`  $ ${command} ${args.join(' ')}`);
      const child = spawn(command, args, { windowsHide: true });
      this.currentChild = child;
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (e) => {
        this.currentChild = undefined;
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' && command === 'docker') {
          reject(
            new Error(
              'docker CLI not found where the extension is running (dev container?). ' +
                'Options: run "HPC Sync: Mark Environment As Built" if the .sif on the cluster is already current, ' +
                'add the docker-outside-of-docker feature to devcontainer.json, or sync from a local VS Code window.'
            )
          );
        } else {
          reject(new Error(`Failed to run ${command}: ${e.message}`));
        }
      });
      child.on('close', (code) => {
        this.currentChild = undefined;
        if (this.cancelRequested) {
          reject(new CancelledError());
        } else if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${command} exited with ${code}: ${stderr.trim().split('\n').slice(-3).join('\n')}`));
        }
      });
    });
  }

  // ───────────────────────────── FAST PATH ─────────────────────────────

  private async fastPath(cfg: HpcConfig, dryRun: boolean): Promise<void> {
    await this.step('scripts', 'Sync project scripts (rsync-style over SFTP)', async (s) => {
      const remoteBase = await this.ssh.expandRemotePath(cfg.remoteProjectDir);
      const { files, skippedDirs } = this.collectLocalFiles(cfg.localProjectDir, cfg.excludes);
      if (skippedDirs.length > 0) {
        for (const d of skippedDirs) {
          log.appendLine(`  ⚠ unreadable, NOT synced: ${d}`);
        }
        void vscode.window.showWarningMessage(
          `HPC Sync: ${skippedDirs.length} director${skippedDirs.length === 1 ? 'y is' : 'ies are'} unreadable and NOT synced (see log): ${skippedDirs
            .slice(0, 3)
            .join(', ')}${skippedDirs.length > 3 ? '…' : ''}`
        );
      }
      s.detail = `scanning ${files.length} local files…`;
      this.fire();

      const sftp = await this.ssh.getSftp();
      const remoteStat = (p: string) =>
        new Promise<{ size: number; mtime: number } | undefined>((resolve) => {
          sftp.stat(p, (err, st) => {
            if (err || !st) {
              resolve(undefined);
            } else {
              resolve({ size: st.size, mtime: st.mtime });
            }
          });
        });

      const toUpload: LocalFile[] = [];
      await mapLimit(files, 8, async (f) => {
        this.throwIfCancelled();
        const st = await remoteStat(`${remoteBase}/${f.rel}`);
        const localMtimeSec = Math.floor(f.mtimeMs / 1000);
        // Exact mtime compare: we stamp the remote copy with the local mtime
        // after upload, so ANY local change (even 1s later, same size) shows
        // as a mismatch. A tolerance window here caused same-size edits to be
        // skipped forever.
        if (!st || st.size !== f.size || localMtimeSec !== st.mtime) {
          toUpload.push(f);
        }
      });

      toUpload.sort((a, b) => a.rel.localeCompare(b.rel));

      if (toUpload.length === 0) {
        s.detail = `up to date (${files.length} files checked)`;
        return;
      }

      if (dryRun) {
        s.status = 'done';
        s.detail = `[dry-run] ${toUpload.length} of ${files.length} files would upload`;
        for (const f of toUpload.slice(0, 200)) {
          log.appendLine(`  [dry-run] would upload ${f.rel}`);
        }
        return;
      }

      const dirs = Array.from(
        new Set(
          toUpload
            .map((f) => path.posix.dirname(`${remoteBase}/${f.rel}`))
            .filter((d) => d && d !== '.')
        )
      );
      if (dirs.length) {
        await this.ssh.execChecked(`mkdir -p ${dirs.map(shq).join(' ')}`);
      }

      // Guard against accidentally syncing large data into the home quota.
      const totalBytesPlanned = toUpload.reduce((acc, f) => acc + f.size, 0);
      if (totalBytesPlanned > cfg.confirmUploadOverMB * 1024 * 1024) {
        const biggest = [...toUpload]
          .sort((a, b) => b.size - a.size)
          .slice(0, 5)
          .map((f) => `${f.rel} (${fmtBytes(f.size)})`)
          .join('\n');
        const pick = await vscode.window.showWarningMessage(
          `This sync would upload ${fmtBytes(totalBytesPlanned)} in ${toUpload.length} files to ` +
            `${cfg.remoteProjectDir} — that filesystem may have a small quota.\n\nLargest files:\n${biggest}\n\n` +
            'Large data caches usually should not be synced — add them to .gitignore or hpcSync.excludes.',
          { modal: true },
          'Upload anyway'
        );
        if (pick !== 'Upload anyway') {
          throw new CancelledError();
        }
      }

      let done = 0;
      const totalBytes = totalBytesPlanned;
      let uploadedBefore = 0;
      const meter = new TransferMeter();
      let lastFired = 0;
      for (const f of toUpload) {
        this.throwIfCancelled();
        const remotePath = `${remoteBase}/${f.rel}`;
        await this.ssh.uploadFile(f.abs, remotePath, (transferred) => {
          const cum = uploadedBefore + transferred;
          meter.update(cum);
          const now = Date.now();
          if (now - lastFired > 300) {
            lastFired = now;
            s.progress = totalBytes > 0 ? cum / totalBytes : undefined;
            s.detail = `${done + 1}/${toUpload.length} — ${f.rel}${meter.describe(cum, totalBytes)}`;
            this.fire();
          }
        });
        const mtimeSec = Math.floor(f.mtimeMs / 1000);
        await new Promise<void>((resolve) => {
          sftp.utimes(remotePath, mtimeSec, mtimeSec, () => resolve());
        });
        uploadedBefore += f.size;
        done++;
        s.progress = totalBytes > 0 ? uploadedBefore / totalBytes : done / toUpload.length;
        s.detail = `${done}/${toUpload.length} — ${f.rel}${meter.describe(uploadedBefore, totalBytes)}`;
        this.progressReporter?.report({
          message: `Syncing scripts ${done}/${toUpload.length}${meter.describe(uploadedBefore, totalBytes)}`,
        });
        this.fire();
        log.appendLine(`  ↑ ${f.rel} (${fmtBytes(f.size)})`);
      }
      s.detail = `${toUpload.length} files uploaded, ${fmtBytes(totalBytes)} (${files.length} checked)`;
    });
  }

  private collectLocalFiles(
    root: string,
    extraExcludes: string[] = []
  ): { files: LocalFile[]; skippedDirs: string[] } {
    const results: LocalFile[] = [];
    const skippedDirs: string[] = [];
    const igStack: { base: string; ig: Ignore }[] = [];
    if (extraExcludes.length > 0) {
      igStack.push({ base: root, ig: ignore().add(extraExcludes) });
    }

    const isIgnored = (abs: string, isDir: boolean): boolean => {
      for (const { base, ig } of igStack) {
        const rel = path.relative(base, abs).split(path.sep).join('/');
        if (!rel || rel.startsWith('..')) {
          continue;
        }
        if (ig.ignores(rel) || (isDir && ig.ignores(rel + '/'))) {
          return true;
        }
      }
      return false;
    };

    const visit = (dir: string) => {
      const localIg = ignore();
      let hasRules = false;
      for (const name of ['.gitignore', '.dockerignore']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) {
          localIg.add(fs.readFileSync(p, 'utf8'));
          hasRules = true;
        }
      }
      if (hasRules) {
        igStack.push({ base: dir, ig: localIg });
      }
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        // Never drop a subtree silently — the caller warns the user.
        skippedDirs.push(path.relative(root, dir) || dir);
      }
      for (const entry of entries) {
        // same exclusions as hpc-sync.sh: .gitignore/.dockerignore filters + .git + .devcontainer
        if (entry.name === '.git' || entry.name === '.devcontainer') {
          continue;
        }
        const abs = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        const isDir = entry.isDirectory();
        if (isIgnored(abs, isDir)) {
          continue;
        }
        if (isDir) {
          visit(abs);
        } else if (entry.isFile()) {
          try {
            const st = fs.statSync(abs);
            results.push({
              abs,
              rel: path.relative(root, abs).split(path.sep).join('/'),
              size: st.size,
              mtimeMs: st.mtimeMs,
            });
          } catch {
            /* vanished */
          }
        }
      }
      if (hasRules) {
        igStack.pop();
      }
    };

    visit(root);
    return { files: results, skippedDirs };
  }

  // ───────────────────────────── RUN / SBATCH ─────────────────────────────

  private async runOnHpc(
    cfg: HpcConfig,
    runCmd: string,
    dryRun: boolean,
    outputDirOverride?: string
  ): Promise<void> {
    await this.step('run', `Run on HPC: ${runCmd}`, async (s) => {
      const remoteBase = await this.ssh.expandRemotePath(cfg.remoteProjectDir);
      const sifDir = await this.ssh.expandRemotePath(cfg.remoteSifDir);
      const outputDir = await this.ssh.expandRemotePath(outputDirOverride ?? cfg.outputDir);
      const cmd =
        `mkdir -p ${shq(outputDir)} && ${cfg.apptainerLoad} && apptainer exec` +
        ` --bind ${shq(remoteBase)}:${shq(cfg.containerWorkdir)}` +
        ` --env OUTPUT_DIR=${shq(outputDir)}` +
        ` --env PYTHONUNBUFFERED=1` +
        ` ${shq(`${sifDir}/${cfg.sifName}`)}` +
        ` python -u ${cfg.containerWorkdir}/${runCmd}`;
      if (dryRun) {
        s.status = 'done';
        s.detail = `[dry-run] ssh: ${cmd}`;
        return;
      }
      log.show(true);
      let lastLine = '';
      const onData = (chunk: string) => {
        log.append(chunk);
        const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length) {
          lastLine = lines[lines.length - 1];
          s.detail = lastLine.length > 90 ? lastLine.slice(0, 90) + '…' : lastLine;
          this.fire();
        }
      };
      await this.ssh.execChecked(cmd, { onStdout: onData, onStderr: onData });
      s.detail = 'finished OK';
    });
  }

  private async submitSbatch(cfg: HpcConfig, script: string, dryRun: boolean): Promise<void> {
    await this.step('sbatch', `Submit Slurm job: ${script}`, async (s) => {
      const remoteBase = await this.ssh.expandRemotePath(cfg.remoteProjectDir);
      const cmd = `cd ${shq(remoteBase)} && sbatch ${shq(script)}`;
      if (dryRun) {
        s.status = 'done';
        s.detail = `[dry-run] ssh: ${cmd}`;
        return;
      }
      const res = await this.ssh.execChecked(cmd, {
        onStdout: (c) => log.append(c),
        onStderr: (c) => log.append(c),
      });
      const m = res.stdout.match(/Submitted batch job (\d+)/);
      const jobId = m?.[1];
      s.detail = jobId ? `submitted as job ${jobId}` : res.stdout.trim();
      if (jobId) {
        // Remember where the job's stdout lands so the console panel can find
        // it even after the job leaves squeue/scontrol.
        try {
          const localScript = path.join(cfg.localProjectDir, script);
          const text = fs.existsSync(localScript) ? fs.readFileSync(localScript, 'utf8') : '';
          let out = /^#SBATCH\s+(?:--output[= ]|-o[= ])(.+)$/m.exec(text)?.[1]?.trim();
          if (out) {
            if (!out.startsWith('/') && !out.startsWith('$')) {
              out = `${remoteBase}/${out}`;
            }
          } else {
            out = `${remoteBase}/slurm-${jobId}.out`;
          }
          this.recordJobOutput?.(jobId, out.replace(/%[jA]/g, jobId));
        } catch {
          /* best-effort */
        }
        this.onJobSubmitted?.(jobId);
        void vscode.window.showInformationMessage(`HPC Sync: submitted Slurm job ${jobId}`);
      }
    });
  }

  /**
   * Record the current Dockerfile/requirements.txt hash as already built,
   * so the next sync takes the fast path without rebuilding the .sif.
   */
  markEnvironmentBuilt(): void {
    const cfg = getConfig();
    if (!cfg.localProjectDir) {
      void vscode.window.showErrorMessage('HPC Sync: open the project folder as a workspace first.');
      return;
    }
    fs.writeFileSync(cfg.stateFile, this.computeEnvHash(cfg));
    fs.rmSync(cfg.tarStateFile, { force: true });
    log.appendLine(
      '[sync] environment marked as already built — the next sync will take the fast path.'
    );
    void vscode.window.showInformationMessage(
      'HPC Sync: current environment marked as built. Next sync will skip the .sif rebuild.'
    );
  }

  private async submitGeneratedJob(
    cfg: HpcConfig,
    gen: { name: string; content: string },
    dryRun: boolean
  ): Promise<void> {
    await this.step('sbatch', `Submit generated job: ${gen.name}`, async (s) => {
      const remoteBase = await this.ssh.expandRemotePath(cfg.remoteProjectDir);
      const jobsDir = `${remoteBase}/.hpcsync_jobs`;
      const scriptPath = `${jobsDir}/${gen.name}.sh`;
      let content = gen.content;
      if (dryRun) {
        s.status = 'done';
        s.detail = `[dry-run] would upload ${scriptPath} and sbatch it`;
        log.appendLine(`[dry-run] generated sbatch script:\n${content}`);
        return;
      }
      await this.ssh.execChecked(`mkdir -p ${shq(jobsDir)}`);
      // Slurm neither tilde- nor $VAR-expands #SBATCH directives, and it
      // silently fails the job at start if the --output directory is missing.
      // Expand the path ourselves and pre-create the directory.
      const outLine = /^#SBATCH --output=(.+)$/m.exec(content)?.[1]?.trim();
      if (outLine) {
        const expanded = await this.ssh.expandRemotePath(outLine);
        if (expanded && expanded !== outLine) {
          content = content.replace(/^#SBATCH --output=.*$/m, `#SBATCH --output=${expanded}`);
          log.appendLine(`  expanded --output for Slurm: ${expanded}`);
        }
        const outDir = path.posix.dirname(expanded || outLine);
        if (outDir && outDir !== '.' && outDir !== '/') {
          await this.ssh.execChecked(`mkdir -p ${shq(outDir)}`);
        }
      }
      await this.ssh.writeRemoteFile(scriptPath, content);
      log.appendLine(`  wrote ${scriptPath}`);
      let res;
      try {
        res = await this.ssh.execChecked(`cd ${shq(remoteBase)} && sbatch ${shq(scriptPath)}`, {
          onStdout: (c) => log.append(c),
          onStderr: (c) => log.append(c),
        });
      } catch (e) {
        const errMsg = (e as Error).message;
        if (!/CCDB|account|Unspecified error/i.test(errMsg)) {
          throw e;
        }
        // The scheduler rejected the account/association. Stop guessing:
        // probe the user's real associations with --test-only and offer a
        // validated alternative.
        s.detail = 'account rejected — probing your valid Slurm accounts…';
        this.fire();
        const orig = /^#SBATCH --account=(.+)$/m.exec(gen.content)?.[1]?.trim() ?? '';
        const assoc = await this.ssh.exec(
          `sacctmgr -n -P show assoc where user=$USER format=account`
        );
        const candidates = Array.from(
          new Set(
            assoc.stdout
              .split('\n')
              .map((l) => l.trim())
              .filter((a) => a && a !== 'root')
              .flatMap((a) => [a, a.replace(/_(cpu|gpu)$/i, '')])
          )
        );
        log.appendLine(`  [probe] associations: ${candidates.join(', ') || '(none found)'}`);
        // If even the original account passes --test-only, the failure was
        // not the account — surface that instead of switching accounts.
        if (orig) {
          const same = await this.ssh.exec(
            `cd ${shq(remoteBase)} && sbatch --test-only ${shq(scriptPath)}`
          );
          if (same.code === 0) {
            throw new Error(
              `sbatch rejected the job on real submission but --test-only passes — likely a transient scheduler issue, retry in a minute. Original error:\n${errMsg}`
            );
          }
        }
        const working: string[] = [];
        for (const a of candidates.filter((c) => c !== orig).slice(0, 8)) {
          const t = await this.ssh.exec(
            `cd ${shq(remoteBase)} && sbatch --test-only --account=${shq(a)} ${shq(scriptPath)}`
          );
          log.appendLine(`  [probe] --account=${a}: ${t.code === 0 ? 'OK' : 'rejected'}`);
          if (t.code === 0) {
            working.push(a);
          }
        }
        if (working.length === 0) {
          throw new Error(
            `${errMsg}\nNo account association validated with --test-only either — the job parameters themselves may be invalid for your allocations (e.g. GPUs on a CPU-only account, or time limit too long). Associations found: ${candidates.join(', ') || 'none'}.`
          );
        }
        const pick = await vscode.window.showWarningMessage(
          `The scheduler rejected account '${orig}'. These accounts validate for this job: ${working.join(', ')}. Submit with '${working[0]}'?`,
          { modal: true },
          `Submit with ${working[0]}`
        );
        if (!pick) {
          throw new Error(`Submission cancelled — account '${orig}' is not valid for this job.`);
        }
        res = await this.ssh.execChecked(
          `cd ${shq(remoteBase)} && sbatch --account=${shq(working[0])} ${shq(scriptPath)}`,
          { onStdout: (c) => log.append(c), onStderr: (c) => log.append(c) }
        );
        void vscode.window.showInformationMessage(
          `HPC Sync: '${working[0]}' worked — set it as the account in future launches (the panel dropdown will keep offering it).`
        );
      }
      const m = res.stdout.match(/Submitted batch job (\d+)/);
      const jobId = m?.[1];
      s.detail = jobId ? `submitted as job ${jobId}` : res.stdout.trim();
      if (jobId) {
        const outSpec = /^#SBATCH --output=(.+)$/m.exec(content)?.[1]?.trim();
        if (outSpec) {
          this.recordJobOutput?.(jobId, outSpec.replace(/%[jA]/g, jobId));
        }
        this.onJobSubmitted?.(jobId);
        void vscode.window.showInformationMessage(`HPC Sync: submitted Slurm job ${jobId} (${gen.name})`);
      }
    });
  }

  private computeEnvHash(cfg: HpcConfig): string {
    const files = [cfg.dockerfilePath, cfg.requirementsPath].filter((f) => f && fs.existsSync(f));
    if (files.length === 0) {
      return 'no-env-files';
    }
    const h = crypto.createHash('sha256');
    for (const f of files) {
      h.update(path.basename(f));
      h.update('\0');
      if (f === cfg.dockerfilePath) {
        // The managed mount-ENV block is metadata, not environment: editing
        // mounts must never force a .sif rebuild.
        h.update(stripMountEnvBlock(fs.readFileSync(f, 'utf8')));
      } else {
        h.update(fs.readFileSync(f));
      }
      h.update('\0');
    }
    return h.digest('hex');
  }
}
