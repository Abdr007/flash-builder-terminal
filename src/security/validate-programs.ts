/**
 * Program-ID whitelist for the Magic Trade hot path.
 *
 * Every instruction sent to L1 (mainchain) or ER must target a program in this
 * set. Anything else is treated as supply-chain compromise (e.g. a tampered
 * SDK build pushing a rogue ix into a basket op) and rejected before signing.
 */

import type { TransactionInstruction, VersionedTransaction } from '@solana/web3.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111';
const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111';

// Flash Magic Trade — same on-chain program as L1 Flash Trade on mainnet.
const FMT_MAINNET_PROGRAM = 'FTv2RxXarPfNta45HTTMVaGvjzsGg27FXJ3hEKWBhrzV';
const FMT_DEVNET_PROGRAM = 'FMTgsEDaPPfJi1PKD67McLTC5n833T4irbBP53LLxtvj';

// MagicBlock ER delegation + session keys.
const MAGICBLOCK_DELEGATION_PROGRAM = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';
const SESSION_KEYS_PROGRAM = 'KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5';

// Event-authority CPI target (Flash). Used for on-chain logs.
const EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp18C';

const BASE_ALLOWED = Object.freeze(
  new Set<string>([
    SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    ATA_PROGRAM,
    COMPUTE_BUDGET_PROGRAM,
    SYSVAR_RENT,
    SYSVAR_CLOCK,
    SYSVAR_INSTRUCTIONS,
    MEMO_PROGRAM,
    ED25519_PROGRAM,
    EVENT_AUTHORITY,
    FMT_MAINNET_PROGRAM,
    FMT_DEVNET_PROGRAM,
    MAGICBLOCK_DELEGATION_PROGRAM,
    SESSION_KEYS_PROGRAM,
  ]),
);

let ALLOWED: ReadonlySet<string> = BASE_ALLOWED;
// Bump on every allowlist change so callers caching "trusted ix" decisions
// can detect that their cached verdict is stale and re-validate.
let ALLOWED_VERSION = 1;

/** Re-seed the whitelist with extra programs (e.g. pool-specific IDs from PoolConfig). */
export function extendAllowedPrograms(extra: Iterable<string>): void {
  const next = new Set<string>(BASE_ALLOWED);
  for (const id of extra) next.add(id);
  ALLOWED = Object.freeze(next);
  ALLOWED_VERSION += 1;
}

export function getAllowedPrograms(): ReadonlySet<string> {
  return ALLOWED;
}

/** Monotonically-increasing version that bumps every time the allowlist changes. */
export function getAllowlistVersion(): number {
  return ALLOWED_VERSION;
}

/**
 * Validate every program invoked by a server-supplied VersionedTransaction
 * against the allowlist — the defense against blind-signing a tx the Flash
 * Builder API returned. Works fully offline: per the Solana v0 rules a
 * transaction's program IDs (and its signers) MUST live in the static account
 * keys — they can never be loaded from an address lookup table — so we resolve
 * each instruction's program id from `staticAccountKeys` without any RPC/ALT
 * fetch. An instruction whose program-id index points past the static keys
 * (i.e. it tries to source a program id from an ALT) is itself a red flag and
 * is rejected. Throws on the first unapproved / anomalous program.
 */
export function validateVersionedTxPrograms(tx: VersionedTransaction, context: string): void {
  const msg = tx.message;
  const staticKeys = msg.staticAccountKeys;
  const numStatic = staticKeys.length;
  const compiled = msg.compiledInstructions;
  for (let i = 0; i < compiled.length; i++) {
    const idx = compiled[i].programIdIndex;
    if (idx >= numStatic) {
      throw new Error(
        `Transaction rejected: instruction ${i} sources its program id from an address lookup table (${context}). ` +
          `Program ids must be static; refusing to sign a transaction that hides its programs.`,
      );
    }
    const id = staticKeys[idx].toBase58();
    if (!ALLOWED.has(id)) {
      throw new Error(
        `Transaction rejected: instruction ${i} targets unknown program ${id} (${context}). ` +
          `Only approved Solana system programs and Flash Magic Trade programs are allowed.`,
      );
    }
  }
}

/**
 * Throws unless every required signer of `tx` is one of `intendedSigners`
 * (the keys we actually intend to authorize — owner and, for withdrawals, the
 * fee payer). Blocks a malicious/buggy API response that demands a signature
 * from an unexpected authority. The fee payer is static key 0 and is covered
 * by the loop. Signers, like program ids, are always in the static keys.
 */
export function assertRequiredSigners(tx: VersionedTransaction, intendedSigners: Iterable<string>, context: string): void {
  const intended = new Set(intendedSigners);
  const msg = tx.message;
  const numRequired = msg.header.numRequiredSignatures;
  const staticKeys = msg.staticAccountKeys;
  for (let i = 0; i < numRequired; i++) {
    const signer = staticKeys[i]?.toBase58() ?? '';
    if (!intended.has(signer)) {
      throw new Error(
        `Transaction rejected: requires a signature from ${signer} (${context}) which is not an intended signer. ` +
          `Refusing to sign a transaction that authorizes an unexpected account.`,
      );
    }
  }
}

/** Throws if any instruction targets an unapproved program. */
export function validateInstructionPrograms(instructions: TransactionInstruction[], context: string): void {
  for (let i = 0; i < instructions.length; i++) {
    const id = instructions[i].programId.toBase58();
    if (!ALLOWED.has(id)) {
      throw new Error(
        `Transaction rejected: instruction ${i} targets unknown program ${id} (${context}). ` +
          `Only approved Solana system programs and Flash Magic Trade programs are allowed.`,
      );
    }
  }
}
