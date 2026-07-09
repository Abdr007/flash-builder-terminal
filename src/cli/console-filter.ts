/**
 * Global filter for noisy `console.log` / `console.error` calls coming from
 * the SDK and its dependencies. The Magic Trade SDK's `simulateAndDecode`
 * helper writes the full error envelope to `console.error` before throwing,
 * which double-prints once we map the same error into a friendly hint. We
 * also drop the `[ViewHelper] sim …` and `[MagicTrade] initEr` debug lines.
 *
 * This must run BEFORE any SDK module is imported so that no banners slip
 * through during early init. Call `installConsoleFilter()` from the entry
 * point right after `loadConfig()`.
 */

const NOISE_PATTERNS: RegExp[] = [
  /^Simulation failed for /,             // simulateAndDecode error envelope
  /^Logs:?$/,                             // simulateAndDecode logs continuation (`console.error("Logs:", ...)`)
  /^Logs:\s*\[/,                          // pretty-printed "Logs: [..."
  /^\[ViewHelper\] /,                     // ViewHelper sim debug
  /^\[MagicTrade\] /,                     // SDK init banner (initEr)
  /^ERROR: buildPoolconfigFromJson/,      // PoolConfig parse warning
  /^programId\s+:\s/,                     // ViewHelper account dump
  /^err\s+:\s/,                            // ViewHelper account dump
  /^unitsConsumed:/,                       // ViewHelper account dump
  /^returnData\s+:/,                       // ViewHelper account dump
  /^logs\s+:\s+<empty>/,                  // ViewHelper account dump
  /^accounts\s+:/,                         // ViewHelper account dump
];

/**
 * True if the first arg of a console.* call matches a known SDK noise pattern.
 * We deliberately keep `console.warn` untouched because it's used by some
 * non-SDK paths (e.g. node-fetch deprecation) we still want to see.
 */
function isNoise(args: unknown[]): boolean {
  if (args.length === 0) return false;
  const first = args[0];
  if (typeof first !== 'string') return false;
  return NOISE_PATTERNS.some((re) => re.test(first));
}

let installed = false;

export function installConsoleFilter(): void {
  if (installed) return;
  installed = true;

  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    if (isNoise(args)) return;
    origLog(...args);
  };
  console.error = (...args: unknown[]) => {
    if (isNoise(args)) return;
    origError(...args);
  };
}
