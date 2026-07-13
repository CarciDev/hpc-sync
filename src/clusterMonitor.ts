import * as vscode from 'vscode';
import { getConfig } from './config';
import { parseSlurmDuration } from './jobsMonitor';
import { log } from './log';
import { SshManager } from './sshManager';

export interface FsUsage {
  label: string;
  used: string;
  quota: string;
  usedPct?: number;
  filesUsed?: string;
  filesQuota?: string;
  filesPct?: number;
}

export interface PartitionInfo {
  name: string;
  avail: string;
  totalNodes: number;
  idleNodes: number;
  mixedNodes: number;
  allocNodes: number;
  otherNodes: number;
}

export interface FairShareRow {
  account: string;
  user: string;
  normShares: number;
  rawUsage: number;
  effectvUsage: number;
  fairShare: number;
  /** effective usage / normalized share — >1 means using more than the fair share */
  ratio?: number;
}

export interface FairShareMeta {
  /** usage decay half-life in seconds (0/undefined = no decay configured) */
  halfLifeSec?: number;
  /** NONE | DAILY | WEEKLY | MONTHLY | QUARTERLY | YEARLY */
  resetPeriod?: string;
  /** epoch ms of the next hard reset, when resetPeriod is set */
  nextResetAt?: number;
  /** seconds until the tracked account's ratio decays back to 1.0 (only when ratio > 1 and decay mode) */
  ratioOneEtaSec?: number;
}

export interface ClusterSnapshot {
  connected: boolean;
  updatedAt?: number;
  error?: string;
  storage: FsUsage[];
  storageRaw?: string;
  storageError?: string;
  fairshare?: FairShareRow[];
  fairshareMeta?: FairShareMeta;
  cpu?: { alloc: number; idle: number; other: number; total: number };
  mem?: { allocMB: number; totalMB: number };
  gpu?: { used: number; total: number };
  nodeStates: Record<string, number>;
  partitions: PartitionInfo[];
  insights: string[];
  pollIntervalSec: number;
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  KB: 1000,
  KIB: 1024,
  M: 1024 ** 2,
  MB: 1000 ** 2,
  MIB: 1024 ** 2,
  G: 1024 ** 3,
  GB: 1000 ** 3,
  GIB: 1024 ** 3,
  T: 1024 ** 4,
  TB: 1000 ** 4,
  TIB: 1024 ** 4,
  P: 1024 ** 5,
  PB: 1000 ** 5,
  PIB: 1024 ** 5,
};

export function parseSize(s: string): number | undefined {
  const m = /^([\d.]+)\s*([A-Za-z]*)$/.exec(s.trim());
  if (!m) {
    return undefined;
  }
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) {
    return undefined;
  }
  const unit = (m[2] || 'B').toUpperCase();
  const mult = SIZE_UNITS[unit];
  return mult === undefined ? undefined : num * mult;
}

/** Parse "123k" style counts (used by diskusage_report for file counts). */
function parseCount(s: string): number | undefined {
  const m = /^([\d.]+)\s*([kKmM]?)$/.exec(s.trim());
  if (!m) {
    return undefined;
  }
  const num = parseFloat(m[1]);
  const mult = m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1;
  return Number.isNaN(num) ? undefined : num * mult;
}

/** Sum gpu counts out of a Slurm Gres/GresUsed string like "gpu:h100:4(IDX:0-3),tmpdisk:..." */
export function gpuCount(gres: string): number {
  let total = 0;
  const re = /gpu(?::[A-Za-z0-9_.-]+)?:(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(gres)) !== null) {
    total += parseInt(m[1], 10) || 0;
  }
  return total;
}

/** Parse `diskusage_report` output lines into per-filesystem usage entries. */
export function parseDiskusageReport(text: string): FsUsage[] {
  const out: FsUsage[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    // e.g. "  /home (user alice)     10 GiB/50 GiB      100k/500k"
    const m =
      /^\s*(.+?)\s{2,}([\d.]+\s*[A-Za-z]*)\s*\/\s*([\d.]+\s*[A-Za-z]*)\s+([\d.]+[kKmM]?)\s*\/\s*([\d.]+[kKmM]?)\s*$/.exec(
        line
      );
    if (!m) {
      continue;
    }
    const label = m[1].trim();
    if (/description/i.test(label)) {
      continue;
    }
    const usedB = parseSize(m[2]);
    const quotaB = parseSize(m[3]);
    const filesUsed = parseCount(m[4]);
    const filesQuota = parseCount(m[5]);
    out.push({
      label,
      used: m[2].trim(),
      quota: m[3].trim(),
      usedPct:
        usedB !== undefined && quotaB !== undefined && quotaB > 0
          ? Math.round((usedB / quotaB) * 100)
          : undefined,
      filesUsed: m[4],
      filesQuota: m[5],
      filesPct:
        filesUsed !== undefined && filesQuota !== undefined && filesQuota > 0
          ? Math.round((filesUsed / filesQuota) * 100)
          : undefined,
    });
  }
  return out;
}

