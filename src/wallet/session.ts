import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const FLASH_DIR = join(homedir(), '.flash');
const SESSION_FILE = join(FLASH_DIR, 'session.json');

interface SessionData {
  lastWallet?: string;
}

function ensureDir(): void {
  if (!existsSync(FLASH_DIR)) {
    mkdirSync(FLASH_DIR, { mode: 0o700 });
  }
}

export function loadSession(): SessionData {
  try {
    if (!existsSync(SESSION_FILE)) return {};
    const raw = readFileSync(SESSION_FILE, 'utf-8');
    return JSON.parse(raw) as SessionData;
  } catch {
    return {};
  }
}

export function saveSession(data: SessionData): void {
  ensureDir();
  // Never store private keys — only wallet name
  const safe: SessionData = {};
  if (data.lastWallet && typeof data.lastWallet === 'string') {
    safe.lastWallet = data.lastWallet;
  }
  writeFileSync(SESSION_FILE, JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 });
}

export function updateLastWallet(walletName: string): void {
  const session = loadSession();
  session.lastWallet = walletName;
  saveSession(session);
}

export function clearLastWallet(): void {
  const session = loadSession();
  delete session.lastWallet;
  saveSession(session);
}

export function getLastWallet(): string | null {
  const session = loadSession();
  return session.lastWallet ?? null;
}
