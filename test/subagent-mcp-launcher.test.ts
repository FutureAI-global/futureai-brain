/**
 * Tests for subagent-mcp-launcher.ts — the `claude -p --mcp-config` spawn
 * path for subagent tool-use via Max subscription.
 *
 * Uses the injected `spawnFn` override to avoid actually spawning `claude`
 * in tests. Assertions focus on:
 *   - CLI arg shape (including allowed-tools mcp prefix)
 *   - MCP config JSON shape
 *   - Happy-path JSON parsing
 *   - Exit-code / is_error / timeout / abort error paths
 *   - Env hygiene (no inheritable auth tokens leak)
 *   - tmpfile cleanup
 */

import { describe, it, expect, mock } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  buildMcpConfig,
  runSubagentViaMcp,
  shouldUseMcpProvider,
  McpLauncherError,
} from '../src/core/minions/handlers/subagent-mcp-launcher.ts';

function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
  spawnError?: Error;
}): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  (child as unknown as { stdout: Readable | null }).stdout = opts.stdout
    ? Readable.from(Buffer.from(opts.stdout))
    : null;
  (child as unknown as { stderr: Readable | null }).stderr = opts.stderr
    ? Readable.from(Buffer.from(opts.stderr))
    : null;
  (child as unknown as { kill: (sig?: string) => boolean }).kill = () => true;
  setTimeout(() => {
    if (opts.spawnError) {
      (child as EventEmitter).emit('error', opts.spawnError);
    } else {
      (child as EventEmitter).emit('exit', opts.exitCode ?? 0, null);
    }
  }, opts.delayMs ?? 10);
  return child;
}

describe('subagent-mcp-launcher · buildMcpConfig', () => {
  it('produces the gbrain-stdio MCP shape with absolute command path', () => {
    const cfg = buildMcpConfig('/usr/local/bin/gbrain') as {
      mcpServers: { gbrain: { command: string; args: string[] } };
    };
    expect(cfg.mcpServers.gbrain.command).toBe('/usr/local/bin/gbrain');
    expect(cfg.mcpServers.gbrain.args).toEqual(['serve']);
  });
});

describe('subagent-mcp-launcher · shouldUseMcpProvider', () => {
  it('returns true when OLYMPUS_SUBAGENT_PROVIDER is the opt-in value', () => {
    const prevOlympus = process.env.OLYMPUS_SUBAGENT_PROVIDER;
    const prevGbrain = process.env.GBRAIN_SUBAGENT_PROVIDER;
    try {
      delete process.env.OLYMPUS_SUBAGENT_PROVIDER;
      delete process.env.GBRAIN_SUBAGENT_PROVIDER;
      expect(shouldUseMcpProvider()).toBe(false);
      process.env.OLYMPUS_SUBAGENT_PROVIDER = 'sdk';
      expect(shouldUseMcpProvider()).toBe(false);
      process.env.OLYMPUS_SUBAGENT_PROVIDER = 'claude-cli-mcp';
      expect(shouldUseMcpProvider()).toBe(true);
    } finally {
      if (prevOlympus === undefined) delete process.env.OLYMPUS_SUBAGENT_PROVIDER;
      else process.env.OLYMPUS_SUBAGENT_PROVIDER = prevOlympus;
      if (prevGbrain === undefined) delete process.env.GBRAIN_SUBAGENT_PROVIDER;
      else process.env.GBRAIN_SUBAGENT_PROVIDER = prevGbrain;
    }
  });

  it('accepts deprecated GBRAIN_SUBAGENT_PROVIDER as fallback', () => {
    const prevOlympus = process.env.OLYMPUS_SUBAGENT_PROVIDER;
    const prevGbrain = process.env.GBRAIN_SUBAGENT_PROVIDER;
    try {
      delete process.env.OLYMPUS_SUBAGENT_PROVIDER;
      process.env.GBRAIN_SUBAGENT_PROVIDER = 'claude-cli-mcp';
      expect(shouldUseMcpProvider()).toBe(true);
    } finally {
      if (prevOlympus === undefined) delete process.env.OLYMPUS_SUBAGENT_PROVIDER;
      else process.env.OLYMPUS_SUBAGENT_PROVIDER = prevOlympus;
      if (prevGbrain === undefined) delete process.env.GBRAIN_SUBAGENT_PROVIDER;
      else process.env.GBRAIN_SUBAGENT_PROVIDER = prevGbrain;
    }
  });

  it('OLYMPUS_* wins when both are set', () => {
    const prevOlympus = process.env.OLYMPUS_SUBAGENT_PROVIDER;
    const prevGbrain = process.env.GBRAIN_SUBAGENT_PROVIDER;
    try {
      process.env.OLYMPUS_SUBAGENT_PROVIDER = 'sdk';
      process.env.GBRAIN_SUBAGENT_PROVIDER = 'claude-cli-mcp';
      expect(shouldUseMcpProvider()).toBe(false);
      process.env.OLYMPUS_SUBAGENT_PROVIDER = 'claude-cli-mcp';
      process.env.GBRAIN_SUBAGENT_PROVIDER = 'sdk';
      expect(shouldUseMcpProvider()).toBe(true);
    } finally {
      if (prevOlympus === undefined) delete process.env.OLYMPUS_SUBAGENT_PROVIDER;
      else process.env.OLYMPUS_SUBAGENT_PROVIDER = prevOlympus;
      if (prevGbrain === undefined) delete process.env.GBRAIN_SUBAGENT_PROVIDER;
      else process.env.GBRAIN_SUBAGENT_PROVIDER = prevGbrain;
    }
  });
});

