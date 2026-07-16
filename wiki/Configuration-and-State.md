# Configuration and State

## Three binding layers

The extension is project-agnostic. Configuration is deliberately split so the
same build works for any user and any project:

| Layer | Where | What belongs here |
|---|---|---|
| **User** | VS Code user settings | Identity: `hpcSync.host`, `.user`, `.allocGroup`, SSH key, and cross-project conventions like `remoteProjectDir = ~/projects/${workspaceName}`. |
| **Project** | committed repo files | `.vscode/settings.json` (image name, remote paths, excludes) and `.hpcproject.json` (mounts). These travel with the repository. |
| **Extension** | built-in defaults | Only `${workspaceName}`-parameterised defaults, so a fresh project works with no configuration. |

`config.ts` reads every `hpcSync.*` setting, expands the `${workspaceName}`
token, and derives per-host state-file paths. It also provides `shq()`, the
POSIX single-quoting helper used at every shell-interpolation site.

## Token expansion

Path-like settings support `${workspaceName}`, which expands to the workspace
folder name. Defaults such as `~/projects/${workspaceName}`,
`${workspaceName}.sif`, and `/workspaces/${workspaceName}` mean opening a new
project needs no per-project path configuration.

## Persisted state

| State | Location | Scope |
|---|---|---|
| Environment / tar hash | `.hpc_sync_state.<host>` (workspace) | per workspace **and host** |
| Job → stdout path map | extension global state | per host |
| Dismissed recent jobs | extension global state | per host |
| Cluster widget layout | extension global state | global |
| Dev-container templates | extension global state | global |
| Submission-pattern cache | extension global state | per host, 12h TTL |
| Storage-benchmark results | extension global state | per host |
| Trusted host keys | extension global state | per host |

State that is meaningful only for a specific cluster is host-scoped, so pointing
one workspace at a second cluster does not reuse the first cluster's "already
built" status or its job-output paths.

## Remote-side metadata

Jobs launched through the extension write small manifests under
`~/.hpcsync_jobs/meta/<jobid>/` (pruned after ~14 days) that power the Job
Summary's change view. Generated `sbatch` scripts are written to
`~/.hpcsync_jobs/` on the cluster. Nothing else is created remotely, and the
extension never deletes user data.
