# Goal: Projects view + Project Atlas (mount-relations graph)

## Problem

HPC Sync is single-project-centric: the only cluster-wide surfaces are the
Cluster dashboard widgets. There is no way to see all projects on the cluster,
what mounts they declare, or how projects relate through shared mounts. The
Launch panel's "Data pipeline" builder has the right model (palette + typed
slots INPUTS → WORKSPACE → RESULTS) but a confusing presentation: stacked
dashed boxes of decreasing width read as nesting, not flow; no arrows; the
stage-in relationship only appears as a status note. The sidebar "Pipeline"
view (sync progress) also collides in name with the Launch "Data pipeline".

## Deliverables (in build order)

### 1. Rename the sidebar "Pipeline" view to "Sync"
Display name only — keep the `hpcSync.pipeline` view id and all command ids
stable.

### 2. Remote project discovery (no new remote state)
On connect, after each sync/submit, and on manual refresh — never on the poll
loop — run ONE batched SSH exec over the existing shared session:
- `ls -1 <projectsParent>` where projectsParent = dirname of the expanded
  `hpcSync.remoteProjectDir` (expand `~`/`$VARS` via `SshManager.expandRemotePath`).
- `for f in <projectsParent>/*/.hpcproject.json; do echo "### $f"; cat "$f"; done`
  (synced projects carry `.hpcproject.json` to the cluster already).
- `ls -l <remoteSifDir>/*.sif` for image names + sizes (NO `du` — per-directory
  size sweeps are explicitly OUT OF SCOPE, they are too expensive on shared FS).

Parse into: projects (name, remote dir, manifest?, sif size/mtime?) and mount
nodes keyed by NORMALIZED path (strip trailing slashes, expand `~`/`$SCRATCH`);
a mount node keeps all alias names used by different projects. Edge =
project's manifest names that path. Projects without a manifest render as
nodes labeled "not synced by HPC Sync" with no edges.

Cache the snapshot in a per-host memento with a scannedAt timestamp (state is
per-host everywhere else in the extension — follow that).

### 3. Sidebar "Projects" view (4th webview view, `hpcSync.projects`)
Peer of Pipeline/Jobs/Cluster in the `hpcSync` container. Contents:
- One row per project: name, `.sif` size + built✓, mount names, "shares X
  with Y" line. The current-workspace project is expanded by default and gets
  full actions (Sync / Launch / Bundle); other projects get inspect/clean only
  (open remote shell there, delete stale `.sif` with confirmation).
- Mounts summary line (mount → dependent count).
- Quota line reused from the existing `diskusage_report` data in ClusterMonitor.
- "last scanned N min ago" + ⟳ refresh + "Open Project Atlas" button.

### 4. Project Atlas (WebviewPanel, like LaunchPanel/ProjectManager)
Bipartite graph: project cards (left column) ↔ mount cards (right column),
SVG edges. Two fixed columns, deterministic layout — NOT force-directed.
Interactions: hover highlights the 1-hop neighbourhood; click a mount lists
dependent projects; click a project shows a side card (manifest, sif, actions).
Modes: "All" and "Job" — job mode shows only: the job's project + the mounts
that job binds + other projects sharing those mounts (1 hop), plus a visible
count of hidden nodes (never silently truncate). Entry points: Projects view
button, a "view relations" affordance in the Launch panel, and running jobs in
the Jobs view.

### 5. Record job → mounts at submit time
When the Launch panel submits, it already knows the bound mount names
(palette entries with `mountName`). Persist `{jobId → mountNames[]}` alongside
the existing job-output record so the Atlas job mode works for
running/finished jobs without re-parsing sbatch scripts.

### 6. Re-render the Launch "Data pipeline" with the shared visual grammar
KEEP: palette, drag-and-drop, typed slots and their validation rules ("only
$SLURM_TMPDIR can be a workspace, never a destination"), generated-script
preview, all message protocol/ids.
REPLACE: the three stacked dashed boxes with a left→right directed flow —
slots become labeled COLUMNS (INPUTS → WORKSPACE → RESULTS) of node cards with
explicit arrows, stage-in drawn as an arrow into $SLURM_TMPDIR. Use the same
node-card renderer as the Atlas so both surfaces share one visual language.
This is the only risky UI surgery — ship it last, after 1–5 are working.

## Hard constraints (repo conventions)
- Webviews: inline hand-written JS only, NO external libraries/CDN; every
  webview script must pass `node scripts/check-webviews.js` (runs in
  `npm run compile`).
- All remote access through the shared `SshManager` session (2FA answered
  once); batch commands to minimize round trips; `shq()` every interpolated
  path.
- Per-host scoping for any persisted state.
- Existing view/command ids must not change.
- TypeScript strict compile clean: `./node_modules/.bin/tsc -p ./`.
- Bump version + CHANGELOG entry per release habit.

## Verification
- Compile + check-webviews gate.
- Package vsix and exercise in the test project (nisar_test_extension) against
  the real cluster: discovery sweep timing (must feel instant on a login
  node), Projects view rendering with ≥2 projects sharing a mount, Atlas All
  and Job modes, Launch panel still generates byte-identical sbatch scripts
  for an unchanged pipeline (regression guard for step 6).
