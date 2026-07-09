/**
 * Structured logger for the Magic Terminal.
 *
 * - JSON or text output (env: MAGIC_LOG_FORMAT)
 * - File logging with 10MB rotation under ~/.magic/
 * - Background categories suppressed from console (HEALTH/RETRY/ORACLE)
 * - Sensitive value redaction: API keys, ed25519 secret keys, full URLs
 */

import { appendFile, appendFileSync, mkdirSync, existsSync, writeFileSync, chmodSync, statSync, renameSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { redactCommonSecrets } from '../security/redact-secrets.js';

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const BACKGROUND_CATEGORIES = new Set(['HEALTH', 'RETRY', 'ORACLE', 'MAINTENANCE']);

export type LogFormat = 'text' | 'json';

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.Debug]: 'DEBUG',
  [LogLevel.Info]: 'INFO',
  [LogLevel.Warn]: 'WARN',
  [LogLevel.Error]: 'ERROR',
};

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  [LogLevel.Debug]: chalk.gray,
  [LogLevel.Info]: chalk.cyan,
  [LogLevel.Warn]: chalk.yellow,
  [LogLevel.Error]: chalk.red,
};

export class Logger {
  private level: LogLevel;
  private logFilePath: string | null;
  private showInCli: boolean;
  private format: LogFormat;
  private writeFailures = 0;
  private writeFailureWarned = false;
  private logRotationChecked = 0;
  private static readonly MAX_WRITE_FAILURES = 5;
  private static _requestId: string | null = null;

  static setRequestId(id: string): void {
    Logger._requestId = id;
  }
  static clearRequestId(): void {
    Logger._requestId = null;
  }
  static get requestId(): string | null {
    return Logger._requestId;
  }

  constructor(opts?: { level?: LogLevel; logFile?: string; showInCli?: boolean; format?: LogFormat }) {
    this.level = opts?.level ?? LogLevel.Info;
    this.logFilePath = opts?.logFile ?? null;
    this.showInCli = opts?.showInCli ?? false;
    this.format = opts?.format ?? 'text';

    if (this.logFilePath) {
      const resolved = resolve(this.logFilePath);
      const home = homedir();
      const homePrefix = home.endsWith('/') ? home : home + '/';
      if (resolved !== home && !resolved.startsWith(homePrefix)) {
        this.logFilePath = null;
      }
    }

    if (this.logFilePath) {
      const dir = dirname(this.logFilePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!existsSync(this.logFilePath)) writeFileSync(this.logFilePath, '', { mode: 0o600 });
      try { chmodSync(this.logFilePath, 0o600); } catch { /* best-effort */ }
    }
  }

  debug(category: string, message: string, data?: Record<string, unknown>): void { this.log(LogLevel.Debug, category, message, data); }
  info(category: string, message: string, data?: Record<string, unknown>): void { this.log(LogLevel.Info, category, message, data); }
  warn(category: string, message: string, data?: Record<string, unknown>): void { this.log(LogLevel.Warn, category, message, data); }
  error(category: string, message: string, data?: Record<string, unknown>): void { this.log(LogLevel.Error, category, message, data); }

  trade(action: string, details: Record<string, unknown>): void {
    this.info('TRADE', action, details);
  }

  private log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
    if (level < this.level) return;
    const entry: LogEntry = { timestamp: new Date().toISOString(), level, category, message, data };

    if (this.logFilePath && this.writeFailures < Logger.MAX_WRITE_FAILURES) {
      this.writeToFile(entry);
    } else if (this.logFilePath && this.writeFailures >= Logger.MAX_WRITE_FAILURES && level >= LogLevel.Warn) {
      this.writeToConsole(entry);
    }