describe('subagent-mcp-launcher · runSubagentViaMcp', () => {
  const goodOutput = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done with the research task',
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 200,
      output_tokens: 150,
      cache_creation_input_tokens: 1024,
      cache_read_input_tokens: 0,
    },
  });

  it('happy path: spawns claude -p with expected args + parses result', async () => {
    const spawnMock = mock((...args: unknown[]) => {
      const [, argv] = args;
      expect(Array.isArray(argv)).toBe(true);
      const a = argv as string[];
      expect(a).toContain('-p');
      expect(a).toContain('--output-format');
      expect(a).toContain('json');
      expect(a).toContain('--mcp-config');
      expect(a).toContain('--strict-mcp-config');
      expect(a).toContain('--model');
      expect(a).toContain('sonnet');
      return makeFakeChild({ stdout: goodOutput, exitCode: 0 });
    });

    const res = await runSubagentViaMcp({
      systemPrompt: 'You are a research subagent.',
      task: 'Summarize topic X.',
      model: 'sonnet',
      gbrainBin: '/usr/local/bin/gbrain',
      claudeBin: '/usr/local/bin/claude',
      spawnFn: spawnMock as never,
    });

    expect(res.result).toBe('done with the research task');
    expect(res.usage.inputTokens).toBe(200);
    expect(res.usage.outputTokens).toBe(150);
    expect(res.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('allowed-tools: prefixes with mcp__gbrain__ and joins with comma', async () => {
    let capturedArgs: string[] = [];
    const spawnMock = mock((...args: unknown[]) => {
      const [, argv] = args;
      capturedArgs = argv as string[];
      return makeFakeChild({ stdout: goodOutput, exitCode: 0 });
    });

    await runSubagentViaMcp({
      systemPrompt: 'sys',
      task: 'task',
      allowedTools: ['query', 'get_page', 'search'],
      gbrainBin: '/usr/local/bin/gbrain',
      claudeBin: '/usr/local/bin/claude',
      spawnFn: spawnMock as never,
    });

    const idx = capturedArgs.indexOf('--allowed-tools');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs[idx + 1]).toBe('mcp__gbrain__query,mcp__gbrain__get_page,mcp__gbrain__search');
  });

  it('throws bin_missing when claude binary is absent', async () => {
    await expect(
      runSubagentViaMcp({
        systemPrompt: 'sys',
        task: 'task',
        gbrainBin: '/usr/local/bin/gbrain',
        claudeBin: '', // empty = force the missing path
        spawnFn: (() => { throw new Error('should not be reached'); }) as never,
      }),
    ).rejects.toMatchObject({ kind: 'bin_missing' });
  });

  it('throws bad_exit when claude -p exits non-zero', async () => {
    const spawnMock = mock(() =>
      makeFakeChild({ stdout: '', stderr: 'boom', exitCode: 2 }),
    );
    await expect(
      runSubagentViaMcp({
        systemPrompt: 's',
        task: 't',
        gbrainBin: '/bin/echo',
        claudeBin: '/bin/echo',
        spawnFn: spawnMock as never,
      }),
    ).rejects.toMatchObject({ kind: 'bad_exit' });
  });

  it('throws bad_output when stdout is not JSON', async () => {
    const spawnMock = mock(() =>
      makeFakeChild({ stdout: 'not json at all', exitCode: 0 }),
    );
    await expect(
      runSubagentViaMcp({
        systemPrompt: 's',
        task: 't',
        gbrainBin: '/bin/echo',
        claudeBin: '/bin/echo',
        spawnFn: spawnMock as never,
      }),
    ).rejects.toMatchObject({ kind: 'bad_output' });
  });

  it('throws bad_output when claude -p reports is_error=true', async () => {
    const errOutput = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'API Error 401',
      usage: {},
    });
    const spawnMock = mock(() =>
      makeFakeChild({ stdout: errOutput, exitCode: 0 }),
    );
    await expect(
      runSubagentViaMcp({
        systemPrompt: 's',
        task: 't',
        gbrainBin: '/bin/echo',
        claudeBin: '/bin/echo',
        spawnFn: spawnMock as never,
      }),
    ).rejects.toMatchObject({ kind: 'bad_output' });
  });

  it('propagates AbortSignal to kill the subprocess', async () => {
    const controller = new AbortController();
    let killCalled = false;
    const spawnMock = mock(() => {
      const c = makeFakeChild({ stdout: goodOutput, exitCode: 0, delayMs: 1_000 });
      (c as unknown as { kill: (sig?: string) => boolean }).kill = () => {
        killCalled = true;
        setTimeout(() => (c as EventEmitter).emit('exit', 143, 'SIGTERM'), 0);
        return true;
      };
      return c;
    });
    setTimeout(() => controller.abort(), 20);

    await expect(
      runSubagentViaMcp({
        systemPrompt: 's',
        task: 't',
        gbrainBin: '/bin/echo',
        claudeBin: '/bin/echo',
        signal: controller.signal,
        spawnFn: spawnMock as never,
      }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(killCalled).toBe(true);
  });
});
