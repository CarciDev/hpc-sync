import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig, shq } from './config';
import { log } from './log';
import { loadProjectConfig, ProjectMount } from './projectConfig';
import { SshManager } from './sshManager';

/** One project directory found on the cluster. */
export interface AtlasProject {
  name: string;
  remoteDir: string;
  /** false = directory exists but was never synced by HPC Sync (no manifest). */
  hasManifest: boolean;
  mounts: ProjectMount[];
  sifSizeBytes?: number;
  /** current workspace only: local .hpcproject.json differs from the synced copy */
  localEdits?: boolean;
  /** current workspace only: project directory not found on the cluster yet */
  missingRemote?: boolean;
}

/** One shared directory, merged across projects by normalized path. */
export interface AtlasMountNode {
  /** normalized absolute-ish path — the merge key (internal) */
  path: string;
  /** the path as first declared (~/…, $SCRATCH/… kept) — what UIs show */
  display: string;
  /** every name projects gave this path (usually one) */
  names: string[];
  purposes: string[];
  /** project names that declare this mount */
  projects: string[];
}

export interface AtlasSnapshot {
  host: string;
  scannedAt: number;
  projectsParent: string;
  projects: AtlasProject[];
  mounts: AtlasMountNode[];
  error?: string;
}

export interface JobMountRecord {
  id: string;
  project: string;
  /** normalized mount paths bound by this job */
  mountPaths: string[];
}

const SNAP_KEY = (host: string) => `hpcSync.atlas.${host}`;
const JOBS_KEY = (host: string) => `hpcSync.jobMounts.${host}`;

/**
 * Canonical merge key for a mount path: trailing slashes stripped, `~` and
 * `$HOME` expanded. Other `$VARS` (e.g. `$SCRATCH`) stay textual — both
 * declarations of the same var-based path still merge.
 */
export function normalizeMountPath(p: string, home: string): string {
  let out = p.trim().replace(/\/+$/, '');
  if (home && (out === '~' || out.startsWith('~/'))) {
    out = home + out.slice(1);
  }
  return home ? out.replace(/\$HOME(?=\/|$)/g, home) : out;
}

/**
 * Cluster-wide project/mount discovery. One batched exec over the shared SSH
 * session reads the project directory listing, every synced project's
 * .hpcproject.json manifest, and the .sif inventory — no du sweeps, per-dir
 * sizes are deliberately out of scope (too expensive on shared filesystems).
 * Snapshots are cached per host; refresh happens on connect, after
 * sync/submit, and on demand — never on a poll loop.
 */
