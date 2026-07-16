# Architecture

HPC Sync is a VS Code extension that turns a Slurm + Apptainer cluster into a
development target you can drive from the editor. It has no server component of
its own: every action becomes an ordinary SSH command or SFTP transfer over the
user's own connection.

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│  VS Code UI                                                  │
│   sidebar views: Pipeline · Slurm Jobs · Cluster            │
│   panels: Launch · Job Console · Job Summary · Project Mgr  │
├─────────────────────────────────────────────────────────────┤
│  Services (one instance each, wired in extension.ts)        │
│   SyncEngine · JobsMonitor · ClusterMonitor ·               │
│   UsageAnalytics · StorageBench                             │
├─────────────────────────────────────────────────────────────┤
│  SshManager — one persistent connection, multiplexed        │
│   exec / execChecked / execStream / SFTP / listDir          │
├─────────────────────────────────────────────────────────────┤
│  Cluster: sshd → bash → slurm (squeue/sbatch/...) + apptainer│
└─────────────────────────────────────────────────────────────┘
```

The invariant that shapes everything: **all cluster access goes through one
`SshManager`.** Because a 2FA-mandatory login is expensive, the connection is
opened once and reused by every service and command, so a user authenticates a
single time per session. See [SSH Session Model](SSH-Session-Model).

## Module map (`src/`)

| Module | Responsibility |
|---|---|
| `extension.ts` | Activation entry point: constructs services, registers commands, wires views, owns per-host persisted state helpers. |
| `config.ts` | Reads `hpcSync.*` settings, applies `${workspaceName}` token expansion, derives per-host state-file paths, and provides the `shq()` POSIX shell-quoting helper. |
| `sshManager.ts` | The single SSH connection: auth handler, host-key verification, `exec`/`execChecked`/`execStream`, SFTP upload/list/write, remote path expansion. |
| `sshKeys.ts` / `setup.ts` | SSH key discovery (agent → configured key → `~/.ssh/config` → defaults) and the guided onboarding panel. |
| `syncEngine.ts` | Fast/slow path detection, SFTP incremental sync, image export, and `sbatch` submission with output-path recording. |
| `jobsMonitor.ts` / `jobsView.ts` | Poll `squeue`/`sacct`, compute queue positions, render the live jobs sidebar. |
| `jobOutputPanel.ts` | Streaming (`tail -F`) and static job-log console. |
| `jobSummaryPanel.ts` | Parsed per-job summary: efficiency bars and manifest-based change diffs. |
| `clusterMonitor.ts` / `clusterView.ts` | Poll `sinfo`/`sshare`/`diskusage_report`, render the drag-arrangeable widget dashboard. |
| `analytics.ts` | Cached, remotely-aggregated submission-pattern histogram and timezone handling. |
| `storageBench.ts` | `dd`-based per-filesystem read/write benchmark with timeouts. |
| `launchPanel.ts` | The visual job builder: storage palette, typed pipeline, and `sbatch` script generation. |
| `projectConfig.ts` | `.hpcproject.json` model, built-in templates, and the Dockerfile mount-`ENV` block sync/strip. |
| `projectManager.ts` | Setup detection, template CRUD, image/bundle export, mount management, and the cluster file explorer. |
| `pipelineView.ts` | The primary sidebar: connection status, action buttons, and live sync step list. |

## A request, end to end

Submitting a job from the Launch panel:

1. **UI** — `launchPanel.ts` builds a pipeline model (inputs/workspace/results) and generates an `sbatch` script string. The script is shown in an editable textarea; submitting posts it to the extension host.
2. **Engine** — `SyncEngine.sync({ submitGenerated })` runs an incremental script sync first (so the cluster code matches the editor), then expands any `$VAR`/`~` in the `#SBATCH --output` path, pre-creates the output directory, writes the script over SFTP, and runs `sbatch`.
3. **SSH** — every step above is an `exec`/SFTP call on the shared `SshManager`. No new connection, no new 2FA.
4. **Feedback** — the submitted job ID is parsed, its stdout path recorded per-host, and `JobsMonitor` is nudged to refresh so the job appears in the sidebar; the console and summary panels can then find it even after it ages out of `scontrol`.

## Design principles

- **Single session.** One connection, one authentication; services never open their own. This is the core UX promise on 2FA clusters.
- **Project-agnostic, three binding layers.** Identity (host/user/account) is a *user* setting; project bindings (image, paths, mounts) live in committed repo files; the extension ships only `${workspaceName}`-parameterised defaults. See [Configuration and State](Configuration-and-State).
- **The cluster is the source of truth.** Accounts come from `sacctmgr`, storage from `diskusage_report`, node state from `sinfo`. The extension discovers rather than assumes.
- **Never destructive remotely.** The sync only uploads; it never deletes cluster files. Housekeeping is limited to the extension's own metadata.
- **Paths by name, not by literal.** Data dependencies are declared as named mounts and reach code as environment variables, so the same code runs on the cluster, in a container, or on a laptop. See [Project Mounts and Paths](Project-Mounts-and-Paths).
