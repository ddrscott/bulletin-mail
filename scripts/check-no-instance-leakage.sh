#!/usr/bin/env bash
# Fail if any deployment-specific apex domain leaks into generic code.
#
# Distinction (matters):
#   - The bare token 'bulletinmail' is the PROJECT's identity — npm scope
#     '@bulletinmail/*', wrangler service names like 'bulletinmail-inbound',
#     D1 database name 'bulletinmail'. These are fine in generic code; forks
#     that rename the project sed them in one pass.
#   - The apex string 'bulletinmail.org' is the REFERENCE DEPLOYMENT's apex,
#     a per-instance value. It must NEVER appear in generic code — generic
#     code must load it from InstanceConfig at runtime.
#
# See PRD §19 and §20.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Per-deployment apex literals. Add new lines for any other reference apex
# you ship in deployments/.
NEEDLES=(
  "bulletinmail.org"
)

# Directories that must remain instance-agnostic.
#
# /server (Hono Worker) and /admin (SPA source) are generic — they must
# load apex from InstanceConfig at runtime. /src (Astro components, styles,
# content config), /docs (Starlight content), and /public (static assets)
# are site-specific content where the reference apex string is allowed.
SCAN_DIRS=(
  "workers"
  "packages"
  "cli"
  "server"
  "admin"
)

EXCLUDE_GLOBS=(
  "*/node_modules/*"
  "*/dist/*"
  "*/.astro/*"
  "*/.wrangler/*"
  "*/tests/fixtures/*"
  "*.generated.toml"
)

fail=0
for needle in "${NEEDLES[@]}"; do
  for dir in "${SCAN_DIRS[@]}"; do
    [ -d "$dir" ] || continue
    exclude_args=()
    for g in "${EXCLUDE_GLOBS[@]}"; do
      exclude_args+=(--exclude="$g")
    done
    if hits=$(grep -RInE "${exclude_args[@]}" -- "$needle" "$dir" 2>/dev/null); then
      if [ -n "$hits" ]; then
        echo "::error::Leaked instance apex '$needle' inside generic code ($dir):"
        echo "$hits"
        fail=1
      fi
    fi
  done
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "Generic code in workers/, packages/, cli/, apps/ may not contain a deployment apex."
  echo "Move the value into the loaded InstanceConfig and read it through there."
  echo "See PRD §20."
  exit 1
fi

echo "OK — no instance-specific apex literals found in generic code."