    if (this.showInCli) {
      this.writeToConsole(entry);
    } else if (level >= LogLevel.Error && !BACKGROUND_CATEGORIES.has(entry.category)) {
      this.writeToConsole(entry);
    }
  }

  /**
   * Redact secrets/keys/URLs before writing. Layered: shared
   * aggressive patterns from `redactCommonSecrets`, plus the
   * logger-specific ed25519-with-context pattern that we don't
   * apply to audit logs (audit log values are all base58 sigs and
   * don't carry the `secretKey:` / `key=` markers).
   */
  private scrub(text: string): string {
    let out = redactCommonSecrets(text);
    // Likely ed25519 private key — only when preceded by an obvious key
    // context (`secretKey:`, `private:`, `=`, etc.). Solana tx signatures
    // are 86-88 base58 chars too, so an unconditional 88-char redaction
    // would also strip 20-30% of real signatures from the audit log,
    // making forensics unreadable. The narrower context anchor preserves
    // signatures while still catching key-shaped material.
    out = out.replace(/(secretKey|privateKey|private|secret_key|key)\s*[:=]\s*([1-9A-HJ-NP-Za-km-z]{86,88})/gi,
      (_m, label: string) => `${label}=***REDACTED***`);
    out = out.replace(/(["'])([1-9A-HJ-NP-Za-km-z]{86,88})\1\s*,?\s*\/\/\s*priv/gi,
      (_m, q: string) => `${q}***REDACTED***${q}`);
    // Only collapse URLs that carry an obvious credential — keep the full
    // path otherwise so audit-log Solscan-style links remain useful.
    out = out.replace(/https?:\/\/[^\s"']*(?:api[_-]?key=|auth=|token=|@)[^\s"']*/gi, (url) => {
      try { return new URL(url).origin + '/***'; } catch { return url; }
    });
    return out;
  }

  private writeToFile(entry: LogEntry): void {
    if (!this.logFilePath) return;
    let line: string;

    if (this.format === 'json') {
      const obj: Record<string, unknown> = {
        timestamp: entry.timestamp,
        level: LEVEL_LABELS[entry.level],
        module: entry.category,
        message: this.scrub(entry.message),
      };
      if (Logger._requestId) obj.request_id = Logger._requestId;
      if (entry.data) {
        try { obj.data = JSON.parse(this.scrub(JSON.stringify(entry.data))); } catch { obj.data = {}; }
      }
      line = JSON.stringify(obj) + '\n';
    } else {
      const reqId = Logger._requestId ? ` [req:${Logger._requestId}]` : '';
      const dataStr = entry.data ? ` ${this.scrub(JSON.stringify(entry.data))}` : '';
      line = `[${entry.timestamp}] ${LEVEL_LABELS[entry.level]} [${entry.category}]${reqId} ${this.scrub(entry.message)}${dataStr}\n`;
    }

    if (++this.logRotationChecked % 100 === 0) {
      try {
        const size = statSync(this.logFilePath).size;
        if (size > MAX_LOG_FILE_BYTES) {
          const rotated = this.logFilePath + '.old';
          try { renameSync(rotated, rotated + '.2'); } catch { /* ignore */ }
          renameSync(this.logFilePath, rotated);
          writeFileSync(this.logFilePath, '', { mode: 0o600 });
        }
      } catch { /* best-effort */ }
    }

    appendFile(this.logFilePath, line, (err) => {
      if (err) {
        this.writeFailures++;
        if (!this.writeFailureWarned && this.writeFailures >= Logger.MAX_WRITE_FAILURES) {
          this.writeFailureWarned = true;
          console.error(chalk.yellow(`  [WARN] Log file write failed ${this.writeFailures}× (${err.code ?? err.message}). Falling back to console.`));
        }
      } else if (this.writeFailures > 0) {
        this.writeFailures = 0;
        if (this.writeFailureWarned) {
          this.writeFailureWarned = false;
          console.error(chalk.green('  [INFO] Log file writes restored.'));
        }
      }
    });
  }

  flushSync(category: string, message: string, data?: Record<string, unknown>): void {
    if (!this.logFilePath) return;
    const ts = new Date().toISOString();
    const dataStr = data ? ` ${this.scrub(JSON.stringify(data))}` : '';
    const line = `[${ts}] INFO [${category}] ${this.scrub(message)}${dataStr}\n`;
    try { appendFileSync(this.logFilePath, line); } catch { /* best-effort */ }
  }

  private writeToConsole(entry: LogEntry): void {
    const colorFn = LEVEL_COLORS[entry.level];
    const label = colorFn(`[${LEVEL_LABELS[entry.level]}]`);
    const cat = chalk.dim(`[${entry.category}]`);
    // Apply the same scrubber to console output that file output uses, so a
    // shared screenshot or recorded terminal session can't leak api keys,
    // bot tokens, or credentialed URLs.
    const scrubbed = this.scrub(entry.message);
    const msg = entry.level >= LogLevel.Error ? chalk.red(scrubbed) : scrubbed;
    console.error(`  ${label} ${cat} ${msg}`);
  }
}

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const map: Record<string, LogLevel> = { debug: LogLevel.Debug, info: LogLevel.Info, warn: LogLevel.Warn, error: LogLevel.Error };
  return map[value.toLowerCase()];
}

export function generateRequestId(): string {
  return Math.random().toString(16).slice(2, 10);
}

let _logger: Logger | null = null;

export function initLogger(opts?: { level?: LogLevel; logFile?: string; showInCli?: boolean; format?: LogFormat }): Logger {
  const envLevel = parseLogLevel(process.env.MAGIC_LOG_LEVEL);
  const envFormat = (process.env.MAGIC_LOG_FORMAT?.toLowerCase() === 'json' ? 'json' : 'text') as LogFormat;
  const level = opts?.level ?? envLevel ?? LogLevel.Info;
  const format = opts?.format ?? envFormat;
  _logger = new Logger({ ...opts, level, format });
  return _logger;
}

export function getLogger(): Logger {
  if (!_logger) {
    const envLevel = parseLogLevel(process.env.MAGIC_LOG_LEVEL);
    _logger = new Logger({ level: envLevel ?? LogLevel.Info });
  }
  return _logger;
}
