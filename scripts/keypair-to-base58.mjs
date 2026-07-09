#!/usr/bin/env node
/**
 * Convert a Solana CLI keypair JSON file (a 64-byte array) to the base58
 * secret-key string the integration test (and most other tooling) expects.
 *
 * Usage:
 *   node scripts/keypair-to-base58.mjs ~/.config/solana/magic-devnet-test.json
 *   node scripts/keypair-to-base58.mjs   # defaults to ~/.config/solana/id.json
 *
 * Prints the base58 string to stdout. Pipe directly into your shell:
 *   export MAGIC_TEST_KEYPAIR_BASE58=$(node scripts/keypair-to-base58.mjs ~/path/keypair.json)
 *
 * Refuses on:
 *   - file not readable / not 64-element array
 *   - file mode looser than 0600 (unless --no-perm-check)
 *
 * NEVER logs the base58 anywhere except stdout — pipe it, don't paste it
 * into a chat window.
 */

import bs58 from 'bs58';
import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

const args = process.argv.slice(2);
const skipPermCheck = args.includes('--no-perm-check');
const path = args.find((a) => !a.startsWith('--'))
  ?? resolve(homedir(), '.config/solana/id.json');

let st;
try {
  st = statSync(path);
} catch (err) {
  process.stderr.write(`error: cannot stat ${path}: ${err.message}\n`);
  process.exit(1);
}
if (!st.isFile()) {
  process.stderr.write(`error: ${path} is not a regular file\n`);
  process.exit(1);
}

if (!skipPermCheck && process.platform !== 'win32') {
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    process.stderr.write(
      `error: ${path} has loose permissions (${mode.toString(8)}). ` +
      `Run \`chmod 600 ${path}\` first, or pass --no-perm-check to override.\n`,
    );
    process.exit(1);
  }
}

let bytes;
try {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(`expected a 64-element JSON array, got length ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
  }
  for (const b of parsed) {
    if (typeof b !== 'number' || b < 0 || b > 255 || !Number.isInteger(b)) {
      throw new Error(`array contains non-byte values`);
    }
  }
  bytes = Uint8Array.from(parsed);
} catch (err) {
  process.stderr.write(`error: cannot decode keypair: ${err.message}\n`);
  process.exit(1);
}

// No trailing newline: when piped to `pbcopy` and pasted into a GitHub
// secret field, a trailing `\n` is preserved and breaks bs58.decode at
// runtime with "Non-base58 character". Output is a single token.
process.stdout.write(bs58.encode(bytes));
