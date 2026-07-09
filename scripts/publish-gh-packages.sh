#!/usr/bin/env bash
#
# Dual-publish helper — push the SAME version that's on npmjs.org to
# GitHub Packages (npm.pkg.github.com) under the scoped name
# `@abdr007/flash-magic-terminal`.
#
# Why scoped? GitHub Packages requires npm names to be scoped to the
# org/user that owns the registry. The bare `flash-magic-terminal` stays
# canonical on npmjs.org; the scoped variant on GitHub Packages is just
# a mirror for users who prefer GitHub-token-based auth.
#
# Prerequisites (one-time):
#   gh auth refresh -s write:packages,read:packages -h github.com
#
# Usage:
#   scripts/publish-gh-packages.sh
#
# What it does:
#   1. Reads the current `gh` token (must have write:packages scope)
#   2. Backs up package.json
#   3. Rewrites name → @abdr007/flash-magic-terminal + adds publishConfig
#   4. Writes a temp ~/.npmrc-style auth line into a project-local .npmrc
#   5. npm publish (uses the project .npmrc)
#   6. Restores package.json + deletes the temp .npmrc
#
# The temp .npmrc is gitignored and removed on exit (incl. failure).
# Token never lands in a committed file.

set -euo pipefail

cd "$(dirname "$0")/.."

# ── Pre-flight checks ──────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI is required (install with: brew install gh)" >&2
  exit 1
fi

GH_TOKEN=$(gh auth token 2>/dev/null || true)
if [[ -z "${GH_TOKEN}" ]]; then
  echo "error: \`gh auth token\` returned empty. Run \`gh auth login\` first." >&2
  exit 1
fi

# Verify the token has write:packages scope. Without it the publish will
# fail with a misleading 403 from npm — we'd rather surface the real
# cause now.
SCOPES=$(gh auth status 2>&1 | grep -o "Token scopes:.*" || echo "")
if ! echo "${SCOPES}" | grep -q "write:packages"; then
  echo "error: gh token is missing the write:packages scope." >&2
  echo "  fix: gh auth refresh -s write:packages,read:packages -h github.com" >&2
  exit 1
fi

# ── Backups + cleanup ──────────────────────────────────────────────────────
PKG_BACKUP=$(mktemp)
NPMRC_LOCAL=".npmrc"
NPMRC_BACKUP=""
if [[ -f "${NPMRC_LOCAL}" ]]; then
  NPMRC_BACKUP=$(mktemp)
  cp "${NPMRC_LOCAL}" "${NPMRC_BACKUP}"
fi
cp package.json "${PKG_BACKUP}"

cleanup() {
  # Always restore the originals on exit, even if publish failed.
  cp "${PKG_BACKUP}" package.json
  rm -f "${PKG_BACKUP}"
  if [[ -n "${NPMRC_BACKUP}" ]]; then
    cp "${NPMRC_BACKUP}" "${NPMRC_LOCAL}"
    rm -f "${NPMRC_BACKUP}"
  else
    rm -f "${NPMRC_LOCAL}"
  fi
}
trap cleanup EXIT INT TERM

# ── Rewrite package.json for the GitHub publish ────────────────────────────
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
p.name = '@abdr007/flash-magic-terminal';
p.publishConfig = { registry: 'https://npm.pkg.github.com', access: 'public' };
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"

# ── Project-local .npmrc with auth + scope mapping ─────────────────────────
cat > "${NPMRC_LOCAL}" <<EOF
//npm.pkg.github.com/:_authToken=${GH_TOKEN}
@abdr007:registry=https://npm.pkg.github.com
always-auth=true
EOF

# ── Publish ────────────────────────────────────────────────────────────────
echo "▶ Publishing @abdr007/flash-magic-terminal@$(node -p "require('./package.json').version") to GitHub Packages…"
npm publish

echo
echo "✔ Published. Verify at:"
echo "  https://github.com/Abdr007/flash-magic-terminal/pkgs/npm/flash-magic-terminal"
echo
echo "Users can install via:"
echo "  npm install -g @abdr007/flash-magic-terminal --registry=https://npm.pkg.github.com"
