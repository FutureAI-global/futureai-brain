/**
 * In-process CLI entrypoint — lets callers invoke the gbrain command line
 * WITHOUT spawning a subprocess. Used by Olympus's unified CLI to flip
 * `olympus query ...` / `olympus ingest ...` / etc. from fork+exec dispatch
 * to a direct function call.
 *
 * Phase 2 (first slice) of docs/plan-unified-olympus-cli.md. Full "native
 * vendoring" still requires (1) esbuild bundling of gbrain + deps into
 * Olympus's single-file binary, (2) state-path migration
 * ~/.gbrain/ → ~/.olympus/, and (3) long-running-command handling
 * (`serve` / `jobs work` stay spawned; one-shot commands go in-process).
 * This module provides the call-into-gbrain primitive that unlocks those
 * follow-ups.
 *
 * Semantics:
 *   - Accepts argv as a string array (NOT process.argv.slice(2) — caller
 *     controls the invocation shape).
 *   - Returns the exit code as a number (0 on success, 1 on uncaught
 *     error, otherwise whatever the invoked command requested via
 *     `process.exit`).
 *   - Intercepts `process.exit` by overriding it for the duration of
 *     the call, so gbrain's existing `process.exit(N)` sites don't kill
 *     the host process. Restored in `finally`.
 *   - Does NOT intercept `process.argv` writes — gbrain reads it once in
 *     main() via `process.argv.slice(2)`, so we swap `process.argv` for
 *     the duration.
 *
 * Concurrency: a single process can have only ONE in-flight `runCli`
 * call at a time, because `process.argv` and `process.exit` are global.
 * A module-scope mutex prevents re-entrancy. Concurrent callers await
 * the lock. For parallel brain work, callers should still spawn
 * subprocesses — that's the `gbrain` binary's legitimate use case.
 *
 * Not covered in this slice:
 *   - Long-running commands (`serve`, `jobs work`): caller should detect
 *     these + fall back to spawning the gbrain binary (the dispatcher in
 *     backend/src/cli/brain-dispatcher.ts should enforce this).
 *   - Stdin capture: if gbrain command reads stdin, host's stdin is
 *     shared. Acceptable for one-shot CLI commands.
 *   - stdout/stderr routing: gbrain writes directly to
 *     process.stdout/stderr. Caller inherits those streams.
 */

import { main } from './cli.ts';

/** Sentinel used internally to unwind out of a simulated `process.exit`. */
class SimulatedExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`simulated process.exit(${code})`);
    this.code = code;
    this.name = 'SimulatedExit';
  }
}

let mutex: Promise<void> = Promise.resolve();

export interface RunCliOpts {
  /** Command args (NOT including the `gbrain` binary name). */
  argv: readonly string[];
}

export interface RunCliResult {
  /** Exit code gbrain's command requested (or 0 / 1). */
  exitCode: number;
}

/**
 * Run gbrain's CLI in-process. Serializes across calls; concurrent
 * invocations queue behind each other via the module-scope mutex.
 */
export async function runCli(opts: RunCliOpts): Promise<RunCliResult> {
  const release = await acquireMutex();
  const origArgv = process.argv;
  const origExit = process.exit;
  let exitCode = 0;

  // Claim process.argv — gbrain's main() reads process.argv.slice(2).
  process.argv = ['node', 'gbrain-inprocess', ...opts.argv];

  // Claim process.exit — map it to a SimulatedExit we unwind in the
  // catch block. Cast to `never` so the type matches process.exit's
  // signature (it never returns).
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new SimulatedExit(exitCode);
  }) as typeof process.exit;

  try {
    await main();
  } catch (err) {
    if (err instanceof SimulatedExit) {
      exitCode = err.code;
    } else {
      // Restore state before re-throw so the caller's `finally` sees
      // a clean process.
      process.argv = origArgv;
      process.exit = origExit;
      release();
      throw err;
    }
  }
  process.argv = origArgv;
  process.exit = origExit;
  release();
  return { exitCode };
}

function acquireMutex(): Promise<() => void> {
  let releaseFn: () => void;
  const next = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  const prev = mutex;
  mutex = next;
  return prev.then(() => releaseFn);
}

/**
 * Subcommands that run a long-lived loop. Callers (the Olympus dispatcher)
 * should spawn the gbrain binary for these instead of using `runCli`,
 * because the in-process path holds the event loop indefinitely.
 */
export const LONG_RUNNING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'serve',
  'autopilot', // daemon-mode
]);

export function isLongRunning(firstArg: string | undefined): boolean {
  if (!firstArg) return false;
  // Special case: `jobs work` is long-running but `jobs <anything-else>` isn't.
  if (firstArg === 'jobs') {
    // Caller can't know without looking at argv[1]; return true to be
    // safe — they should spawn for all `jobs *` invocations.
    return true;
  }
  return LONG_RUNNING_SUBCOMMANDS.has(firstArg);
}
