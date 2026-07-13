import * as vscode from 'vscode';
import { parseUtcOffset } from './analytics';
import { getConfig } from './config';
import { log } from './log';
import { SshManager } from './sshManager';

export interface ActiveJob {
  id: string;
  name: string;
  state: string;
  elapsed: string;
  timeLimit: string;
  timeLeft: string;
  nodes: string;
  cpus: string;
  partition: string;
  reason: string;
  startTime: string;
  elapsedSec: number;
  limitSec: number;
  priority?: number;
  queuePos?: number;
  queueTotal?: number;
}

export interface RecentJob {
  id: string;
  name: string;
  state: string;
  elapsed: string;
  exitCode: string;
  end: string;
}

export interface JobsSnapshot {
  connected: boolean;
  active: ActiveJob[];
  recent: RecentJob[];
  updatedAt?: number;
  error?: string;
  pollIntervalSec: number;
  /** cluster UTC offset in minutes, for timezone-correct est-start countdowns */
  clusterUtcOffsetMin?: number;
}

/** Parse Slurm durations like 12:34, 1:02:03, 2-01:02:03, UNLIMITED. Returns -1 if unknown. */
export function parseSlurmDuration(s: string): number {
  const t = (s ?? '').trim();
  if (!t || /^(UNLIMITED|NOT_SET|INVALID|N\/A)$/i.test(t)) {
    return -1;
  }
  let days = 0;
  let rest = t;
  const dash = t.indexOf('-');
  if (dash > -1) {
    days = parseInt(t.slice(0, dash), 10) || 0;
    rest = t.slice(dash + 1);
  }
  const parts = rest.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) {
    return -1;
  }
  let sec = 0;
  if (parts.length === 3) {
    sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    sec = parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    sec = parts[0] * 60; // bare minutes
  }
  return days * 86400 + sec;
}

export class JobsMonitor implements vscode.Disposable {
  private timer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private clusterUtcOffsetMin?: number;
  private snapshot: JobsSnapshot = {
    connected: false,
    active: [],
    recent: [],
    pollIntervalSec: getConfig().jobsPollIntervalSeconds,
  };

  private readonly emitter = new vscode.EventEmitter<JobsSnapshot>();
  readonly onDidUpdate = this.emitter.event;

  constructor(private readonly ssh: SshManager) {
    ssh.onStatusChanged((status) => {
      if (status === 'connected') {
        this.start();
        void this.refreshNow();
      } else if (status === 'disconnected') {
        this.stop();
        this.snapshot = { ...this.snapshot, connected: false };
        this.emitter.fire(this.snapshot);
      }
    });
  }

  getSnapshot(): JobsSnapshot {
    return this.snapshot;
  }

  dispose(): void {
    this.stop();
    this.emitter.dispose();
  }

