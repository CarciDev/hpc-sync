import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig, shq } from './config';
import { log } from './log';
import { SshManager } from './sshManager';
import { agentSocket, discoverKeys, generateKey, KeyCandidate, publicKeyText } from './sshKeys';

interface SetupItem extends vscode.QuickPickItem {
  action: 'test' | 'generate' | 'install' | 'pick' | 'log' | 'settings';
}

/**
 * Onboarding: shows what auth material the extension can see from where it is
 * running (local vs dev container), and offers to generate/install a key.
 */
export async function setupCommand(ssh: SshManager): Promise<void> {
  for (;;) {
    const cfg = getConfig();
    const keys = discoverKeys(cfg);
    const agent = agentSocket();
    const remote = vscode.env.remoteName;

    const report: string[] = [];
    report.push(
      `Extension host: ${remote ? `remote (${remote})` : 'local'} · ${process.platform} · home=${os.homedir()}`
    );
    report.push(`Target: ${cfg.user}@${cfg.host}`);
    report.push(agent ? `SSH agent: available (${agent})` : 'SSH agent: NOT detected');
    if (keys.length) {
      for (const k of keys) {
        report.push(`Private key (${k.source}): ${k.path}`);
      }
    } else {
      report.push(
        'No private keys found — checked hpcSync.privateKeyPath, ~/.ssh/config IdentityFile, ~/.ssh/id_ed25519|id_ecdsa|id_rsa'
      );
    }
    if (remote && keys.length === 0) {
      report.push(
        'NOTE: the extension runs inside the dev container, so keys on your Windows host are NOT visible here. ' +
          'Options: (a) on Windows run "ssh-add" (the agent is forwarded into containers), ' +
          '(b) generate a key here and install it on the cluster, or (c) set hpcSync.privateKeyPath to a mounted key.'
      );
    }
    log.appendLine('\n== SSH setup diagnostics ==');
    for (const r of report) {
      log.appendLine('  ' + r);
    }

    const authChain = `${agent ? 'agent → ' : ''}${keys.length} key(s) → password+2FA`;
    const items: SetupItem[] = [
      {
        label: '$(beaker) Test connection now',
        detail: `Connect to ${cfg.user}@${cfg.host} — auth chain: ${authChain}`,
        action: 'test',
      },
      {
        label: '$(key) Generate a new SSH key (ed25519)',
        detail: 'Created in ~/.ssh via ssh-keygen and set as hpcSync.privateKeyPath',
        action: 'generate',
      },
      {
        label: '$(cloud-upload) Install a public key on the cluster',
        detail: 'Appends it to ~/.ssh/authorized_keys on the HPC (asks password + 2FA once)',
        action: 'install',
      },
      {
        label: '$(folder-opened) Pick an existing private key file…',
        detail: 'Sets hpcSync.privateKeyPath (useful for non-standard key names/locations)',
        action: 'pick',
      },
      {
        label: '$(output) Show diagnostics in the log',
        detail: report[0],
        action: 'log',
      },
      {
        label: '$(gear) Open settings',
        detail: 'Host, user, key path, remote paths…',
        action: 'settings',
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: 'HPC Sync — SSH setup',
      placeHolder: `${keys.length} key(s) found · agent ${agent ? 'available' : 'not detected'} · ${
        remote ? 'running in ' + remote : 'running locally'
      }`,
      ignoreFocusOut: true,
    });
    if (!pick) {
      return;
    }
    switch (pick.action) {
      case 'test': {
        try {
          await ssh.ensureConnected();
          void vscode.window.showInformationMessage(
            `HPC Sync: connected to ${cfg.user}@${cfg.host}. The session is now shared by all operations.`
          );
          return;
        } catch (e) {
          const choice = await vscode.window.showErrorMessage(
            `HPC Sync: connection failed — ${(e as Error).message}`,
            'Show Log'
          );
          if (choice) {
            log.show(true);
          }
          break; // back to the menu
        }
      }
      case 'generate':
        await generateFlow(ssh);
        break;
      case 'install':
        await installFlow(ssh, keys);
        break;
      case 'pick': {
        const uris = await vscode.window.showOpenDialog({
          title: 'Select your SSH private key',
          defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')),
          canSelectMany: false,
          openLabel: 'Use this key',
        });
        if (uris?.[0]) {
          await vscode.workspace
            .getConfiguration('hpcSync')
            .update('privateKeyPath', uris[0].fsPath, vscode.ConfigurationTarget.Global);
          void vscode.window.showInformationMessage(
            `HPC Sync: will try ${uris[0].fsPath} first when connecting.`
          );
        }
        break;
      }
      case 'log':
        log.show(false);
        break;
      case 'settings':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:david-carciente.hpc-sync'
        );
        return;
    }
  }
}

