# Changelog

All notable changes to this project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Auto RPC failover: background slot-lag + latency probes per endpoint, with 60 s cooldown and live REPL notice on switch.
- State reconciliation: pulls open positions, basket, and balances ~1.5 s after start and again every 60 s while a client is attached. Post-trade `verifyTrade` available.
- 24 h volume column in the live monitor: pulls `fstats.io/api/v1/volume/by-market?days=1` (60 s cache, soft circuit breaker on repeated failure), falls back to the in-process Anchor event indexer for markets fstats doesn't cover.
- Pyth-schedule-driven market hours: parses `attributes.schedule` from the Hermes feed registry per [docs.pyth.network](https://docs.pyth.network/price-feeds/core/market-hours). Replaces hardcoded ET-time logic. Holiday calendar respected.

## [0.1.0] — 2026-05-04

### Added
- Initial public release.
- Sub-second perpetual trading on Flash Magic Trade via MagicBlock ER.
- Natural-language command parser (688 LOC, 116-case dispatch matrix).
- Atomic reverse (close + reopen opposite side in a single ER tx).
- Inline TP/SL bundling with `open` instructions.
- Live market monitor: Pyth Hermes prices + on-chain OI + L/S ratio.
- Multi-endpoint RPC manager with persistence to `~/.magic/config.json`.
- Wallet manager with idle-timeout disconnect, keypair zeroing, mode `0600` files.
- Signing guard: rate limits, per-trade caps, audit log at `~/.magic/signing-audit.log`.
- Volume indexer (in-process Anchor event indexer; built, not yet wired into monitor).
- Strict TypeScript, ESLint, vitest CI gate.
