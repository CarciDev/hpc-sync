import * as path from 'path';
import * as vscode from 'vscode';

export interface HpcConfig {
  host: string;
  user: string;
  allocGroup: string;
  privateKeyPath: string;
  remoteProjectDir: string;
  remoteSifDir: string;
  apptainerLoad: string;
  dockerImageName: string;
  sifName: string;
  tarName: string;
  dockerfilePath: string;
  requirementsPath: string;
  outputDir: string;
  containerWorkdir: string;
  jobsPollIntervalSeconds: number;
  recentJobsHours: number;
  clusterPollIntervalSeconds: number;
  excludes: string[];
  confirmUploadOverMB: number;
  localProjectDir: string;
  stateFile: string;
  tarStateFile: string;
}

export function getConfig(): HpcConfig {
  const c = vscode.workspace.getConfiguration('hpcSync');
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const wsName = ws ? path.basename(ws) : '';

  const resolveLocal = (p: string): string => {
    if (!p) {
      return '';
    }
    return path.isAbsolute(p) ? p : path.join(ws, p);
  };

  // ${workspaceName} lets one user-level setting serve many projects,
  // e.g. remoteProjectDir = "~/projects/${workspaceName}".
  const expandTokens = (p: string): string =>
    p.replace(/\$\{workspaceName\}|\$\{workspaceFolderBasename\}/g, wsName);

  const host = c.get<string>('host', '').trim();
  // State is per-cluster: a .sif "built" for one host says nothing about another.
  const stateSuffix = host ? `.${host}` : '';

  return {
    host,
    user: c.get<string>('user', '').trim(),
    allocGroup: c.get<string>('allocGroup', '').trim(),
    privateKeyPath: resolveLocal(c.get<string>('privateKeyPath', '').trim()),
    remoteProjectDir: expandTokens(c.get<string>('remoteProjectDir', '~/projects/${workspaceName}').trim()),
    remoteSifDir: expandTokens(c.get<string>('remoteSifDir', '~/containers').trim()),
    apptainerLoad: c.get<string>('apptainerLoad', 'module load apptainer').trim(),
    dockerImageName: c.get<string>('dockerImageName', '').trim(),
    sifName: expandTokens(c.get<string>('sifName', '${workspaceName}.sif').trim()),
    tarName: expandTokens(c.get<string>('tarName', '${workspaceName}.tar').trim()),
    dockerfilePath: resolveLocal(c.get<string>('dockerfilePath', '.devcontainer/Dockerfile')),
    requirementsPath: resolveLocal(c.get<string>('requirementsPath', 'requirements.txt')),
    outputDir: expandTokens(c.get<string>('outputDir', '~/scratch/${workspaceName}_output').trim()),
    containerWorkdir: expandTokens(c.get<string>('containerWorkdir', '/workspaces/${workspaceName}').trim()),
    jobsPollIntervalSeconds: Math.max(5, c.get<number>('jobsPollIntervalSeconds', 15)),
    recentJobsHours: Math.max(1, c.get<number>('recentJobsHours', 24)),
    clusterPollIntervalSeconds: Math.max(30, c.get<number>('clusterPollIntervalSeconds', 120)),
    excludes: c.get<string[]>('excludes', []),
    confirmUploadOverMB: Math.max(1, c.get<number>('confirmUploadOverMB', 200)),
    localProjectDir: ws,
    stateFile: path.join(ws, `.hpc_sync_state${stateSuffix}`),
    tarStateFile: path.join(ws, `.hpc_sync_tar_state${stateSuffix}`),
  };
}

/** Quote a string for a POSIX shell (single-quoted). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
