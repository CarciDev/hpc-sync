import * as vscode from 'vscode';

export const log = vscode.window.createOutputChannel('HPC Sync');

export function logLine(line: string): void {
  log.appendLine(line);
}
