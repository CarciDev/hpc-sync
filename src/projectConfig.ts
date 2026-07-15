import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';

/** A named cluster directory this project depends on (datasets, shared caches…). */
export interface ProjectMount {
  name: string;
  /** absolute remote path on the cluster */
  path: string;
  purpose?: string;
}

export interface ProjectConfig {
  mounts: ProjectMount[];
}

/**
 * Per-project settings, stored as .hpcproject.json in the workspace root so
 * they are versionable and give the team standard paths.
 */
export function projectConfigPath(): string | undefined {
  const ws = getConfig().localProjectDir;
  return ws ? path.join(ws, '.hpcproject.json') : undefined;
}

export function loadProjectConfig(): ProjectConfig {
  const p = projectConfigPath();
  if (p && fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ProjectConfig>;
      const mounts = Array.isArray(raw.mounts)
        ? raw.mounts.filter((m): m is ProjectMount => !!m && typeof m.name === 'string' && typeof m.path === 'string')
        : [];
      return { mounts };
    } catch {
      /* corrupted file — treat as empty */
    }
  }
  return { mounts: [] };
}

export function saveProjectConfig(cfg: ProjectConfig): void {
  const p = projectConfigPath();
  if (p) {
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  }
}

export function mountEnvName(name: string): string {
  return 'HPC_MOUNT_' + name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
}

const BLOCK_START = '# >>> hpc-sync mounts (managed — edit via .hpcproject.json) >>>';
const BLOCK_END = '# <<< hpc-sync mounts <<<';
const BLOCK_RE = /\r?\n?# >>> hpc-sync mounts[^\n]*>>>[\s\S]*?# <<< hpc-sync mounts <<<\r?\n?/;

/**
 * Remove the managed ENV block (used by change detection so mount edits never
 * trigger a rebuild). Trailing whitespace is canonicalized to a single \n so
 * the result is identical whether the block was ever added or not — the
 * writer normalizes the file end when appending, and without this the hash
 * would change on the FIRST block add despite the no-rebuild promise.
 */
export function stripMountEnvBlock(dockerfile: string): string {
  return dockerfile.replace(BLOCK_RE, '\n').replace(/\s*$/, '\n');
}

/**
 * Mirror the project mounts into a managed ENV block at the end of the
 * Dockerfile, so the built image carries the canonical paths as defaults
 * (readable via plain os.environ / docker inspect, no extra files). Runtime
 * --env still overrides. Returns true if the Dockerfile was modified.
 */
export function syncDockerfileMountEnv(dockerfilePath: string, mounts: ProjectMount[]): boolean {
  if (!fs.existsSync(dockerfilePath)) {
    return false;
  }
  const original = fs.readFileSync(dockerfilePath, 'utf8');
  const without = original.replace(BLOCK_RE, '\n');
  let next = without;
  if (mounts.length > 0) {
    const block = [
      BLOCK_START,
      ...mounts.map((m) => `ENV ${mountEnvName(m.name)}="${m.path}"`),
      BLOCK_END,
    ].join('\n');
    next = without.replace(/\s*$/, '\n\n') + block + '\n';
  }
  if (next !== original) {
    fs.writeFileSync(dockerfilePath, next);
    return true;
  }
  return false;
}

export interface ProjectTemplate {
  name: string;
  builtin?: boolean;
  dockerfile: string;
  devcontainer: string;
  requirements: string;
}

export const BUILTIN_TEMPLATES: ProjectTemplate[] = [
  {
    name: 'python-minimal',
    builtin: true,
    dockerfile: [
      'FROM mcr.microsoft.com/devcontainers/python:3.11',
      '',
      'COPY requirements.txt /tmp/requirements.txt',
      'RUN pip install --no-cache-dir -r /tmp/requirements.txt',
      '',
    ].join('\n'),
    devcontainer: JSON.stringify(
      {
        name: 'Python 3',
        build: { dockerfile: 'Dockerfile', context: '..' },
        features: { 'ghcr.io/devcontainers/features/common-utils:2': {} },
      },
      null,
      2
    ),
    requirements: 'numpy\n',
  },
  {
    name: 'python-geospatial',
    builtin: true,
    dockerfile: [
      'FROM mcr.microsoft.com/devcontainers/python:3.11',
      '',
      'RUN apt-get update && apt-get install -y --no-install-recommends \\',
      '    gdal-bin libgdal-dev \\',
      '    && rm -rf /var/lib/apt/lists/*',
      '',
      'COPY requirements.txt /tmp/requirements.txt',
      'RUN pip install --no-cache-dir -r /tmp/requirements.txt',
      '',
    ].join('\n'),
    devcontainer: JSON.stringify(
      {
        name: 'Python 3 (geospatial)',
        build: { dockerfile: 'Dockerfile', context: '..' },
        features: {
          'ghcr.io/devcontainers/features/common-utils:2': {},
          'ghcr.io/devcontainers/features/git-lfs:1': {},
        },
      },
      null,
      2
    ),
    requirements: ['numpy', 'rasterio', 'geopandas', 'shapely', 'pyproj', 'requests', ''].join('\n'),
  },
];