  start(): void {
    this.stop();
    this.clusterUtcOffsetMin = undefined; // refetch per connection (DST/host change)
    const intervalSec = getConfig().jobsPollIntervalSeconds;
    this.snapshot.pollIntervalSec = intervalSec;
    this.timer = setInterval(() => {
      void this.refreshNow();
    }, intervalSec * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async refreshNow(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    if (this.ssh.status !== 'connected') {
      this.snapshot = { ...this.snapshot, connected: false };
      this.emitter.fire(this.snapshot);
      return;
    }
    this.refreshing = true;
    const cfg = getConfig();
    try {
      if (this.clusterUtcOffsetMin === undefined) {
        try {
          const tz = await this.ssh.exec('date +%z');
          if (tz.code === 0) {
            this.clusterUtcOffsetMin = parseUtcOffset(tz.stdout.trim().split('\n').pop() ?? '');
          }
        } catch {
          /* offset stays undefined — view falls back to local parsing */
        }
      }
      const squeue = await this.ssh.exec(
        `squeue --me -h -o "%i|%j|%T|%M|%l|%L|%D|%C|%P|%R|%S|%Q"`
      );
      if (squeue.code !== 0) {
        throw new Error(`squeue failed: ${(squeue.stderr || squeue.stdout).trim().slice(0, 200)}`);
      }
      const active: ActiveJob[] = squeue.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const f = line.split('|');
          const elapsed = f[3] ?? '';
          const limit = f[4] ?? '';
          return {
            id: f[0] ?? '',
            name: f[1] ?? '',
            state: (f[2] ?? '').toUpperCase(),
            elapsed,
            timeLimit: limit,
            timeLeft: f[5] ?? '',
            nodes: f[6] ?? '',
            cpus: f[7] ?? '',
            partition: f[8] ?? '',
            reason: f[9] ?? '',
            startTime: f[10] ?? '',
            elapsedSec: parseSlurmDuration(elapsed),
            limitSec: parseSlurmDuration(limit),
            priority: Number.isNaN(parseInt(f[11] ?? '', 10)) ? undefined : parseInt(f[11], 10),
          };
        });

      // Queue position: rank my pending jobs against ALL pending jobs in the
      // same partition, sorted by Slurm priority.
      if (active.some((j) => j.state === 'PENDING')) {
        try {
          const allPd = await this.ssh.exec(`squeue -h -t PD -o "%i|%P|%Q"`);
          if (allPd.code === 0) {
            const byPartition = new Map<string, Array<{ id: string; prio: number }>>();
            for (const line of allPd.stdout.split('\n')) {
              const f = line.trim().split('|');
              if (f.length < 3) {
                continue;
              }
              let arr = byPartition.get(f[1]);
              if (!arr) {
                arr = [];
                byPartition.set(f[1], arr);
              }
              arr.push({ id: f[0], prio: parseInt(f[2], 10) || 0 });
            }
            for (const arr of byPartition.values()) {
              arr.sort((a, b) => b.prio - a.prio || (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0));
            }
            for (const j of active) {
              if (j.state !== 'PENDING') {
                continue;
              }
              const arr = byPartition.get(j.partition);
              if (!arr) {
                continue;
              }
              const idx = arr.findIndex((e) => e.id === j.id);
              if (idx >= 0) {
                j.queuePos = idx + 1;
                j.queueTotal = arr.length;
              }
            }
          }
        } catch {
          /* queue ranking is best-effort */
        }
      }

      let recent: RecentJob[] = [];
      try {
        const sacct = await this.ssh.exec(
          `sacct -X -n -P -o JobID,JobName%60,State,Elapsed,ExitCode,End -S now-${cfg.recentJobsHours}hours`
        );
        if (sacct.code === 0) {
          const activeIds = new Set(active.map((a) => a.id));
          recent = sacct.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((line) => {
              const f = line.split('|');
              return {
                id: f[0] ?? '',
                name: f[1] ?? '',
                state: (f[2] ?? '').toUpperCase(),
                elapsed: f[3] ?? '',
                exitCode: f[4] ?? '',
                end: f[5] ?? '',
              };
            })
            .filter((j) => !activeIds.has(j.id) && !/^(RUNNING|PENDING|REQUEUED)/.test(j.state))
            .reverse();
        }
      } catch {
        /* sacct is best-effort; accounting may be slow or disabled */
      }

      this.snapshot = {
        connected: true,
        active,
        recent,
        updatedAt: Date.now(),
        error: undefined,
        pollIntervalSec: cfg.jobsPollIntervalSeconds,
        clusterUtcOffsetMin: this.clusterUtcOffsetMin,
      };
    } catch (e) {
      this.snapshot = {
        ...this.snapshot,
        connected: this.ssh.status === 'connected',
        error: (e as Error).message,
        updatedAt: Date.now(),
      };
      log.appendLine(`[jobs] refresh failed: ${(e as Error).message}`);
    } finally {
      this.refreshing = false;
      this.emitter.fire(this.snapshot);
    }
  }
}
