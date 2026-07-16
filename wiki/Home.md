# HPC Sync — Wiki

Developer and architecture documentation for the HPC Sync VS Code extension.

## Contents

- **[Architecture](Architecture)** — the big picture: layers, module map, and how a request flows from a button click to a command on the cluster.
- **[SSH Session Model](SSH-Session-Model)** — the single shared connection, authentication, host-key verification, and how everything multiplexes over it.
- **[Sync Engine](Sync-Engine)** — fast/slow path detection, the SFTP incremental sync, and image export.
- **[Job Pipeline](Job-Pipeline)** — the visual job builder, staging, and `sbatch` generation.
- **[Project Mounts and Paths](Project-Mounts-and-Paths)** — `.hpcproject.json`, the hybrid Dockerfile `ENV` block, and how paths reach your code.
- **[Webviews](Webviews)** — the panel/view model and the build-time safety net.
- **[Configuration and State](Configuration-and-State)** — settings layers, tokenised defaults, and persisted state.

## Orientation

The extension is a TypeScript VS Code extension. There is no bundled backend; it drives the cluster entirely through a user's SSH connection using ordinary Slurm and Apptainer commands. The UI is a set of webview panels and sidebar views; the logic lives in a handful of service classes that all share one SSH connection.

Start with [Architecture](Architecture), then read the subsystem page for whatever you are changing.
