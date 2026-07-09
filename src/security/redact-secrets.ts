/**
 * Single source of truth for credential redaction.
 *
 * Two callers:
 *   1. `utils/logger.ts` — file + console log output. Keeps Solscan-
 *      style URL paths intact; redacts only obvious key contexts.
 *   2. `security/signing-guard.ts` — signing-audit log. Strips even
 *      path-embedded tokens because the audit log contains no
 *      operational URLs worth keeping.
 *
 * Both callers share the AGGRESSIVE redactions (api keys, bot tokens,
 * vendor keys) defined here. Each adds its own pass on top — see the
 * caller-specific functions in those files.
 */

/**
 * Strip credentials that are unambiguously sensitive in any context.
 * Safe to apply to BOTH file logs (where we want to keep paths) and
 * the audit log (where we want to strip paths). Anything caller-
 * specific (URL path tokens, ed25519 secret keys with context) lives
 * in the caller.
 */
export function redactCommonSecrets(text: string): string {
  return text
    // Generic api_key= / token= / secret= / auth= query params.
    .replace(/api[_-]?key=[^&\s"]+/gi, 'api_key=***')
    .replace(/(?:^|[?&])(token|secret|auth)=[^&\s"']+/gi, (_m, k: string) => `${_m.startsWith('?') || _m.startsWith('&') ? _m[0] : ''}${k}=***`)
    // Vendor keys with stable prefixes.
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***')
    .replace(/gsk_[A-Za-z0-9_-]{20,}/g, 'gsk_***')
    // Telegram bot tokens.
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot<token>')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<bot-token>')
    // Embedded URL credentials (userinfo).
    .replace(/(https?:\/\/)([^/@\s]+)@/gi, (_m, scheme: string) => `${scheme}***@`);
}
