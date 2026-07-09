/**
 * Single source of truth for the runtime version string.
 *
 * Read from the package.json that ships with the artefact, so the
 * value can never drift from `name@version`. Earlier releases had
 * two separate hardcoded literals that were missed during a bump,
 * causing the 0.4.0 binary to print "0.3.3" — fixed by sourcing
 * here.
 *
 * Cost: one sync read of a tiny JSON file at module load. Built-in
 * `fs` + `url` add ~0 ms to the cold path, so this is safe to use
 * in the `--version` fast-path before any heavy imports resolve.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

export const VERSION: string = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
