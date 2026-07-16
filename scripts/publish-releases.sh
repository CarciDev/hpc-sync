#!/usr/bin/env bash
#
# Publish a GitHub release for every version tag, attaching the matching
# pre-built VSIX from ./dist. Run once after pushing tags to GitHub.
#
# Requires: the GitHub CLI (`gh`) authenticated for this repository.
#
#   ./scripts/publish-releases.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v gh >/dev/null 2>&1; then
  echo "error: the GitHub CLI (gh) is required and must be authenticated." >&2
  exit 1
fi

for tag in $(git tag --sort=version:refname); do
  version="${tag#v}"
  vsix="dist/hpc-sync-${version}.vsix"
  echo "== $tag =="
  if gh release view "$tag" >/dev/null 2>&1; then
    echo "  release already exists — skipping"
    continue
  fi
  args=(release create "$tag" --title "$tag" --notes "See CHANGELOG.md for details.")
  if [[ -f "$vsix" ]]; then
    args+=("$vsix")
  else
    echo "  note: $vsix not found — creating release without an artifact"
  fi
  gh "${args[@]}"
done

echo "Done."
