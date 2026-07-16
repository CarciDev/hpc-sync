import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { log } from './log';
import { discoverKeys } from './sshKeys';

/**
 * SSH-key survival across dev-container rebuilds.
 *
 * A rebuild recreates the container filesystem, deleting any key generated
 * into the container's ~/.ssh (this bit a real user). VS Code SecretStorage
 * lives on the CLIENT (the local OS keychain), so a copy stored there
 * survives every rebuild. We back the key up opportunistically and restore
 * it on activation when the files are gone.
 */

const SECRET_KEY = 'hpcSync.sshKeyBackup';

interface KeyBackup {
  path: string;
  privateKey: string;
  publicKey?: string;
  savedAt: number;
}

let secrets: vscode.SecretStorage | undefined;

export function initKeyBackup(store: vscode.SecretStorage): void {
  secrets = store;
}

/** Back up the first discovered key (private + .pub) to client-side secrets. */
export async function backupKeyNow(): Promise<void> {
  if (!secrets) {
    return;
  }
  try {
    const keys = discoverKeys(getConfig());
    const k = keys.find((c) => fs.existsSync(c.path));
    if (!k) {
      return;
    }
    const backup: KeyBackup = {
      path: k.path,
      privateKey: fs.readFileSync(k.path, 'utf8'),
      publicKey: fs.existsSync(k.path + '.pub') ? fs.readFileSync(k.path + '.pub', 'utf8') : undefined,
      savedAt: Date.now(),
    };
    await secrets.store(SECRET_KEY, JSON.stringify(backup));
    log.appendLine(`[ssh] key ${k.path} backed up to client-side secret storage (survives container rebuilds)`);
  } catch (e) {
    log.appendLine(`[ssh] key backup failed (non-fatal): ${(e as Error).message}`);
  }
}

/**
 * If no key exists on disk but a backup does (typical right after a dev
 * container rebuild), restore the files. Returns true when restored.
 */
export async function restoreKeyIfMissing(): Promise<boolean> {
  if (!secrets) {
    return false;
  }
  try {
    if (discoverKeys(getConfig()).some((c) => fs.existsSync(c.path))) {
      return false; // a key is present — nothing to do
    }
    const raw = await secrets.get(SECRET_KEY);
    if (!raw) {
      return false;
    }
    const backup = JSON.parse(raw) as KeyBackup;
    // Restore to the same filename inside THIS environment's home — the
    // backed-up absolute path may come from a different home (host vs
    // container).
    const dir = path.join(os.homedir(), '.ssh');
    const target = path.join(dir, path.basename(backup.path));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, backup.privateKey, { mode: 0o600 });
    if (backup.publicKey) {
      fs.writeFileSync(target + '.pub', backup.publicKey, { mode: 0o644 });
    }
    log.appendLine(`[ssh] key restored from client-side backup → ${target} (container rebuild wiped ~/.ssh)`);
    void vscode.window.showInformationMessage(
      'HPC Sync: your SSH key was restored from the client-side backup after the container rebuild — no need to re-register it.'
    );
    return true;
  } catch (e) {
    log.appendLine(`[ssh] key restore failed: ${(e as Error).message}`);
    return false;
  }
}
