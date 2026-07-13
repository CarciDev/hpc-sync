import * as fs from 'fs';
import * as vscode from 'vscode';
import { Client, ClientChannel, SFTPWrapper, utils } from 'ssh2';
import { HpcConfig } from './config';
import { log } from './log';
import { agentSocket, discoverKeys } from './sshKeys';

export type SshStatus = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface KbdPrompt {
  prompt: string;
  echo: boolean;
}

type AuthAttempt =
  | { kind: 'none' }
  | { kind: 'agent'; agent: string }
  | { kind: 'publickey'; keyPath: string; source: string }
  | { kind: 'keyboard-interactive' }
  | { kind: 'password' };

function attemptLabel(a: AuthAttempt): string {
  switch (a.kind) {
    case 'none':
      return 'pre-auth probe';
    case 'agent':
      return 'SSH agent';
    case 'publickey':
      return `key ${a.keyPath} (${a.source})`;
    case 'keyboard-interactive':
      return 'keyboard-interactive (password + 2FA)';
    case 'password':
      return 'password';
  }
}

/**
 * Owns a single persistent SSH connection to the HPC login node.
 *
 * Every operation in the extension (sync uploads, apptainer builds, squeue
 * polling, sbatch, scancel, log tailing) is multiplexed over this one
 * connection, so the Duo / 2FA prompt is answered exactly once per session
 * instead of once per ssh/rsync/scp invocation.
 *
 * Auth order mirrors plain `ssh`: agent → hpcSync.privateKeyPath →
 * ~/.ssh/config IdentityFile for the host → default ~/.ssh keys →
 * keyboard-interactive → password.
 */
export class SshManager implements vscode.Disposable {
  private client?: Client;
  private sftpSession?: SFTPWrapper;
  private homeDir?: string;
  private connectPromise?: Promise<void>;
  private _status: SshStatus = 'disconnected';
  private currentTarget = '';
  private intentionalClose = false;

  private readonly statusEmitter = new vscode.EventEmitter<SshStatus>();
  readonly onStatusChanged = this.statusEmitter.event;

  constructor(
    private readonly getCfg: () => HpcConfig,
    private readonly hostKeys: vscode.Memento
  ) {}

  /**
   * Verify the server's host key against a trust-on-first-use record, so a
   * man-in-the-middle can't silently intercept the connection (and with it the
   * password + 2FA passcode). Without this, ssh2 accepts ANY host key.
   */
  private async verifyHost(host: string, sha256Hex: string): Promise<boolean> {
    const key = `hpcSync.hostkey.${host}`;
    const fp = 'SHA256:' + Buffer.from(sha256Hex, 'hex').toString('base64').replace(/=+$/, '');
    const stored = this.hostKeys.get<string>(key);
    if (stored === sha256Hex) {
      return true;
    }
    if (!stored) {
      const pick = await vscode.window.showWarningMessage(
        `First connection to ${host}. Verify its host key fingerprint matches what your cluster documents:\n\n${fp}\n\nTrust this host and continue?`,
        { modal: true },
        'Trust and continue'
      );
      if (pick === 'Trust and continue') {
        await this.hostKeys.update(key, sha256Hex);
        log.appendLine(`[ssh] host key trusted (TOFU): ${fp}`);
        return true;
      }
      return false;
    }
    // stored but different — refuse and require an explicit override.
    const pick = await vscode.window.showWarningMessage(
      `⚠ HOST KEY CHANGED for ${host} — this can mean a man-in-the-middle attack, or the cluster was legitimately rekeyed.\n\nNew fingerprint:\n${fp}\n\nDo NOT continue unless you know the host was rekeyed. Sending your password/2FA to an impostor would compromise them.`,
      { modal: true },
      'Reject (safe)',
      'I verified the change — trust new key'
    );
    if (pick === 'I verified the change — trust new key') {
      await this.hostKeys.update(key, sha256Hex);
      log.appendLine(`[ssh] host key CHANGED and re-trusted by user: ${fp}`);
      return true;
    }
    log.appendLine('[ssh] host key mismatch — connection rejected');
    return false;
  }

