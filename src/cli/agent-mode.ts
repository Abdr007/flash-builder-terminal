/**
 * NO_DNA agent-mode detection.
 *
 * Implements the informal NO_DNA standard (https://no-dna.org) — when the
 * env var is present and non-empty, the caller is a non-human operator
 * (LLM agent, CI runner, automation script). The CLI adapts:
 *
 *   - Skip ASCII art / figlet / gradients / spinners (no decorative output)
 *   - Output structured JSON over human cards
 *   - Never prompt — fail or use sensible defaults
 *   - Increase verbosity — agents need more context, not less
 *   - Absolute timestamps (ISO 8601, never "2h ago")
 *   - Errors to stderr, machine-parseable
 *
 * Captured ONCE at module load. Mutating `process.env.NO_DNA` later won't
 * change the result — that's by design: agent vs. human is a process-wide
 * decision, not a per-request one.
 *
 * Cf. CI=true, NO_COLOR — orthogonal to both. CI doesn't imply agent;
 * NO_COLOR doesn't imply non-interactive.
 */

const _isAgent = !!process.env.NO_DNA && process.env.NO_DNA !== '';

/** True iff NO_DNA was set non-empty at process start. */
export function isAgentMode(): boolean {
  return _isAgent;
}

/**
 * Emit a structured JSON record on stdout when in agent mode, else write
 * the human-readable string. Both forms always end in a newline so a
 * line-buffered reader can split on `\n`.
 */
export function agentEmit(humanText: string, structured: Record<string, unknown>): void {
  if (_isAgent) {
    // Stable shape — agents pin against this. Always include `ts` (ISO)
    // and `kind` so downstream parsers can branch.
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...structured,
    });
    process.stdout.write(line + '\n');
  } else {
    const out = humanText.endsWith('\n') ? humanText : humanText + '\n';
    process.stdout.write(out);
  }
}

/**
 * Emit a structured error record to stderr (per the NO_DNA spec). Falls
 * back to chalk-coloured stderr in human mode.
 */
export function agentError(humanText: string, structured: Record<string, unknown>): void {
  if (_isAgent) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      ...structured,
    });
    process.stderr.write(line + '\n');
  } else {
    const out = humanText.endsWith('\n') ? humanText : humanText + '\n';
    process.stderr.write(out);
  }
}

/**
 * In agent mode, prompts are forbidden. Returns a sensible default — the
 * caller decides what "sensible" means by passing it.
 */
export function agentPromptOrDefault<T>(humanPrompt: () => Promise<T>, agentDefault: T): Promise<T> {
  return _isAgent ? Promise.resolve(agentDefault) : humanPrompt();
}
