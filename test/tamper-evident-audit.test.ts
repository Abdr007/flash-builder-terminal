/**
 * Tamper-evident signing-audit log (opt-in via SIGNING_AUDIT_TAMPER_EVIDENT=1).
 *
 * The audit log is the record of every fund-moving signature. Plaintext JSONL is
 * editable/reorderable/deletable undetectably. The opt-in hash chain makes any
 * such edit detectable: verifyAuditChain reports the first broken line.
 *
 * These assert: (1) a genuine chain verifies; (2) edit / delete / reorder each
 * break it at the right line; (3) the guard, with the flag on, WRITES a chain
 * that verifies end-to-end and resumes correctly across a restart; (4) with the
 * flag OFF, behavior is unchanged (no chain fields, and verify rejects it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { verifyAuditChain, SigningGuard, type SigningAuditEntry } from '../src/security/signing-guard.js';

const flush = (): Promise<void> => new Promise((r) => setImmediate(() => setImmediate(() => r())));

const entry = (i: number): SigningAuditEntry => ({
  timestamp: `2026-07-12T00:00:0${i}.000Z`,
  type: 'open',
  walletAddress: 'Wa11et1111111111111111111111111111111111111',
  result: 'confirmed',
  txSignature: `Sig${i}`,
});

describe('tamper-evident audit chain', () => {
  let dir: string;
  let logPath: string;
  const prevEnv = process.env.SIGNING_AUDIT_TAMPER_EVIDENT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-chain-'));
    logPath = join(dir, 'signing-audit.log');
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SIGNING_AUDIT_TAMPER_EVIDENT;
    else process.env.SIGNING_AUDIT_TAMPER_EVIDENT = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a chain written by the guard verifies end-to-end', async () => {
    process.env.SIGNING_AUDIT_TAMPER_EVIDENT = '1';
    const g = new SigningGuard({ auditLogPath: logPath });
    for (let i = 0; i < 5; i++) g.logAudit(entry(i));
    await flush();
    expect(verifyAuditChain(logPath)).toEqual({ ok: true });
  });

  it('detects an EDITED line at the right position', async () => {
    process.env.SIGNING_AUDIT_TAMPER_EVIDENT = '1';
    const g = new SigningGuard({ auditLogPath: logPath });
    for (let i = 0; i < 4; i++) g.logAudit(entry(i));
    await flush();
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    // Flip a value on line 2 (index 1) WITHOUT recomputing its hash.
    const obj = JSON.parse(lines[1]);
    obj.txSignature = 'TAMPERED';
    lines[1] = JSON.stringify(obj);
    writeFileSync(logPath, lines.join('\n') + '\n');
    const r = verifyAuditChain(logPath);
    expect(r.ok).toBe(false);
    expect(r.brokenAtLine).toBe(2);
  });

  it('detects a DELETED line (chain no longer links)', async () => {
    process.env.SIGNING_AUDIT_TAMPER_EVIDENT = '1';
    const g = new SigningGuard({ auditLogPath: logPath });
    for (let i = 0; i < 4; i++) g.logAudit(entry(i));
    await flush();
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    lines.splice(1, 1); // delete the 2nd entry
    writeFileSync(logPath, lines.join('\n') + '\n');
    const r = verifyAuditChain(logPath);
    expect(r.ok).toBe(false);
    expect(r.brokenAtLine).toBe(2); // the (now-)2nd line's seq/prevHash no longer match
  });

  it('detects REORDERED lines', async () => {
    process.env.SIGNING_AUDIT_TAMPER_EVIDENT = '1';
    const g = new SigningGuard({ auditLogPath: logPath });
    for (let i = 0; i < 4; i++) g.logAudit(entry(i));
    await flush();
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    [lines[1], lines[2]] = [lines[2], lines[1]];
    writeFileSync(logPath, lines.join('\n') + '\n');
    expect(verifyAuditChain(logPath).ok).toBe(false);
  });

  it('resumes the chain across a restart (no false break at the boundary)', async () => {
    process.env.SIGNING_AUDIT_TAMPER_EVIDENT = '1';
    const g1 = new SigningGuard({ auditLogPath: logPath });
    for (let i = 0; i < 3; i++) g1.logAudit(entry(i));
    await flush();
    // "Restart": a fresh guard over the SAME log must continue the chain.
    const g2 = new SigningGuard({ auditLogPath: logPath });
    for (let i = 3; i < 6; i++) g2.logAudit(entry(i));
    await flush();
    expect(verifyAuditChain(logPath)).toEqual({ ok: true });
  });

  it('is OFF by default — no chain fields, and a plain log is not a valid chain', async () => {
    delete process.env.SIGNING_AUDIT_TAMPER_EVIDENT;
    const g = new SigningGuard({ auditLogPath: logPath });
    g.logAudit(entry(0));
    await flush();
    const line = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(line.hash).toBeUndefined();
    expect(line.seq).toBeUndefined();
    // A non-chained log correctly fails verification (missing chain fields).
    expect(verifyAuditChain(logPath).ok).toBe(false);
  });
});