  get status(): SshStatus {
    return this._status;
  }

  get target(): string {
    return this.currentTarget;
  }

  private setStatus(s: SshStatus): void {
    if (this._status !== s) {
      this._status = s;
      this.statusEmitter.fire(s);
    }
  }

  async ensureConnected(): Promise<void> {
    if (this._status === 'connected' && this.client) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().finally(() => {
        this.connectPromise = undefined;
      });
    }
    return this.connectPromise;
  }

  disconnect(): void {
    if (this.client) {
      this.intentionalClose = true;
      this.client.end();
    }
    this.cleanup();
    this.setStatus('disconnected');
  }

  dispose(): void {
    this.disconnect();
    this.statusEmitter.dispose();
  }

  private cleanup(): void {
    this.sftpSession = undefined;
    this.homeDir = undefined;
    this.client = undefined;
  }

  private async doConnect(): Promise<void> {
    const cfg = this.getCfg();
    if (!cfg.host || !cfg.user) {
      throw new Error('Set hpcSync.host and hpcSync.user in the extension settings first.');
    }
    this.disconnect();
    this.intentionalClose = false;
    this.currentTarget = `${cfg.user}@${cfg.host}`;
    this.setStatus('connecting');
    log.appendLine(`[ssh] connecting to ${this.currentTarget} ...`);

    // ── Build the auth plan (like plain ssh would) ──
    const attempts: AuthAttempt[] = [{ kind: 'none' }];
    const agent = agentSocket();
    if (agent) {
      attempts.push({ kind: 'agent', agent });
    }
    for (const k of discoverKeys(cfg)) {
      attempts.push({ kind: 'publickey', keyPath: k.path, source: k.source });
    }
    attempts.push({ kind: 'keyboard-interactive' }, { kind: 'password' });
    log.appendLine(
      `[ssh] auth plan: ${attempts.slice(1).map(attemptLabel).join(' → ') || 'none'}`
    );
    if (!agent) {
      log.appendLine('[ssh] (no SSH agent detected)');
    }

    const client = new Client();
    this.client = client;
    let userCancelled = false;
    let lastTried: AuthAttempt | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (err: Error) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };

        client.on('ready', () => {
          if (lastTried) {
            log.appendLine(`[ssh] authenticated via ${attemptLabel(lastTried)}`);
          }
          this.setStatus('connected');
          log.appendLine(
            '[ssh] connected — this session is reused for every sync, build, run and job request (2FA answered once).'
          );
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        client.on('error', (err: Error) => {
          log.appendLine(`[ssh] error: ${err.message}`);
          if (userCancelled) {
            fail(new Error('Authentication cancelled. Run "HPC Sync: Setup SSH" to review your keys.'));
          } else if (/authentication methods/i.test(err.message)) {
            fail(
              new Error(
                `${err.message}. Run "HPC Sync: Setup SSH" to check which keys were found and set one up.`
              )
            );
          } else {
            fail(err);
          }
        });
        client.on('close', () => {
          // A replaced (stale) client must not clobber the state of a newer one.
          if (this.client !== client) {
            fail(new Error('SSH connection closed'));
            return;
          }
          const wasIntentional = this.intentionalClose;
          const wasConnected = this._status === 'connected';
          log.appendLine('[ssh] connection closed');
          this.cleanup();
          this.setStatus('disconnected');
          if (!wasIntentional && wasConnected) {
            void vscode.window
              .showWarningMessage(
                'HPC Sync: the SSH connection to the cluster was lost (network drop, sleep, or server-side timeout).',
                'Reconnect'
              )
              .then((pick) => {
                if (pick === 'Reconnect') {
                  void vscode.commands.executeCommand('hpcSync.connect');
                }
              });
          }
          fail(new Error(wasIntentional ? 'Disconnected' : 'SSH connection closed unexpectedly'));
        });
        client.on('banner', (msg: string) => {
          const trimmed = msg.trim();
          if (trimmed) {
            log.appendLine(`[ssh banner] ${trimmed}`);
          }
        });

        const authHandler = (
          methodsLeft: string[] | null,
          _partialSuccess: boolean,
          cb: (auth: unknown) => void
        ): void => {
          void (async () => {
            if (lastTried && lastTried.kind !== 'none') {
              log.appendLine(`[ssh] ${attemptLabel(lastTried)} did not succeed, trying next method ...`);
            }
            for (;;) {
              if (userCancelled) {
                cb(false);
                return;
              }
              const next = attempts.shift();
              if (next === undefined) {
                cb(false);
                return;
              }
              // Servers advertise agent/key auth as "publickey" in methodsLeft.
              const methodName = next.kind === 'agent' ? 'publickey' : next.kind;
              if (
                next.kind !== 'none' &&
                methodsLeft &&
                methodsLeft.length > 0 &&
                !methodsLeft.includes(methodName)
              ) {
                log.appendLine(`[ssh] skipping ${attemptLabel(next)} (server does not offer ${methodName})`);
                continue;
              }
              lastTried = next;
              switch (next.kind) {
                case 'none':
                  cb({ type: 'none', username: cfg.user });
                  return;
                case 'agent':
                  this.setStatus('authenticating');
                  log.appendLine('[ssh] trying SSH agent ...');
                  cb({ type: 'agent', username: cfg.user, agent: next.agent });
                  return;
                case 'publickey': {
                  this.setStatus('authenticating');
                  log.appendLine(`[ssh] trying ${attemptLabel(next)} ...`);
                  try {
                    const keyData = fs.readFileSync(next.keyPath);
                    let parsed = utils.parseKey(keyData) as unknown;
                    let passphrase: string | undefined;
                    if (parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message)) {
                      passphrase = await vscode.window.showInputBox({
                        title: 'HPC Sync — SSH key passphrase',
                        prompt: `Passphrase for ${next.keyPath}`,
                        password: true,
                        ignoreFocusOut: true,
                      });
                      if (passphrase === undefined) {
                        continue; // user skipped this key: fall through to next method
                      }
                      parsed = utils.parseKey(keyData, passphrase) as unknown;
                    }
                    if (parsed instanceof Error) {
                      log.appendLine(`[ssh] cannot use ${next.keyPath}: ${parsed.message}`);
                      continue;
                    }
                    cb({ type: 'publickey', username: cfg.user, key: keyData, passphrase });
                  } catch (e) {
                    log.appendLine(`[ssh] could not read key: ${(e as Error).message}`);
                    continue;
                  }
                  return;
                }
                case 'keyboard-interactive':
                  this.setStatus('authenticating');
                  cb({
                    type: 'keyboard-interactive',
                    username: cfg.user,
                    // ssh2 calls this with 5 args: (name, instructions, lang, prompts, finish)
                    prompt: (
                      _name: string,
                      instructions: string,
                      _lang: string,
                      prompts: KbdPrompt[],
                      finish: (responses: string[]) => void
                    ) => {
                      void this.answerPrompts(prompts, instructions).then(
                        (answers) => {
                          if (answers === undefined) {
                            userCancelled = true;
                            finish([]);
                          } else {
                            finish(answers);
                          }
                        },
                        () => finish([])
                      );
                    },
                  });
                  return;
                case 'password': {
                  this.setStatus('authenticating');
                  const pw = await vscode.window.showInputBox({
                    title: 'HPC Sync — password',
                    prompt: `Password for ${this.currentTarget}`,
                    password: true,
                    ignoreFocusOut: true,
                  });
                  if (pw === undefined) {
                    userCancelled = true;
                    cb(false);
                    return;
                  }
                  cb({ type: 'password', username: cfg.user, password: pw });
                  return;
                }
              }
            }
          })();
        };

        client.connect({
          host: cfg.host,
          port: 22,
          username: cfg.user,
          tryKeyboard: true,
          keepaliveInterval: 15000,
          keepaliveCountMax: 12,
          // Generous: the user may need time to approve Duo / type a passcode.
          readyTimeout: 180000,
          // Verify the host key (TOFU) — without this ssh2 trusts any key,
          // exposing the password/2FA to a man-in-the-middle.
          hostHash: 'sha256',
          hostVerifier: ((hashedKey: string, cb: (ok: boolean) => void) => {
            void this.verifyHost(cfg.host, hashedKey).then(cb);
          }) as never,
          authHandler: authHandler as never,
        });
      });
    } catch (err) {
      this.cleanup();
      this.setStatus('disconnected');
      throw err;
    }
  }

  private async answerPrompts(
    prompts: KbdPrompt[],
    instructions?: string
  ): Promise<string[] | undefined> {
    const instr = (instructions ?? '').trim();
    if (instr) {
      // Duo lists its options (push / passcode / phone) here — surface it.
      log.appendLine(`[ssh 2fa] ${instr}`);
    }
    if (prompts.length === 0) {
      return [];
    }
    const answers: string[] = [];
    for (const p of prompts) {
      const text = (p.prompt ?? '').trim() || 'SSH authentication';
      const is2fa = /duo|passcode|second factor|two.?factor|otp|verification/i.test(text + ' ' + instr);
      const promptText = instr
        ? `${this.currentTarget}: ${instr.replace(/\s+/g, ' ').slice(0, 400)} — ${text}`
        : `${this.currentTarget}: ${text}`;
      const answer = await vscode.window.showInputBox({
        title: is2fa ? 'HPC Sync — two-factor authentication' : 'HPC Sync — authentication',
        prompt: promptText,
        password: !p.echo,
        ignoreFocusOut: true,
        placeHolder: is2fa ? '2FA code, or Duo option number (e.g. 1 for push)' : undefined,
      });
      if (answer === undefined) {
        return undefined;
      }
      answers.push(answer);
    }
    return answers;
  }

  /** Run a command on the HPC and wait for it to finish. */
  async exec(
    command: string,
    opts: { onStdout?: (s: string) => void; onStderr?: (s: string) => void } = {}
  ): Promise<ExecResult> {
    await this.ensureConnected();
    const client = this.client;
    if (!client) {
      throw new Error('Not connected');
    }
    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        let stdout = '';
        let stderr = '';
        let code = -1;
        stream.on('data', (d: Buffer) => {
          const s = d.toString();
          stdout += s;
          opts.onStdout?.(s);
        });
        stream.stderr.on('data', (d: Buffer) => {
          const s = d.toString();
          stderr += s;
          opts.onStderr?.(s);
        });
        stream.on('exit', (c: number | null) => {
          code = c ?? -1;
        });
        stream.on('close', () => resolve({ code, stdout, stderr }));
        stream.on('error', (e: Error) => reject(e));
      });
    });
  }

  /** Run a command and throw (with stderr context) if it exits non-zero. */
  async execChecked(
    command: string,
    opts: { onStdout?: (s: string) => void; onStderr?: (s: string) => void } = {}
  ): Promise<ExecResult> {
    const res = await this.exec(command, opts);
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout).trim().split('\n').slice(-4).join('\n');
      throw new Error(`Remote command failed (exit ${res.code}): ${command}\n${tail}`);
    }
    return res;
  }

  /** Start a long-running remote command and return the channel (for tail -f etc.). */
  async execStream(command: string): Promise<ClientChannel> {
    await this.ensureConnected();
    const client = this.client;
    if (!client) {
      throw new Error('Not connected');
    }
    return new Promise<ClientChannel>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
        } else {
          resolve(stream);
        }
      });
    });
  }

  /** Abort in-flight SFTP transfers by closing the SFTP channel (a new one is opened on demand). */
  interruptSftp(): void {
    if (this.sftpSession) {
      try {
        this.sftpSession.end();
      } catch {
        /* already closing */
      }
      this.sftpSession = undefined;
      log.appendLine('[ssh] SFTP channel closed to abort in-flight transfers');
    }
  }

  async getSftp(): Promise<SFTPWrapper> {
    await this.ensureConnected();
    if (this.sftpSession) {
      return this.sftpSession;
    }
    const client = this.client;
    if (!client) {
      throw new Error('Not connected');
    }
    return new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        this.sftpSession = sftp;
        sftp.on('close', () => {
          this.sftpSession = undefined;
        });
        resolve(sftp);
      });
    });
  }

  async getHomeDir(): Promise<string> {
    if (this.homeDir) {
      return this.homeDir;
    }
    const res = await this.execChecked('echo $HOME');
    this.homeDir = res.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!this.homeDir) {
      throw new Error('Could not determine remote $HOME');
    }
    return this.homeDir;
  }

  /**
   * Expand ~, $HOME and any other environment variable ($SCRATCH, …) in a
   * remote path so it can be used with SFTP / quoted shell args. Unknown
   * variables are resolved by the remote shell itself.
   */
  async expandRemotePath(p: string): Promise<string> {
    let out = p.trim();
    if (out === '~' || out.startsWith('~/')) {
      out = (await this.getHomeDir()) + out.slice(1);
    }
    if (out.includes('$HOME')) {
      out = out.replace(/\$HOME/g, await this.getHomeDir());
    }
    if (/\$\w/.test(out)) {
      // Escape everything that could execute inside the double quotes — but
      // NOT a bare $VAR (the whole point). Neutralize `` ` `` and `$(` so a
      // path can never trigger command substitution.
      const escaped = out
        .replace(/([\\"`])/g, '\\$1')
        .replace(/\$\(/g, '\\$(');
      const r = await this.exec(`printf %s "${escaped}"`);
      const expanded = r.code === 0 ? r.stdout.trim() : '';
      if (expanded) {
        out = expanded;
      }
    }
    return out;
  }

  /**
   * List a remote directory — fast even for huge directories: a single exec
   * with server-side truncation (one round trip), instead of SFTP readdir
   * which streams the entire listing before we can cap it.
   */
  async listDir(
    remotePath: string,
    limit = 400
  ): Promise<{ entries: Array<{ name: string; size: number; isDir: boolean }>; truncated: boolean }> {
    const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const res = await this.exec(
      `test -d ${shq(remotePath)} && find ${shq(remotePath)} -mindepth 1 -maxdepth 1 -printf '%y|%s|%f\\n' 2>/dev/null | head -n ${limit + 1}`
    );
    if (res.code !== 0 && !res.stdout.trim()) {
      throw new Error(`not a directory or not readable: ${remotePath}`);
    }
    const lines = res.stdout.split('\n').filter((l) => l.length > 0);
    const truncated = lines.length > limit;
    const entries = lines
      .slice(0, limit)
      .map((line) => {
        const i1 = line.indexOf('|');
        const i2 = line.indexOf('|', i1 + 1);
        if (i1 < 0 || i2 < 0) {
          return undefined;
        }
        const type = line.slice(0, i1);
        return {
          name: line.slice(i2 + 1),
          size: parseInt(line.slice(i1 + 1, i2), 10) || 0,
          isDir: type === 'd',
        };
      })
      .filter((e): e is { name: string; size: number; isDir: boolean } => !!e)
      .sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name));
    return { entries, truncated };
  }

  /** Write text content to a remote file (used for generated sbatch scripts). */
  async writeRemoteFile(remotePath: string, content: string, mode = 0o755): Promise<void> {
    const sftp = await this.getSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, Buffer.from(content.replace(/\r\n/g, '\n'), 'utf8'), { mode }, (err) =>
        err ? reject(err) : resolve()
      );
    });
  }

  /** Upload a local file, reporting (transferred, total) progress. */
  async uploadFile(
    localPath: string,
    remotePath: string,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    const sftp = await this.getSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(
        localPath,
        remotePath,
        {
          step: (transferred: number, _chunk: number, total: number) => {
            onProgress?.(transferred, total);
          },
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }
}