/** Parse `sshare -U -h -P` pipe-separated output into per-association rows. */
export function parseSshare(text: string): FairShareRow[] {
  const rows: FairShareRow[] = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split('|');
    if (f.length < 7 || !f[1]) {
      continue; // header/account-level rows have an empty User column
    }
    const normShares = parseFloat(f[3]);
    const effectvUsage = parseFloat(f[5]);
    rows.push({
      account: f[0].trim(),
      user: f[1].trim(),
      normShares: Number.isNaN(normShares) ? 0 : normShares,
      rawUsage: parseFloat(f[4]) || 0,
      effectvUsage: Number.isNaN(effectvUsage) ? 0 : effectvUsage,
      fairShare: parseFloat(f[6]) || 0,
      ratio:
        !Number.isNaN(normShares) && normShares > 0 && !Number.isNaN(effectvUsage)
          ? effectvUsage / normShares
          : undefined,
    });
  }
  return rows;
}

/** Next hard-reset time for a Slurm PriorityUsageResetPeriod, from `now`. */
export function nextUsageReset(period: string, now: Date): Date | undefined {
  const p = period.toUpperCase();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (p) {
    case 'DAILY':
      d.setDate(d.getDate() + 1);
      return d;
    case 'WEEKLY': {
      // Slurm resets weekly usage on Sunday at 00:00.
      const days = (7 - d.getDay()) % 7 || 7;
      d.setDate(d.getDate() + days);
      return d;
    }
    case 'MONTHLY':
      return new Date(now.getFullYear(), now.getMonth() + 1, 1);
    case 'QUARTERLY':
      return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 1);
    case 'YEARLY':
      return new Date(now.getFullYear() + 1, 0, 1);
    default:
      return undefined;
  }
}

/** Fixed-width slicing for `sinfo -O` output (widths must match the format string). */
function sliceColumns(line: string, widths: number[]): string[] {
  const cols: string[] = [];
  let pos = 0;
  for (const w of widths) {
    cols.push(line.slice(pos, pos + w).trim());
    pos += w;
  }
  return cols;
}

export class ClusterMonitor implements vscode.Disposable {
  private timer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  /** static per-cluster config, fetched once per session */
  private priorityConf?: { halfLifeSec?: number; resetPeriod?: string };
  private snapshot: ClusterSnapshot = {
    connected: false,
    storage: [],
    nodeStates: {},
    partitions: [],
    insights: [],
    pollIntervalSec: 120,
  };

  private readonly emitter = new vscode.EventEmitter<ClusterSnapshot>();
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

  getSnapshot(): ClusterSnapshot {
    return this.snapshot;
  }

  dispose(): void {
    this.stop();
    this.emitter.dispose();
  }

