/**
 * Tests for src/run-cli.ts — the in-process CLI entrypoint that Olympus
 * uses to replace fork+exec dispatch with direct function call.
 *
 * These tests avoid the full main() execution (requires DB + live env)
 * and focus on the exported PRIMITIVES: `isLongRunning` classification +
 * `runCli`'s process.exit interception mechanics via a simulated
 * command.
 */

import { describe, it, expect } from 'bun:test';
import { isLongRunning, LONG_RUNNING_SUBCOMMANDS, runCli } from '../src/run-cli.ts';

describe('run-cli · isLongRunning', () => {
  it('flags serve + autopilot + jobs as long-running', () => {
    expect(isLongRunning('serve')).toBe(true);
    expect(isLongRunning('autopilot')).toBe(true);
    expect(isLongRunning('jobs')).toBe(true);
  });

  it('does NOT flag one-shot subcommands', () => {
    expect(isLongRunning('query')).toBe(false);
    expect(isLongRunning('ingest')).toBe(false);
    expect(isLongRunning('enrich')).toBe(false);
    expect(isLongRunning('doctor')).toBe(false);
    expect(isLongRunning('dream')).toBe(false);
    expect(isLongRunning('stats')).toBe(false);
  });

  it('returns false for undefined / empty', () => {
    expect(isLongRunning(undefined)).toBe(false);
    expect(isLongRunning('')).toBe(false);
  });

  it('LONG_RUNNING_SUBCOMMANDS set is narrow', () => {
    expect(LONG_RUNNING_SUBCOMMANDS.has('serve')).toBe(true);
    expect(LONG_RUNNING_SUBCOMMANDS.has('autopilot')).toBe(true);
    expect(LONG_RUNNING_SUBCOMMANDS.has('query')).toBe(false);
  });
});

describe('run-cli · runCli primitive behavior', () => {
  it('returns exitCode=0 on --version (bypasses DB)', async () => {
    // --version is handled by main() without touching the engine; it's
    // the safest smoke against the runCli mutex + exit interception.
    const res = await runCli({ argv: ['--version'] });
    expect(res.exitCode).toBe(0);
  });

  it('returns exitCode=0 on --help', async () => {
    const res = await runCli({ argv: ['--help'] });
    expect(res.exitCode).toBe(0);
  });

  it('serializes concurrent calls via mutex (no race on process.argv)', async () => {
    // Two concurrent --version calls. If the mutex isn't working, they'd
    // race + clobber each other's process.argv. With serialization, both
    // succeed.
    const [a, b] = await Promise.all([
      runCli({ argv: ['--version'] }),
      runCli({ argv: ['--version'] }),
    ]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
  });

  it('restores process.argv + process.exit after invocation', async () => {
    const origArgv = [...process.argv];
    const origExit = process.exit;
    await runCli({ argv: ['--version'] });
    expect(process.argv).toEqual(origArgv);
    expect(process.exit).toBe(origExit);
  });
});
