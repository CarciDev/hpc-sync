import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { utils } from 'ssh2';
import { HpcConfig } from './config';

export interface KeyCandidate {
  path: string;
  source: 'setting' | 'ssh-config' | 'default';
}

export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** The agent socket/pipe, or undefined if no agent appears to be running. */
export function agentSocket(): string | undefined {
  if (process.platform === 'win32') {
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
    try {
      return fs.existsSync(pipe) ? pipe : undefined;
    } catch {
      return undefined;
    }
  }
  const sock = process.env.SSH_AUTH_SOCK;
  try {
    return sock && fs.existsSync(sock) ? sock : undefined;
  } catch {
    return undefined;
  }
}

function globToRegex(pattern: string): RegExp {
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** IdentityFile entries from ~/.ssh/config blocks whose Host pattern matches. */
export function identityFilesFromSshConfig(host: string): string[] {
  const cfgPath = path.join(os.homedir(), '.ssh', 'config');
  let text: string;
  try {
    text = fs.readFileSync(cfgPath, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  let inMatchingBlock = true; // top-of-file directives apply to all hosts
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'host') {
      const patterns = value.split(/\s+/);
      let matched = false;
      for (const pat of patterns) {
        if (pat.startsWith('!')) {
          if (globToRegex(pat.slice(1)).test(host)) {
            matched = false;
            break;
          }
        } else if (globToRegex(pat).test(host)) {
          matched = true;
        }
      }
      inMatchingBlock = matched;
    } else if (key === 'match') {
      inMatchingBlock = false; // Match blocks are out of scope for this light parser
    } else if (inMatchingBlock && key === 'identityfile') {
      out.push(expandHome(value.replace(/^"|"$/g, '')));
    }
  }
  return out;
}

/**
 * Private keys to try, in order, the way plain `ssh` would:
 * explicit setting → ~/.ssh/config IdentityFile for this host → default names.
 */
export function discoverKeys(cfg: HpcConfig): KeyCandidate[] {
  const out: KeyCandidate[] = [];
  const seen = new Set<string>();
  const add = (p: string, source: KeyCandidate['source']) => {
    if (!p) {
      return;
    }
    const abs = expandHome(p);
    if (seen.has(abs)) {
      return;
    }
    seen.add(abs);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        out.push({ path: abs, source });
      }
    } catch {
      /* unreadable */
    }
  };
  add(cfg.privateKeyPath, 'setting');
  for (const f of identityFilesFromSshConfig(cfg.host)) {
    add(f, 'ssh-config');
  }
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    add(path.join(os.homedir(), '.ssh', name), 'default');
  }
  return out;
}

/** The OpenSSH-format public key line for a private key (via .pub or derivation). */
export function publicKeyText(privateKeyPath: string): string | undefined {
  const pubPath = privateKeyPath + '.pub';
  try {
    if (fs.existsSync(pubPath)) {
      const line = fs.readFileSync(pubPath, 'utf8').trim().split('\n')[0].trim();
      if (line) {
        return line;
      }
    }
  } catch {
    /* fall through to derivation */
  }
  try {
    const parsed = utils.parseKey(fs.readFileSync(privateKeyPath)) as unknown;
    if (parsed instanceof Error) {
      return undefined; // encrypted without passphrase, or unparseable
    }
    const key = (Array.isArray(parsed) ? parsed[0] : parsed) as {
      type: string;
      getPublicSSH(): Buffer;
    };
    return `${key.type} ${key.getPublicSSH().toString('base64')} hpc-sync`;
  } catch {
    return undefined;
  }
}

/** Generate an ed25519 keypair with ssh-keygen. Overwrites nothing (caller checks). */
export function generateKey(targetPath: string, passphrase: string, comment: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh-keygen',
      ['-t', 'ed25519', '-f', targetPath, '-N', passphrase, '-C', comment],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) =>
      reject(new Error(`Could not run ssh-keygen (${e.message}). Is OpenSSH installed?`))
    );
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ssh-keygen exited with ${code}: ${stderr.trim().slice(0, 300)}`))
    );
  });
}
