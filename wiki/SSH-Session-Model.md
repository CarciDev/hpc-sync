# SSH Session Model

`SshManager` (`src/sshManager.ts`) owns a single persistent SSH connection to
the login node. Every service and command multiplexes over it. This is the
extension's defining constraint: on a cluster where multi-factor authentication
is mandatory, opening a connection per operation would prompt for 2FA
repeatedly, so exactly one connection is opened and reused.

## Connecting

`ensureConnected()` is idempotent and race-safe: concurrent callers await the
same in-flight connect promise, so a burst of operations at startup produces one
connection, not many. Status transitions (`disconnected → connecting →
authenticating → connected`) are emitted so every view can reflect connection
state.

## Authentication

The auth handler tries methods in the same order as the OpenSSH client, so a
working `ssh user@host` implies a working extension connection:

1. SSH agent (Windows OpenSSH pipe or `$SSH_AUTH_SOCK`)
2. `hpcSync.privateKeyPath` if set
3. `IdentityFile` entries from `~/.ssh/config` matching the host
4. Default keys (`id_ed25519`, `id_ecdsa`, `id_rsa`)
5. Keyboard-interactive (password + 2FA/Duo prompt)
6. Password

Encrypted keys prompt for their passphrase; 2FA prompts surface as input boxes
and the Duo option menu (push/passcode/phone) is shown. Credentials are only
ever passed to the SSH library — they are never logged or persisted.

## Host-key verification

The connection verifies the server's host key on a trust-on-first-use basis.
On first connection the SHA-256 fingerprint is shown for confirmation and then
stored per host; on a later mismatch the connection is refused with a
man-in-the-middle warning unless the user explicitly confirms a legitimate
rekey. Without this, the SSH library would accept any key and a network attacker
could capture the password and 2FA passcode.

## Multiplexed operations

Everything the extension does on the cluster is one of:

- `exec(cmd)` — run a command, collect stdout/stderr/exit code.
- `execChecked(cmd)` — the same, throwing on non-zero exit with a stderr tail.
- `execStream(cmd)` — a long-lived channel for `tail -F` log streaming.
- SFTP `uploadFile` / `writeRemoteFile` / `listDir` — file transfer and, for the
  file explorer, directory listing (server-side truncated with `find … | head`
  so huge directories list instantly).
- `expandRemotePath(p)` — resolves `~`, `$HOME`, and any other `$VAR` (via the
  remote shell) so client-built paths match what the cluster shell would see.

## Resilience

Keepalives detect dead connections; an unexpected drop surfaces a reconnect
prompt and any subsequent operation reconnects on demand. Shell-interpolated
arguments are quoted with `shq()` (POSIX single-quoting) at every call site that
includes a path or user value.
