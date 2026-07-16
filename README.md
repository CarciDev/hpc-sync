# HPC Sync

A Visual Studio Code extension for developing against Slurm HPC clusters without leaving the editor. It syncs your project to the cluster, rebuilds the Apptainer/Singularity image when the environment changes, builds and submits Slurm jobs from a visual pipeline, and monitors the queue live — all over a single shared SSH session so two-factor authentication is answered once per session.

Built for [Alliance Canada](https://alliancecan.ca/) clusters (Narval, Rorqual, and similar), but the mechanisms are generic Slurm + Apptainer and it is project-agnostic: your identity lives in user settings, project bindings live in the repository, and every default is parameterised by the workspace name.

## Highlights

- **One authentication per session.** A single persistent SSH connection is multiplexed across every operation — file sync, image build, `sbatch`, `squeue` polling, log tailing. With a 2FA-mandatory cluster you approve one prompt and keep working. Host keys are verified (trust-on-first-use) to protect the credential exchange.
- **Fast/slow path sync.** Only scripts changed? An rsync-style incremental upload over SFTP (honours `.gitignore`/`.dockerignore`). Environment changed (`Dockerfile`/`requirements.txt`)? A `docker save` → upload → `apptainer build` rebuild, with transfer speed and ETA.
- **Visual job builder.** Turn a Python file into a Slurm job through a typed data pipeline: **inputs → workspace → results**. Choose node-local NVMe (`$SLURM_TMPDIR`) staging with trap-guarded copy-back, pick output storage by quota/speed/lifetime, and edit the generated `sbatch` script inline before submitting.
- **Live monitoring.** A jobs panel with colour-coded states, queue position, priority, estimated start, and elapsed-vs-limit progress bars; a streaming console (`tail -F`) for running jobs and a full log for finished ones; a per-job summary with CPU/memory efficiency and a manifest-based diff of what the job wrote.
- **Cluster dashboard.** A drag-to-arrange widget board: storage quotas, node/CPU/GPU utilisation, fair-share standing with decay/reset timing, a cached submission-pattern chart that recommends the quietest submission window (in both cluster and local time), and per-filesystem read/write benchmarks.
- **Project manager.** Scaffold a dev container from CRUD-able templates, export the environment as a `.sif` or a fully self-contained deployable bundle, and declare **project mounts** — named cluster directories (datasets, shared caches) stored in a versionable `.hpcproject.json`, browsable in a two-pane cluster explorer, bind-mounted into jobs, and exposed to code as `HPC_MOUNT_<NAME>` environment variables.

## Requirements

- VS Code 1.85 or newer.
- An account on a Slurm cluster reachable over SSH (SSH agent, key, or password + 2FA all supported).
- Docker on the machine running the extension **only if** you use the environment-rebuild (slow) path; script sync, job submission and monitoring need no local Docker.

## Installation

Download the latest `hpc-sync-<version>.vsix` from the [Releases](../../releases) page and install it:

```bash
code --install-extension hpc-sync-<version>.vsix
```

Then reload the window.

## Quick start

1. Set your identity once, at the user level (`Ctrl+,` → search "hpcSync"):
   - `hpcSync.host` — the login node, e.g. `narval.alliancecan.ca`
   - `hpcSync.user` — your cluster username
   - `hpcSync.allocGroup` — your allocation/account, e.g. `def-yourpi`
2. Open the **HPC Sync** icon in the activity bar and click **Connect** (or run `HPC Sync: Setup SSH` for a guided key setup).
3. Press **Sync** to push your project, or open a Python file and click the **launch** (rocket) button in the editor toolbar to build and submit a job.

Per-project values (Docker image name, remote paths, excludes, mounts) belong in the project's `.vscode/settings.json` and `.hpcproject.json` so they travel with the repository. Anything unset falls back to a `${workspaceName}`-based default.

## Configuration

All settings are under the `hpcSync.*` namespace and documented in the settings UI. Notable ones:

| Setting | Scope | Purpose |
|---|---|---|
| `hpcSync.host` / `.user` / `.allocGroup` | user | Your cluster identity |
| `hpcSync.privateKeyPath` | user | Explicit SSH key (agent and default keys are tried automatically) |
| `hpcSync.remoteProjectDir` | project | Where scripts are synced (default `~/projects/${workspaceName}`) |
| `hpcSync.dockerImageName` | project | Local image to export on the slow path |
| `hpcSync.excludes` | project | Extra sync-exclusion patterns for large data caches |
| `hpcSync.autoRebuildDevcontainer` | user | `prompt` / `always` / `never` when the Dockerfile changes |

## Development

```bash
npm install
npm run compile        # tsc + webview syntax check
npm run watch          # incremental build
```

Press `F5` in VS Code to launch an Extension Development Host. Build a distributable package with:

```bash
npx @vscode/vsce package
```

See the [project wiki](../../wiki) for the architecture, the module map, and the design rationale behind the SSH session model, the sync engine, the mount system, and the webview approach.

## License

MIT — see [LICENSE](LICENSE).
