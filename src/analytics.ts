import * as vscode from 'vscode';
import { getConfig } from './config';
import { log } from './log';
import { SshManager } from './sshManager';

export interface UsagePattern {
  fetchedAt: number;
  /** sacct = core-hours of jobs submitted per hour (7 days, all users);
   *  squeue = cores currently in the queue by submit hour (fallback). */
  source: 'sacct' | 'squeue';
  bins: number[]; // 24 entries, one per hour of day (cluster local time)
  /** cluster's UTC offset in minutes east of UTC (from `date +%z`), for local-time conversion */
  clusterUtcOffsetMin?: number;
}

/** Parse `date +%z` output like "-0400" into minutes east of UTC. */
export function parseUtcOffset(s: string): number | undefined {
  const m = /^([+-])(\d{2})(\d{2})$/.exec((s || '').trim());
  if (!m) {
    return undefined;
  }
  const min = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  return m[1] === '-' ? -min : min;
}

const TTL_MS = 12 * 60 * 60 * 1000;

/** Parse the "hour|value" lines produced by the remote awk aggregation. */
export function parseHistogram(text: string): number[] | undefined {
  const bins = new Array<number>(24).fill(0);
  let seen = 0;
  for (const line of text.split('\n')) {
    const m = /^(\d+)\|([\d.]+)$/.exec(line.trim());
    if (!m) {
      continue;
    }
    const h = parseInt(m[1], 10);
    if (h >= 0 && h < 24) {
      bins[h] = parseFloat(m[2]) || 0;
      seen++;
    }
  }
  return seen >= 24 ? bins : undefined;
}

/**
 * Cluster-wide job submission pattern (core-hours by hour of submission).
 * Aggregation runs remotely with awk so only 24 lines cross the wire; the
 * result is cached (12h TTL) per cluster in extension global state.
 */
export class UsageAnalytics implements vscode.Disposable {
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
    return `hpcSync.usagePattern.${getConfig().host}`;
  }

  get(): UsagePattern | undefined {
    return this.memento.get<UsagePattern>(this.key());
  }

  private async clusterOffset(): Promise<number | undefined> {
    try {
      const r = await this.ssh.exec('date +%z');
      return r.code === 0 ? parseUtcOffset(r.stdout.trim().split('\n').pop() ?? '') : undefined;
    } catch {
      return undefined;
    }
  }

  /** Fetch if the cache is missing/stale (or force=true). */
  async ensure(force: boolean): Promise<void> {
    const cached = this.get();
    if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) {
      // Keep the timezone offset current even when the histogram is cached
      // (it changes across DST transitions).
      const off = await this.clusterOffset();
      if (off !== undefined && off !== cached.clusterUtcOffsetMin) {
        await this.memento.update(this.key(), { ...cached, clusterUtcOffsetMin: off });
        this.emitter.fire();
      }
      return;
    }
    if (this._busy) {
      return;
    }
    this._busy = true;
    this.emitter.fire();
    try {
      // hour = chars 12-13 of "YYYY-MM-DDTHH:MM:SS"
      const agg = `awk -F'|' '{h=substr($1,12,2)+0; v=($2*$3)/3600; if(h>=0&&h<24) s[h]+=v} END{for(i=0;i<24;i++) printf "%d|%.2f\\n", i, s[i]+0}'`;
      let pattern: UsagePattern | undefined;

      const sacct = await this.ssh.exec(
        `sacct -a -X -n -P -S now-7days -o Submit,AllocCPUS,ElapsedRaw 2>/dev/null | ${agg}`
      );
      const sacctBins = sacct.code === 0 ? parseHistogram(sacct.stdout) : undefined;
      if (sacctBins && sacctBins.some((b) => b > 0)) {
        pattern = { fetchedAt: Date.now(), source: 'sacct', bins: sacctBins };
      } else {
        // Accounting for other users may be restricted — fall back to the live queue.
        const aggQ = `awk -F'|' '{h=substr($1,12,2)+0; if(h>=0&&h<24) s[h]+=$2} END{for(i=0;i<24;i++) printf "%d|%.2f\\n", i, s[i]+0}'`;
        const sq = await this.ssh.exec(`squeue -h -o "%V|%C" | ${aggQ}`);
        const sqBins = sq.code === 0 ? parseHistogram(sq.stdout) : undefined;
        if (sqBins) {
          pattern = { fetchedAt: Date.now(), source: 'squeue', bins: sqBins };
        }
      }

      if (pattern) {
        pattern.clusterUtcOffsetMin = await this.clusterOffset();
        await this.memento.update(this.key(), pattern);
        log.appendLine(
          `[analytics] submission pattern rebuilt from ${pattern.source} (peak bin ${Math.max(
            ...pattern.bins
          ).toFixed(0)})`
        );
      } else {
        log.appendLine('[analytics] could not build a submission pattern (sacct and squeue both unusable)');
      }
    } catch (e) {
      log.appendLine(`[analytics] failed: ${(e as Error).message}`);
    } finally {
      this._busy = false;
      this.emitter.fire();
    }
  }
}

/** Best (lowest-load) consecutive 3h submission window. Returns start hour. */
export function bestWindow(bins: number[]): { start: number; sum: number } {
  let best = 0;
  let bestSum = Infinity;
  for (let h = 0; h < 24; h++) {
    const s = bins[h] + bins[(h + 1) % 24] + bins[(h + 2) % 24];
    if (s < bestSum) {
      bestSum = s;
      best = h;
    }
  }
  return { start: best, sum: bestSum };
}
