# Webviews

The UI is built from VS Code webviews: three sidebar views and four panels.

| Kind | Provider | Purpose |
|---|---|---|
| Sidebar view | `pipelineView.ts` | Connection status, sync actions, live step list |
| Sidebar view | `jobsView.ts` | Live Slurm jobs and recent history |
| Sidebar view | `clusterView.ts` | Drag-arrangeable widget dashboard |
| Panel | `launchPanel.ts` | Visual job builder |
| Panel | `jobOutputPanel.ts` | Streaming / static job console |
| Panel | `jobSummaryPanel.ts` | Per-job efficiency and change diff |
| Panel | `projectManager.ts` | Setup, templates, export, mounts, file explorer |

## Model

Each provider renders self-contained HTML with an inline script and a strict
Content-Security-Policy (`default-src 'none'`, script only via a per-render
nonce, no external loads). The extension host and the webview communicate by
message passing: the host posts state snapshots; the webview posts user-command
messages that map to registered commands. Panels use a `ready` handshake so the
first state is not lost; sidebar views push state on their providers' events.

All cluster-derived text (job names, paths, command output, directory listings)
is HTML-escaped before insertion, and the CSP blocks inline event handlers and
external resources as defence in depth.

## Build-time safety net

Because webview scripts are authored inside TypeScript template literals, a
mis-escaped character can produce a script that type-checks but fails at runtime.
`scripts/check-webviews.js` extracts each webview's script exactly as it ships
and compiles it with Node's VM to catch syntax errors; `npm run compile` runs it
after `tsc`, so a broken webview fails the build with the offending lines
printed.

## Cluster dashboard widgets

The Cluster view is a widget board: each section (insights, fair share, compute,
submission pattern, storage, benchmark, project paths, nodes, partitions) is a
draggable, hideable widget. Order and hidden set persist per user; new widgets
append without disturbing a saved layout.
