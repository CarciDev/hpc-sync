# Sync Engine

`SyncEngine` (`src/syncEngine.ts`) moves the project to the cluster and, when
needed, rebuilds the container image. It reports progress as an ordered list of
steps (connect → detect → rebuild → sync → run/submit) that the Pipeline view
renders live.

## Fast path vs slow path

Change detection compares a hash of the environment files (`Dockerfile` +
`requirements.txt`) against a stored value in a per-host state file
(`.hpc_sync_state.<host>`):

- **Fast path** — environment unchanged. An rsync-style incremental sync of the
  project over SFTP.
- **Slow path** — environment changed (or forced). `docker save` the image →
  upload the tar (resumable via a separate tar-state file) → `apptainer build`
  the `.sif` on the cluster.

The Dockerfile's managed mount-`ENV` block is stripped before hashing, so
editing mounts never triggers a rebuild (see
[Project Mounts and Paths](Project-Mounts-and-Paths)).

## Incremental sync

`collectLocalFiles` walks the workspace honouring nested `.gitignore` and
`.dockerignore` files plus the `hpcSync.excludes` setting, and reports any
unreadable directory rather than silently skipping it. For each candidate file
the remote copy is `stat`ed over SFTP (concurrently, bounded); a file is
uploaded when it is missing remotely, differs in size, or has a different
modification time. After upload the remote mtime is stamped to match the local
one, so the exact-mtime comparison is stable across runs. A configurable
size threshold prompts for confirmation before a large upload, guarding against
accidentally syncing data caches into a small home quota.

## Transfer feedback

Both the image-tar upload and the script sync report rolling-window transfer
speed and ETA. The whole operation runs under a cancellable progress
notification; cancelling aborts in-flight SFTP transfers immediately.

## Submission

`sbatch` submission (from the Launch panel or a picked script) runs a fast sync
first so the cluster code matches the editor, expands and pre-creates the
`--output` directory (Slurm does not expand `~`/`$VAR` in directives), writes
the script over SFTP, and submits. The returned job ID and its resolved stdout
path are recorded per host so the console and summary panels can locate the log
later. Account-rejection errors trigger a probe of the user's real `sacctmgr`
associations and a `--test-only` retry with a validated account.
