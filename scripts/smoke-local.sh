#!/usr/bin/env bash
#
# Run the devnet integration test locally — same code path CI takes,
# minus the GitHub Actions wrapper. Use this BEFORE configuring CI
# secrets to confirm the test passes against your devnet wallet, so
# you don't end up debugging "configured secrets but CI is red" cycles.
#
# Usage:
#   scripts/smoke-local.sh                    # reads only
#   scripts/smoke-local.sh --writes           # full lifecycle (deposits + opens + closes + withdraws)
#
# Required env (set before running):
#   MAGIC_TEST_KEYPAIR_BASE58   — base58 secret of devnet test wallet
#   MAGIC_TEST_DEVNET_RPC       — devnet L1 RPC URL
#
# Optional:
#   MAGIC_TEST_DEVNET_ER        — ER router URL (default: https://flashtrade.magicblock.app/)
#
# Quick way to set the keypair:
#   export MAGIC_TEST_KEYPAIR_BASE58=$(node scripts/keypair-to-base58.mjs ~/.config/solana/magic-devnet-test.json)

set -euo pipefail

if [[ -z "${MAGIC_TEST_KEYPAIR_BASE58:-}" ]]; then
  echo "error: MAGIC_TEST_KEYPAIR_BASE58 is unset." >&2
  echo "  hint: export MAGIC_TEST_KEYPAIR_BASE58=\$(node scripts/keypair-to-base58.mjs ~/path/to/keypair.json)" >&2
  exit 1
fi

if [[ -z "${MAGIC_TEST_DEVNET_RPC:-}" ]]; then
  echo "error: MAGIC_TEST_DEVNET_RPC is unset." >&2
  echo "  hint: export MAGIC_TEST_DEVNET_RPC=https://devnet.helius-rpc.com/?api-key=YOUR_KEY" >&2
  exit 1
fi

if [[ "${1:-}" == "--writes" ]]; then
  export MAGIC_TEST_RUN_WRITES=1
  echo "▶ Running WRITES smoke (deposits + opens + closes + withdraws on devnet)"
else
  unset MAGIC_TEST_RUN_WRITES || true
  echo "▶ Running READ-ONLY smoke (no signing). Pass --writes to include lifecycle."
fi

echo "  RPC: ${MAGIC_TEST_DEVNET_RPC}"
echo "  ER:  ${MAGIC_TEST_DEVNET_ER:-<default>}"
echo

npm run test:integration