  start(): void {
    this.stop();
    const sec = Math.max(30, getConfig().clusterPollIntervalSeconds);
    this.snapshot.pollIntervalSec = sec;
    this.timer = setInterval(() => void this.refreshNow(), sec * 1000);
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
    try {
      const next: ClusterSnapshot = {
        connected: true,
        updatedAt: Date.now(),
        storage: [],
        nodeStates: {},
        partitions: [],
        insights: [],
        pollIntervalSec: this.snapshot.pollIntervalSec,
      };

      // ── Node-level utilisation (dedup nodes listed in several partitions) ──
      const widths = [24, 14, 18, 12, 12, 36, 44];
      const nodeRes = await this.ssh.exec(
        'sinfo -h -N -O "NodeHost:24,StateCompact:14,CPUsState:18,Memory:12,AllocMem:12,Gres:36,GresUsed:44"'
      );
      if (nodeRes.code === 0) {
        const seen = new Set<string>();
        let cpuA = 0;
        let cpuI = 0;
        let cpuO = 0;
        let cpuT = 0;
        let memAlloc = 0;
        let memTotal = 0;
        let gpuTot = 0;
        let gpuUsed = 0;
        for (const line of nodeRes.stdout.split('\n')) {
          if (!line.trim()) {
            continue;
          }
          const [host, state, cpus, memMB, allocMB, gres, gresUsed] = sliceColumns(line, widths);
          if (!host || seen.has(host)) {
            continue;
          }
          seen.add(host);
          const cm = /^(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(cpus);
          if (cm) {
            cpuA += +cm[1];
            cpuI += +cm[2];
            cpuO += +cm[3];
            cpuT += +cm[4];
          }
          memTotal += parseInt(memMB, 10) || 0;
          memAlloc += parseInt(allocMB, 10) || 0;
          gpuTot += gpuCount(gres);
          gpuUsed += gpuCount(gresUsed);
          // strip only Slurm's trailing state FLAGS (*~#!%$@^+-), never letters
          const baseState = state.toLowerCase().replace(/[*~#!%$@^+.\-]+$/, '') || 'unknown';
          next.nodeStates[baseState] = (next.nodeStates[baseState] ?? 0) + 1;
        }
        if (cpuT > 0) {
          next.cpu = { alloc: cpuA, idle: cpuI, other: cpuO, total: cpuT };
        }
        if (memTotal > 0) {
          next.mem = { allocMB: memAlloc, totalMB: memTotal };
        }
        if (gpuTot > 0) {
          next.gpu = { used: gpuUsed, total: gpuTot };
        }
      } else {
        next.error = `sinfo failed: ${(nodeRes.stderr || nodeRes.stdout).trim().slice(0, 200)}`;
      }

      // ── Partition summary ──
      const partRes = await this.ssh.exec('sinfo -h -o "%R|%a|%D|%T"');
      if (partRes.code === 0) {
        const map = new Map<string, PartitionInfo>();
        for (const line of partRes.stdout.split('\n')) {
          const f = line.trim().split('|');
          if (f.length < 4) {
            continue;
          }
          const [name, avail, countStr, state] = f;
          const count = parseInt(countStr, 10) || 0;
          let p = map.get(name);
          if (!p) {
            p = { name, avail, totalNodes: 0, idleNodes: 0, mixedNodes: 0, allocNodes: 0, otherNodes: 0 };
            map.set(name, p);
          }
          p.totalNodes += count;
          const st = state.toLowerCase();
          if (st.startsWith('idle')) {
            p.idleNodes += count;
          } else if (st.startsWith('mix')) {
            p.mixedNodes += count;
          } else if (st.startsWith('alloc')) {
            p.allocNodes += count;
          } else {
            p.otherNodes += count;
          }
        }
        next.partitions = Array.from(map.values()).sort((a, b) => b.idleNodes - a.idleNodes);
      }

      // ── Fair share (my associations) ──
      try {
        const ss = await this.ssh.exec(
          'sshare -U -h -P -o "Account,User,RawShares,NormShares,RawUsage,EffectvUsage,FairShare" 2>/dev/null'
        );
        if (ss.code === 0 && ss.stdout.trim()) {
          next.fairshare = parseSshare(ss.stdout);
        }
        // Decay/reset policy is static — fetch once per session.
        if (!this.priorityConf) {
          const conf = await this.ssh.exec(
            `scontrol show config 2>/dev/null | grep -iE 'PriorityDecayHalfLife|PriorityUsageResetPeriod'`
          );
          if (conf.code === 0) {
            const hl = /PriorityDecayHalfLife\s*=\s*(\S+)/i.exec(conf.stdout)?.[1];
            const rp = /PriorityUsageResetPeriod\s*=\s*(\S+)/i.exec(conf.stdout)?.[1];
            this.priorityConf = {
              halfLifeSec: hl ? Math.max(0, parseSlurmDuration(hl)) : undefined,
              resetPeriod: rp?.toUpperCase(),
            };
          } else {
            this.priorityConf = {};
          }
        }
        if (this.priorityConf) {
          const meta: FairShareMeta = {
            halfLifeSec: this.priorityConf.halfLifeSec,
            resetPeriod: this.priorityConf.resetPeriod,
          };
          if (meta.resetPeriod && meta.resetPeriod !== 'NONE') {
            meta.nextResetAt = nextUsageReset(meta.resetPeriod, new Date())?.getTime();
          }
          next.fairshareMeta = meta;
        }
      } catch {
        /* fairshare is best-effort */
      }

      // ── Storage quotas (Alliance-specific tool; best-effort) ──
      try {
        const du = await this.ssh.exec('diskusage_report 2>/dev/null || true');
        const text = du.stdout.trim();
        if (text) {
          next.storageRaw = text;
          next.storage = parseDiskusageReport(text);
        } else {
          next.storageError = 'diskusage_report returned no output (quota info unavailable).';
        }
      } catch (e) {
        next.storageError = (e as Error).message;
      }

      // ── Insights for job planning ──
      if (next.fairshare?.length) {
        const cfgAlloc = getConfig().allocGroup.toLowerCase().split('_')[0];
        const row =
          next.fairshare.find((r) => cfgAlloc && r.account.toLowerCase().includes(cfgAlloc)) ??
          next.fairshare[0];
        if (row?.ratio !== undefined) {
          const x = row.ratio.toFixed(2);
          if (row.ratio > 1.15) {
            next.insights.push(
              `Fair share: ${row.account} is at ${x}× its share — new jobs get reduced priority until usage decays.`
            );
          } else if (row.ratio < 0.85) {
            next.insights.push(
              `Fair share: ${row.account} is at ${x}× its share (under-used) — your jobs get a priority boost.`
            );
          } else {
            next.insights.push(`Fair share: ${row.account} is near its fair share (${x}×).`);
          }
          // Reset / decay timing — for planning heavy runs.
          const meta = next.fairshareMeta;
          if (meta?.nextResetAt) {
            const days = (meta.nextResetAt - Date.now()) / 86400000;
            next.insights.push(
              `Fair-share usage hard-resets ${meta.resetPeriod?.toLowerCase()} — next reset in ${days.toFixed(1)} days; usage accumulated now is wiped then.`
            );
          } else if (meta?.halfLifeSec && meta.halfLifeSec > 0) {
            const hlDays = (meta.halfLifeSec / 86400).toFixed(1);
            if (row.ratio > 1.05) {
              const etaSec = meta.halfLifeSec * Math.log2(row.ratio);
              meta.ratioOneEtaSec = etaSec;
              next.insights.push(
                `No hard reset on this cluster — usage decays with a ${hlDays}-day half-life. If you pause submissions, ${row.account} returns to its fair share (1.0×) in ~${(etaSec / 86400).toFixed(1)} days.`
              );
            } else {
              next.insights.push(
                `No hard reset on this cluster — usage decays continuously (half-life ${hlDays} d). Under-use is not banked: staying idle does not stockpile credit beyond the current priority boost, so there is no reset moment to wait for.`
              );
            }
          }
        }
      }
      if (next.cpu) {
        const pct = Math.round((next.cpu.alloc / next.cpu.total) * 100);
        next.insights.push(
          `CPUs ${pct}% allocated cluster-wide — ${next.cpu.idle.toLocaleString()} cores idle now.`
        );
      }
      if (next.mem) {
        const pct = Math.round((next.mem.allocMB / next.mem.totalMB) * 100);
        next.insights.push(`Memory ${pct}% allocated cluster-wide.`);
      }
      if (next.gpu) {
        const free = next.gpu.total - next.gpu.used;
        next.insights.push(
          free > 0
            ? `GPUs: ${next.gpu.used}/${next.gpu.total} in use — ${free} free; GPU jobs may start quickly.`
            : `GPUs: all ${next.gpu.total} in use — expect queueing for GPU jobs.`
        );
      }
      const withIdle = next.partitions.filter((p) => p.idleNodes > 0).slice(0, 3);
      if (withIdle.length) {
        next.insights.push(
          `Most idle nodes: ${withIdle.map((p) => `${p.name} (${p.idleNodes})`).join(', ')} — target these partitions for fast starts.`
        );
      } else if (next.partitions.length) {
        next.insights.push('No fully idle nodes in any partition — expect your jobs to queue.');
      }
      for (const fsu of next.storage) {
        if (fsu.usedPct !== undefined && fsu.usedPct >= 90) {
          next.insights.push(`⚠ ${fsu.label} is at ${fsu.usedPct}% of its space quota (${fsu.used}/${fsu.quota}).`);
        }
        if (fsu.filesPct !== undefined && fsu.filesPct >= 90) {
          next.insights.push(`⚠ ${fsu.label} is at ${fsu.filesPct}% of its file-count quota.`);
        }
      }

      this.snapshot = next;
    } catch (e) {
      this.snapshot = {
        ...this.snapshot,
        connected: this.ssh.status === 'connected',
        error: (e as Error).message,
        updatedAt: Date.now(),
      };
      log.appendLine(`[cluster] refresh failed: ${(e as Error).message}`);
    } finally {
      this.refreshing = false;
      this.emitter.fire(this.snapshot);
    }
  }
}
