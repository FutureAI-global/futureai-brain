/**
 * Brain home directory resolution — the single source of truth for where
 * the state directory lives (config, migrations, audit logs, PGLite DB,
 * fail-improve logs, skillpack cache, cycle locks, etc.).
 *
 * Historically every module did `join(homedir(), '.gbrain')` directly.
 * Phase 2 Slice D of the unified-olympus-cli rollout unifies these into
 * a single helper so the path can be re-homed to `~/.olympus/brain/` or
 * overridden per-user via env var, without touching every call site.
 *
 * Resolution order (first match wins):
 *   1. `OLYMPUS_BRAIN_HOME` env var (if set; absolute path)
 *   2. `GBRAIN_HOME` env var (deprecated alias; still honored)
 *   3. `~/.olympus/brain/` if it already exists on disk (opt-in via manual
 *      `mkdir` — we don't force-migrate)
 *   4. `~/.gbrain/` (backward-compat default for existing users)
 *
 * Zero side effects — the helper never creates directories, never moves
 * files. Callers that need a directory guarantee should `mkdirSync`
 * themselves. Safe to call from anywhere (no filesystem mutation).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let cached: string | undefined;

/** Reset the memoized home dir — tests override env vars between cases. */
export function __resetBrainHomeCache(): void {
  cached = undefined;
}

/**
 * Return the absolute path to the brain's state directory. Memoized per
 * process (brain home doesn't change mid-run); tests can clear via
 * `__resetBrainHomeCache()`.
 */
export function resolveBrainHome(): string {
  if (cached !== undefined) return cached;

  const envOlympus = process.env.OLYMPUS_BRAIN_HOME;
  if (envOlympus && envOlympus.length > 0) {
    cached = envOlympus;
    return cached;
  }

  const envGbrain = process.env.GBRAIN_HOME;
  if (envGbrain && envGbrain.length > 0) {
    cached = envGbrain;
    return cached;
  }

  const home = homedir();
  const olympusPath = join(home, '.olympus', 'brain');
  if (existsSync(olympusPath)) {
    cached = olympusPath;
    return cached;
  }

  cached = join(home, '.gbrain');
  return cached;
}

/** Convenience: subdirectory helper. Does NOT mkdir. */
export function brainHomeSubdir(...segments: string[]): string {
  return join(resolveBrainHome(), ...segments);
}
