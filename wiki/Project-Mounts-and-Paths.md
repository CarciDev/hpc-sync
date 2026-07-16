# Project Mounts and Paths

A **mount** is a named cluster directory a project depends on but does not own —
a dataset, a shared cache. Mounts make that dependency explicit, versionable,
and portable, the way `requirements.txt` does for Python packages.

## Declaration

Mounts live in `.hpcproject.json` at the workspace root (committed with the
repo):

```json
{ "mounts": [
  { "name": "datasets", "path": "/project/def-pi/user/Datasets", "purpose": "training data" }
] }
```

The Project Manager adds them via a two-pane cluster explorer (browse a
directory before committing it) and can verify they exist on the cluster.

## How a path reaches your code

Code never reads `.hpcproject.json`. It reads an environment variable; the value
is delivered by whichever environment it runs in:

| Where the code runs | Who sets `HPC_MOUNT_DATASETS` | Value |
|---|---|---|
| Cluster job (Launch panel) | the generated `sbatch` script (`--bind` + `--env`) | current path from `.hpcproject.json` |
| Any container run of the image | the baked Dockerfile `ENV` block | path as of the last image build |
| Local dev container | the baked `ENV` block (a cluster path) | override locally or rely on a fallback |
| Bare Python, no container | nothing | the fallback in your code |

Precedence: runtime `--env` › baked image `ENV` › the fallback in code. The
recommended code pattern makes all cases work without hardcoding a path:

```python
DATASETS = Path(os.environ.get("HPC_MOUNT_DATASETS", "local_data/datasets"))
```

The environment-variable name is the mount name uppercased with non-alphanumerics
replaced by `_` (`s1-raw` → `HPC_MOUNT_S1_RAW`), implemented once in
`projectConfig.mountEnvName`.

## The hybrid Dockerfile block

So that images carry canonical paths without extra files, the mount list is
mirrored into a managed block in the Dockerfile:

```dockerfile
# >>> hpc-sync mounts (managed — edit via .hpcproject.json) >>>
ENV HPC_MOUNT_DATASETS="/project/def-pi/user/Datasets"
# <<< hpc-sync mounts <<<
```

`.hpcproject.json` stays the editable source of truth; the block is regenerated
on every mount change. Critically, `stripMountEnvBlock` removes this block (and
canonicalises trailing whitespace) before the environment hash is computed, so
editing mounts is metadata-only and never triggers an image rebuild. The baked
defaults refresh at the next real rebuild; until then, jobs still get the current
path injected at submit time.

## Export and portability

The Project Manager can export the environment as a `.sif`, or a fully
self-contained **deployable bundle** (a cluster-side tar of the image, the
project code, and any selected mount directories) for handing the whole project
to someone else. An optional shim (`hpcproject.py` / `hpcproject.env.sh`)
resolves mounts with no tooling at all, for running the code outside any
container.