async function generateFlow(ssh: SshManager): Promise<void> {
  const cfg = getConfig();
  const sshDir = path.join(os.homedir(), '.ssh');
  fs.mkdirSync(sshDir, { recursive: true });
  const defaultPath = fs.existsSync(path.join(sshDir, 'id_ed25519'))
    ? path.join(sshDir, 'id_ed25519_hpcsync')
    : path.join(sshDir, 'id_ed25519');

  const target = await vscode.window.showInputBox({
    title: 'HPC Sync — generate SSH key (1/2)',
    prompt: 'File for the new private key',
    value: defaultPath,
    ignoreFocusOut: true,
  });
  if (!target) {
    return;
  }
  if (fs.existsSync(target)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${target} already exists. Overwrite it?`,
      { modal: true },
      'Overwrite'
    );
    if (overwrite !== 'Overwrite') {
      return;
    }
    fs.rmSync(target, { force: true });
    fs.rmSync(target + '.pub', { force: true });
  }
  const passphrase = await vscode.window.showInputBox({
    title: 'HPC Sync — generate SSH key (2/2)',
    prompt: 'Passphrase for the key (leave empty for none)',
    password: true,
    ignoreFocusOut: true,
  });
  if (passphrase === undefined) {
    return;
  }
  try {
    await generateKey(target, passphrase, `${cfg.user}@hpc-sync`);
  } catch (e) {
    void vscode.window.showErrorMessage(`HPC Sync: ${(e as Error).message}`);
    return;
  }
  await vscode.workspace
    .getConfiguration('hpcSync')
    .update('privateKeyPath', target, vscode.ConfigurationTarget.Global);
  log.appendLine(`[setup] generated ${target} and set hpcSync.privateKeyPath`);

  const next = await vscode.window.showInformationMessage(
    `HPC Sync: key generated at ${target}. Install its public key on ${cfg.host} now? ` +
      '(You will authenticate once with password + 2FA.)',
    'Install on cluster',
    'Later'
  );
  if (next === 'Install on cluster') {
    await installFlow(ssh, [{ path: target, source: 'setting' }]);
  }
}

async function installFlow(ssh: SshManager, keys: KeyCandidate[]): Promise<void> {
  const cfg = getConfig();
  if (keys.length === 0) {
    void vscode.window.showWarningMessage(
      'HPC Sync: no private key found to install. Generate or pick one first.'
    );
    return;
  }
  let keyPath = keys[0].path;
  if (keys.length > 1) {
    const pick = await vscode.window.showQuickPick(
      keys.map((k) => ({ label: k.path, description: k.source })),
      { title: 'HPC Sync — which key should be installed on the cluster?', ignoreFocusOut: true }
    );
    if (!pick) {
      return;
    }
    keyPath = pick.label;
  }
  const pub = publicKeyText(keyPath);
  if (!pub) {
    void vscode.window.showErrorMessage(
      `HPC Sync: could not read or derive the public key for ${keyPath} ` +
        '(missing .pub file and the key is encrypted). Locate the .pub file and retry.'
    );
    return;
  }
  try {
    await ssh.ensureConnected();
    const line = pub.replace(/\r?\n/g, ' ').trim();
    await ssh.execChecked(
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ' +
        `{ grep -qxF ${shq(line)} ~/.ssh/authorized_keys || echo ${shq(line)} >> ~/.ssh/authorized_keys; }`
    );
    log.appendLine(`[setup] installed public key of ${keyPath} into ~/.ssh/authorized_keys on ${cfg.host}`);
    const choice = await vscode.window.showInformationMessage(
      'HPC Sync: public key installed on the cluster. Future connections will use it (2FA still applies, once per session). ' +
        'Alliance also lets you register keys centrally via CCDB.',
      'Open CCDB'
    );
    if (choice === 'Open CCDB') {
      void vscode.env.openExternal(vscode.Uri.parse('https://ccdb.alliancecan.ca/ssh_authorized_keys'));
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`HPC Sync: installing the key failed — ${(e as Error).message}`);
  }
}
