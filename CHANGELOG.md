# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and the project
follows semantic-ish versioning while pre-1.0.

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
