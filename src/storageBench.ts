import * as vscode from 'vscode';
import { getConfig, shq } from './config';
import { log } from './log';
import { SshManager } from './sshManager';

export interface BenchResult {
  label: string;
  path: string;
  writeMBps?: number;
  readMBps?: number;
  note?: string;
}

export interface BenchSnapshot {
  ranAt: number;
  sizeMB: number;
  results: BenchResult[];
}

const BENCH_MB = 256;

/** Last "N MB/s" (or GB/s / kB/s) figure in dd's stderr output, in MB/s. */
export function parseDdSpeed(text: string): number | undefined {
  const re = /([\d.,]+)\s*(kB|KB|MB|GB)\/s/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | undefined;
  while ((m = re.exec(text)) !== null) {
    last = m;
  }
  if (!last) {
    return undefined;
  }
  const v = parseFloat(last[1].replace(',', '.'));
  if (Number.isNaN(v)) {
    return undefined;
  }
  const unit = last[2].toUpperCase();
  return unit === 'GB' ? v * 1000 : unit === 'KB' ? v / 1000 : v;
}

/**
 * Sequential read/write benchmark of each storage tier reachable from the
 * login node (home, scratch, project, node-local /tmp), using dd with
 * O_DIRECT when available to bypass the page cache. Results are cached per
 * cluster in extension global state.
 */
export class StorageBench implements vscode.Disposable {
  private _busy = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidUpdate = this.emitter.event;

  constructor(
    private readonly ssh: SshManager,
    private readonly memento: vscode.Memento
  ) {}

  get busy(): boolean {
    return this._busy;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private key(): string {
    return `hpcSync.storageBench.${getConfig().host}`;
  }

  get(): BenchSnapshot | undefined {
    return this.memento.get<BenchSnapshot>(this.key());
  }

  async run(): Promise<void> {
    if (this._busy) {
      return;
    }
    this._busy = true;
    this.emitter.fire();
    const cfg = getConfig();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'HPC Sync: storage benchmark' },
        async (progress) => {
          progress.report({ message: 'resolving storage paths…' });
          const env = await this.ssh.execChecked('echo "$HOME|$SCRATCH"');
          const [home, scratch] = env.stdout.trim().split('\n').pop()!.split('|');
          const candidates: Array<{ label: string; path: string }> = [];
          if (home) {
            candidates.push({ label: 'home', path: home });
          }
          if (scratch) {
            candidates.push({ label: 'scratch', path: scratch });
          }
          if (cfg.allocGroup && cfg.user) {
            candidates.push({ label: 'project', path: `/project/${cfg.allocGroup}/${cfg.user}` });
          }
          candidates.push({ label: 'login-node /tmp', path: '/tmp' });

          const results: BenchResult[] = [];
          for (const c of candidates) {
            progress.report({ message: `${c.label} (${BENCH_MB} MB write + read)…` });
            const usable = await this.ssh.exec(`test -d ${shq(c.path)} && test -w ${shq(c.path)}`);
            if (usable.code !== 0) {
              results.push({ ...c, note: 'not accessible / not writable' });
              continue;
            }
            const f = `${c.path}/.hpcsync_bench_${Date.now()}`;
            try {
              // timeout(1) guards against a loaded Lustre filesystem stalling
              // dd for minutes (observed on scratch) — give each attempt 60s.
              const wr = await this.ssh.exec(
                `timeout 60 dd if=/dev/zero of=${shq(f)} bs=4M count=${BENCH_MB / 4} oflag=direct 2>&1 || ` +
                  `timeout 60 dd if=/dev/zero of=${shq(f)} bs=4M count=${BENCH_MB / 4} conv=fdatasync 2>&1`
              );
              const writeMBps = parseDdSpeed(wr.stdout + wr.stderr);
              let readMBps: number | undefined;
              let note: string | undefined;
              if (writeMBps === undefined) {
                note =
                  wr.code === 124
                    ? 'write timed out (>60s) — filesystem heavily loaded right now'
                    : 'dd output not parseable';
              } else {
                const rd = await this.ssh.exec(
                  `timeout 60 dd if=${shq(f)} of=/dev/null bs=4M iflag=direct 2>&1 || ` +
                    `timeout 60 dd if=${shq(f)} of=/dev/null bs=4M 2>&1`
                );
                readMBps = parseDdSpeed(rd.stdout + rd.stderr);
                if (readMBps === undefined && rd.code === 124) {
                  note = 'read timed out (>60s) — filesystem heavily loaded right now';
                }
              }
              results.push({ ...c, writeMBps, readMBps, note });
              log.appendLine(
                `[bench] ${c.label} (${c.path}): write ${writeMBps?.toFixed(0) ?? '?'} MB/s, read ${readMBps?.toFixed(0) ?? '?'} MB/s`
              );
            } finally {
              await this.ssh.exec(`rm -f ${shq(f)}`);
            }
          }

          const snap: BenchSnapshot = { ranAt: Date.now(), sizeMB: BENCH_MB, results };
          await this.memento.update(this.key(), snap);
        }
      );
    } catch (e) {
      log.appendLine(`[bench] failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`HPC Sync: storage benchmark failed — ${(e as Error).message}`);
    } finally {
      this._busy = false;
      this.emitter.fire();
    }
  }
}
