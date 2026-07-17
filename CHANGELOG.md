# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and the project
follows semantic-ish versioning while pre-1.0.

## [0.15.8]
### Added
- Stage-in progress in the job console: the generated script announces the
  total size up front, a background watcher prints
  "staged X / Y (NN%) - Ns elapsed" every 15 seconds while the copies run,
  and a completion line reports the final size and duration. Percent is
  clamped for auto-extracted tars (extracted bytes can exceed the archive
  size).

## [0.15.7]
### Fixed
- Quick runs ("Run Script..." and the Launch panel's Quick mode) now see
  project mounts: each mount is bind-mounted read-in-place and exposed as
  HPC_MOUNT_<NAME>, exactly like Slurm jobs. Previously the quick-run
  apptainer exec carried no mounts at all, so scripts silently fell back to
  local test data. Mount directories missing on the cluster are skipped with
  a warning instead of aborting the run.

## [0.15.6]
### Fixed
- Only one Connect button while disconnected: the setup wizard's step 5 is
  the connect action; the status card's button appears only once a session
  exists (Disconnect / cancel-while-connecting).

## [0.15.5]
### Changed
- A project mount now appears either in the storage palette OR in the
  pipeline, never both: while its chip sits in INPUTS/RESULTS the palette
  card (and its "+ add" menu entry) is hidden, and it returns the moment the
  chip is removed. Generic storages are unaffected — multiple destinations
  stay legitimate.

## [0.15.4]
### Changed
- Project mounts are INPUTS by default in the Launch panel: declaring a mount
  means "this project's jobs consume that data", so every launch now stages
  it to node-local NVMe ($INPUT_DIR) without a manual drag — remove the chip
  (or trim its paths) for a run that doesn't need the data. A declared mount
  is never silently invisible to a job again.

## [0.15.3]
### Fixed
- **SSH keys now survive dev-container rebuilds.** A rebuild recreates the
  container filesystem, deleting any key generated into the container's
  ~/.ssh — this could silently destroy the registered key (e.g. right after
  the extension's own "rebuild to apply mount ENV" prompt). The key is now
  backed up to VS Code's client-side SecretStorage (the local OS keychain) on
  every successful connect and before every extension-triggered rebuild, and
  restored automatically on activation when ~/.ssh is empty — no
  re-registration needed. The rebuild prompt says so.
### Changed
- "Add mount…" (Projects view) and the Add Project Mount command now open the
  Project Manager scrolled to its mounts section and two-pane Cluster
  explorer — browse the cluster and click "use as mount path" instead of
  typing a path into an input box. The input-box wizard is gone.

## [0.15.2]
### Fixed
- The current workspace no longer shows "no manifest — not synced by HPC
  Sync": having no `.hpcproject.json` just means no mounts are declared
  (normal for a fresh project). Foreign projects without a manifest now say
  "mounts unknown" instead of claiming they weren't synced.
- Storage quotas in the Projects view render as per-filesystem rows with
  usage bars instead of one unreadable run-on line; the "0 mount path(s)"
  line is hidden when there is nothing to count.
### Added
- "Add mount…" on the current project (Projects view) and the
  `HPC Sync: Add Project Mount` command: link an existing cluster directory
  (dataset folder, shared cache…) to the project as a named mount, with a
  remote existence check. Uses the same `.hpcproject.json` + Dockerfile-ENV
  path as the Project Manager — one data model, several entry points — so
  the directory immediately appears in the Launch palette, Projects view and
  Atlas graph.

## [0.15.1]
### Fixed
- Paths now agree across surfaces: the Projects view and Atlas overlay the
  current workspace's LIVE `.hpcproject.json` over the (possibly stale) synced
  copy — badged "local mount edits — run Sync to publish" when they differ,
  and "not on the cluster yet" when the project was never synced. Mount cards
  show the path as declared (`~/…`, `$SCRATCH/…`); expansion is only used
  internally for merging. Editing `.hpcproject.json` rescans automatically.
- Launch panel: the storage palette is now a horizontal strip above the flow,
  so the INPUTS → WORKSPACE → RESULTS columns get the full panel width — no
  more cropped RESULTS column next to a tall palette with dead space below.
### Added
- `scripts/preview-webviews.js`: renders the webviews with realistic sample
  data into `preview/*.html` (theme variables + vscode API stubbed) so layout
  changes can be checked in a browser before packaging.

## [0.15.0]
### Added
- **Projects view** (sidebar): inventory of every project on the cluster —
  manifest mounts, .sif size, and which mounts are shared with which other
  projects. Built from ONE batched SSH scan (directory listing +
  `.hpcproject.json` manifests + `ls -l` on the .sif inventory); no `du`
  sweeps. Cached per host; rescans on connect, after sync/submit, or manually.
- **Project Atlas** (editor panel): bipartite projects ↔ mounts graph with
  hover/pin highlighting and a job-scoped mode that shows only a run's
  project, its bound mounts, and 1-hop neighbouring projects (hidden-node
  count always displayed). Entry points: Projects view, "view relations" in
  the Launch panel, and a Relations button on active jobs.
- Jobs submitted via the Launch panel record their bound mount paths, so the
  Atlas can show a run's relations later.
### Changed
- The sidebar "Pipeline" view is now called **"Sync"** (same view id) — it
  shows sync progress and was colliding in name with the Launch panel's data
  pipeline.
- The Launch panel's data pipeline is now a left→right flow (INPUTS →
  WORKSPACE → RESULTS columns with captioned arrows) using the same node-card
  look as the Atlas, replacing the stacked funnel/pipe rendering. Slot typing,
  drag-and-drop, and the generated sbatch script are unchanged.

## [0.14.5]
### Fixed
- Remote fallback build: COPY destinations under `/tmp`, `/var/tmp` or `$HOME`
  were invisible during `%post` because Apptainer bind-mounts those paths over
  the image while building (the 0.14.4 build failed with "Could not open
  requirements file"). COPY sources are now staged under `/.hpcsync_ctx` and
  replayed inside `%post` at their original Dockerfile position, which also
  preserves docker's COPY/RUN ordering.
- Remote fallback build: `--fakeroot` is retried only when the first attempt
  failed to set up user namespaces/fakeroot — a genuine build-script error no
  longer triggers a pointless second full build.

## [0.14.4]
### Fixed
- Syncing from inside a dev container without a docker CLI no longer dead-ends
  on the rebuild path. When no docker CLI is reachable, the Dockerfile is
  translated to an Apptainer definition (FROM / RUN / COPY / ADD / ENV / ARG /
  WORKDIR; runtime-only instructions are ignored), the definition and its COPY
  sources are uploaded, and the .sif is built directly on the cluster over the
  existing SSH session. Dockerfiles beyond that subset still get the previous
  guidance (docker-outside-of-docker feature, local window, or Mark Env As
  Built).
- The docker CLI is no longer required when the image tar from a previous run
  is already on the cluster — only the export step needs it.

## [0.14.1]
### Added
- Auto-detect the VS Code dev-container image (`vsc-<folder>-<hash>`) on the
  rebuild path instead of requiring `hpcSync.dockerImageName` to be set by hand;
  the detected value is saved to the project.

## [0.14.0]
### Added
- Inline onboarding wizard in the Pipeline view: fill host, username, account,
  and SSH key step by step instead of using opaque buttons.
- "Show SSH Public Key" command that displays the public key, copies it, and
  opens the CCDB page to register it — surfaced automatically when a connection
  fails on authentication.
### Changed
- Connection failures that look like authentication problems point to key
  registration.
### Docs
- Dev-container persistence and Settings Sync guidance in the README.

## [0.13.1]
### Security
- Verify the SSH host key (trust-on-first-use) instead of accepting any key,
  preventing a man-in-the-middle from capturing the password/2FA exchange.
- Harden remote variable expansion against command substitution.
- Validate Slurm job IDs before they reach `scontrol`/`scancel`/`sacct`.

## [0.13.0]
### Fixed
- Exact modification-time comparison in the file sync (a tolerance window could
  make same-size edits skip forever).
- Stage-out trap made re-entrant and non-aborting so every destination is
  delivered on time-limit or partial failure.
- `stripMountEnvBlock` canonicalises trailing whitespace so a first mount add no
  longer changes the environment hash (no spurious rebuild).
- Unreadable local directories are reported instead of silently dropped.
- `$VAR` paths (e.g. `$SCRATCH`) expand correctly for `mkdir`, `--output`, and
  output-path resolution.
- Per-host state files and job-output store so switching clusters is safe.
- Node-state parsing, held-job priority display, timezone-correct estimated
  start, empty-account handling, quick-run output fallback, bundle path slicing.

## [0.12.3]
### Changed
- Destination before/after diffing is opt-in; the cheap produced-files manifest
  stays on, avoiding slow scans of huge shared output directories.

## [0.12.2]
### Changed
- Removed remaining project-specific defaults; the extension is fully generic.

## [0.12.1]
### Added
- `hpcSync.autoRebuildDevcontainer` (`prompt`/`always`/`never`) to rebuild the
  dev container when the extension edits the Dockerfile.

## [0.12.0]
### Added
- Hybrid mount defaults: mount paths are mirrored into a managed `ENV` block in
  the Dockerfile (excluded from rebuild detection) so images carry the paths
  while edits stay free.

## [0.11.3]
### Added
- Optional portability shim (`hpcproject.py` / `hpcproject.env.sh`) so mounts
  resolve without the extension, VS Code, or the cluster.

## [0.11.0] – [0.11.2]
### Added
- Project paths widget (mount names, env vars, copy/insert Python snippets).
### Changed
- Decoupled identity (user settings) from project bindings (repo files);
  tokenised all defaults with `${workspaceName}`.

## [0.10.0] – [0.10.5]
### Added
- Project manager: setup detection, CRUD dev-container templates, `.sif` export,
  deployable bundle export, and project mounts stored in `.hpcproject.json`.
- Two-pane cluster file explorer with server-side directory listing.
- `HPC_MOUNT_<NAME>` environment variables and automatic bind mounts for jobs.

## [0.9.0] – [0.9.3]
### Added
- Job summary panel with CPU/memory efficiency and manifest-based change
  tracking of what a job wrote.
- Cluster/local dual timezone on the submission-pattern chart.
- Fair-share decay/reset timing.

## [0.8.0] – [0.8.6]
### Added
- Live streaming job console (`tail -F`) and full logs for finished jobs.
- Funnel-style pipeline visual; cleaner job cards; queue progress bar and
  estimated start; dismissible recent jobs.
- Webview syntax-check build gate.

## [0.7.0] – [0.7.1]
### Added
- Typed-slot pipeline builder (inputs / workspace / results) with drag-and-drop.
- Automatic Slurm account discovery and validation.

## [0.6.0]
### Added
- Node-local `$SLURM_TMPDIR` staging with trap-guarded copy-back.
- Timeouts on storage benchmarks.

## [0.5.0] – [0.5.1]
### Added
- Launch panel: build and submit a Slurm job from a Python file with suggested
  resources based on load, fair share, and submission patterns.

## [0.4.0]
### Added
- Cluster dashboard as a drag-to-arrange, hideable widget board.

## [0.3.0] – [0.3.1]
### Added
- Queue position and priority, fair-share view, cached submission-pattern chart,
  and per-filesystem storage benchmarks.
- Sync exclusion patterns, large-upload confirmation, and hard cancel.

## [0.2.0]
### Added
- Cluster view (storage quotas, node/CPU/GPU/memory utilisation).
- Transfer speed and ETA; automatic reconnection handling.

## [0.1.0]
### Added
- Initial release: fast/slow-path sync, Slurm jobs view, single-session SSH with
  one-time 2FA, pipeline view, and SSH onboarding.

[0.14.0]: ../../releases/tag/v0.14.0
[0.13.1]: ../../releases/tag/v0.13.1
[0.13.0]: ../../releases/tag/v0.13.0
[0.12.0]: ../../releases/tag/v0.12.0
[0.11.0]: ../../releases/tag/v0.11.0
[0.10.0]: ../../releases/tag/v0.10.0
[0.9.0]: ../../releases/tag/v0.9.0
[0.8.0]: ../../releases/tag/v0.8.0
[0.7.0]: ../../releases/tag/v0.7.0
[0.6.0]: ../../releases/tag/v0.6.0
[0.5.0]: ../../releases/tag/v0.5.0
[0.4.0]: ../../releases/tag/v0.4.0
[0.3.0]: ../../releases/tag/v0.3.0
[0.2.0]: ../../releases/tag/v0.2.0
[0.1.0]: ../../releases/tag/v0.1.0