export class AtlasModel implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidUpdate = this.changeEmitter.event;
  private refreshing = false;

  constructor(
    private readonly ssh: SshManager,
    private readonly memento: vscode.Memento
  ) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  getSnapshot(): AtlasSnapshot | undefined {
    const host = getConfig().host;
    const snap = this.memento.get<AtlasSnapshot>(SNAP_KEY(host));
    return snap && snap.host === host ? snap : undefined;
  }

  /** The name of the project the current workspace syncs to. */
  currentProjectName(): string {
    const cfg = getConfig();
    return path.posix.basename(cfg.remoteProjectDir.replace(/\/+$/, '')) || 'project';
  }

  async refresh(): Promise<void> {
    if (this.refreshing || this.ssh.status !== 'connected') {
      return;
    }
    this.refreshing = true;
    try {
      const snap = await this.scan();
      await this.memento.update(SNAP_KEY(snap.host), snap);
    } catch (e) {
      const host = getConfig().host;
      const prev = this.getSnapshot();
      await this.memento.update(SNAP_KEY(host), {
        ...(prev ?? { host, scannedAt: 0, projectsParent: '', projects: [], mounts: [] }),
        error: (e as Error).message,
      });
      log.appendLine(`[atlas] scan failed: ${(e as Error).message}`);
    } finally {
      this.refreshing = false;
      this.changeEmitter.fire();
    }
  }

  private async scan(): Promise<AtlasSnapshot> {
    const cfg = getConfig();
    const home = await this.ssh.getHomeDir();
    const projectDir = await this.ssh.expandRemotePath(cfg.remoteProjectDir);
    const parent = path.posix.dirname(projectDir.replace(/\/+$/, ''));
    const sifDir = await this.ssh.expandRemotePath(cfg.remoteSifDir);

    // Everything in ONE round trip, with unambiguous section markers.
    const cmd =
      `echo '@@DIRS'; for d in ${shq(parent)}/*/ ; do [ -d "$d" ] && echo "$d"; done; ` +
      `echo '@@MANIFESTS'; for f in ${shq(parent)}/*/.hpcproject.json; do ` +
      `if [ -f "$f" ]; then echo "@@M $f"; cat "$f"; echo; fi; done; ` +
      `echo '@@SIFS'; ls -l ${shq(sifDir)} 2>/dev/null | awk '/\\.sif$/ {print $5, $NF}'`;
    const res = await this.ssh.execChecked(cmd);

    const sections = this.splitSections(res.stdout);
    const normalize = (p: string): string => normalizeMountPath(p, home);

    const projects: AtlasProject[] = [];
    for (const line of sections.DIRS) {
      const dir = line.replace(/\/+$/, '');
      const name = path.posix.basename(dir);
      if (name) {
        projects.push({ name, remoteDir: dir, hasManifest: false, mounts: [] });
      }
    }

    for (const [file, body] of sections.MANIFESTS) {
      const dir = path.posix.dirname(file);
      const proj = projects.find((p) => p.remoteDir === dir);
      if (!proj) {
        continue;
      }
      proj.hasManifest = true;
      try {
        const raw = JSON.parse(body) as { mounts?: ProjectMount[] };
        proj.mounts = (raw.mounts ?? []).filter(
          (m) => m && typeof m.name === 'string' && typeof m.path === 'string'
        );
      } catch {
        log.appendLine(`[atlas] unparseable manifest ignored: ${file}`);
      }
    }

    for (const line of sections.SIFS) {
      const m = /^(\d+)\s+(.+\.sif)$/.exec(line.trim());
      if (!m) {
        continue;
      }
      const base = path.posix.basename(m[2], '.sif');
      const proj = projects.find((p) => p.name === base);
      if (proj) {
        proj.sifSizeBytes = parseInt(m[1], 10);
      }
    }

    // The current workspace is the authority on ITS OWN mounts: overlay the
    // live local .hpcproject.json over the (possibly stale) synced copy, so
    // this view always agrees with the Cluster paths widget and the Launch
    // palette, which read the local file.
    if (cfg.localProjectDir) {
      const localMounts = loadProjectConfig().mounts;
      const cur = projects.find((p) => p.name === this.currentProjectName());
      if (!cur) {
        projects.push({
          name: this.currentProjectName(),
          remoteDir: `${parent}/${this.currentProjectName()}`,
          hasManifest: true,
          mounts: localMounts,
          missingRemote: true,
        });
      } else {
        // The open workspace IS an HPC Sync project regardless of whether a
        // manifest file exists (no mounts declared ⇒ no manifest — normal).
        cur.hasManifest = true;
        if (JSON.stringify(cur.mounts) !== JSON.stringify(localMounts)) {
          cur.mounts = localMounts;
          cur.localEdits = true;
        }
      }
    }

    // Merge mounts across projects by normalized path.
    const byPath = new Map<string, AtlasMountNode>();
    for (const proj of projects) {
      for (const m of proj.mounts) {
        const key = normalize(m.path);
        let node = byPath.get(key);
        if (!node) {
          node = { path: key, display: m.path.trim().replace(/\/+$/, ''), names: [], purposes: [], projects: [] };
          byPath.set(key, node);
        }
        if (!node.names.includes(m.name)) {
          node.names.push(m.name);
        }
        if (m.purpose && !node.purposes.includes(m.purpose)) {
          node.purposes.push(m.purpose);
        }
        if (!node.projects.includes(proj.name)) {
          node.projects.push(proj.name);
        }
      }
    }

    projects.sort((a, b) =>
      (a.name === this.currentProjectName() ? -1 : 0) - (b.name === this.currentProjectName() ? -1 : 0) ||
      a.name.localeCompare(b.name)
    );
    const mounts = Array.from(byPath.values()).sort(
      (a, b) => b.projects.length - a.projects.length || a.path.localeCompare(b.path)
    );
    log.appendLine(
      `[atlas] scanned ${parent}: ${projects.length} project(s), ${mounts.length} mount path(s)`
    );
    return { host: cfg.host, scannedAt: Date.now(), projectsParent: parent, projects, mounts };
  }

  private splitSections(stdout: string): {
    DIRS: string[];
    MANIFESTS: Array<[string, string]>;
    SIFS: string[];
  } {
    const DIRS: string[] = [];
    const MANIFESTS: Array<[string, string]> = [];
    const SIFS: string[] = [];
    let section = '';
    let manifestFile = '';
    let manifestBody: string[] = [];
    const flushManifest = () => {
      if (manifestFile) {
        MANIFESTS.push([manifestFile, manifestBody.join('\n')]);
        manifestFile = '';
        manifestBody = [];
      }
    };
    for (const line of stdout.split('\n')) {
      if (line === '@@DIRS' || line === '@@MANIFESTS' || line === '@@SIFS') {
        flushManifest();
        section = line.slice(2);
        continue;
      }
      if (section === 'DIRS' && line.trim()) {
        DIRS.push(line.trim());
      } else if (section === 'MANIFESTS') {
        if (line.startsWith('@@M ')) {
          flushManifest();
          manifestFile = line.slice(4).trim();
        } else if (manifestFile) {
          manifestBody.push(line);
        }
      } else if (section === 'SIFS' && line.trim()) {
        SIFS.push(line);
      }
    }
    flushManifest();
    return { DIRS, MANIFESTS, SIFS };
  }

  /** Normalize paths the same way the scan does (needs the remote home dir). */
  async normalizePaths(paths: string[]): Promise<string[]> {
    const home = await this.ssh.getHomeDir().catch(() => '');
    return paths.map((p) => normalizeMountPath(p, home));
  }

  // ── job → mounts (recorded at submit time by the Launch panel) ──

  recordJobMounts(jobId: string, project: string, mountPaths: string[]): void {
    if (mountPaths.length === 0) {
      return;
    }
    const host = getConfig().host;
    const arr = this.memento
      .get<JobMountRecord[]>(JOBS_KEY(host), [])
      .filter((e) => e.id !== jobId);
    arr.push({ id: jobId, project, mountPaths });
    while (arr.length > 100) {
      arr.shift();
    }
    void this.memento.update(JOBS_KEY(host), arr);
  }

  getJobMounts(jobId: string): JobMountRecord | undefined {
    return this.memento
      .get<JobMountRecord[]>(JOBS_KEY(getConfig().host), [])
      .find((e) => e.id === jobId);
  }
}
