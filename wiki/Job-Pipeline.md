# Job Pipeline

The Launch panel (`src/launchPanel.ts`) turns a Python file into a Slurm job
through a visual data pipeline and generates the `sbatch` script from it.

## Modes

- **Quick run** — execute on the login node over the shared session. For short,
  light tasks only.
- **Slurm job** — build and submit an `sbatch` script.

## The pipeline

Storage is configured as a typed flow with three role slots, so only valid data
flows can be constructed:

```
        start
          │
      ┌ INPUTS ──────────────┐   0..n sources; each rsync'd (or tar-extracted)
      │ project / scratch /  │   into $INPUT_DIR before the run
      │ a project mount / …  │
      └──────────────────────┘
          │  stage-in
      ┌ WORKSPACE ───────────┐   exactly one: $SLURM_TMPDIR (node-local NVMe)
      │ $SLURM_TMPDIR        │   or "run in place"
      └──────────────────────┘
          │  compute (apptainer exec)
      ┌ RESULTS ─────────────┐   1..n destinations; primary receives OUTPUT_DIR,
      │ project / nearline / │   others get a mirror copy
      │ … (not $SLURM_TMPDIR)│
      └──────────────────────┘
          │  trap-guarded copy-back
        end
```

Chips are added by drag-and-drop from a storage palette or an explicit "add"
button. Slot capabilities make invalid arrangements impossible: `$SLURM_TMPDIR`
can only be the workspace and never a destination; adding a stage-in source
requires (and auto-selects) a node-local workspace. Each palette entry shows the
storage's quota, benchmark speed, and lifetime (e.g. scratch purge policy).

## Staging and copy-back

When the workspace is `$SLURM_TMPDIR`, the generated script computes in
node-local NVMe and copies results out to every destination through a `trap` on
`EXIT`/`TERM`, so results are delivered even on time-limit or failure. The trap
is re-entrant (it will not run twice when both signals fire) and does not abort
between destinations if one fails.

## Suggested resources

`sendInit` gathers current cluster load, the user's fair-share standing, and the
cached submission-pattern window to suggest when to submit and to fill modest,
fast-scheduling defaults. GPU-only allocations are detected from `sacctmgr`
associations and default the GPU count to at least one.

## Generation

The `sbatch` script is derived from the pipeline graph and shown in an editable
textarea — what you see is exactly what is submitted. Project mounts used in the
pipeline contribute `apptainer --bind` lines and `HPC_MOUNT_<NAME>` environment
variables automatically. An optional destination diff records before/after
manifests for the Job Summary's change view.
