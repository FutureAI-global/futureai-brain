/**
 * Subagent MCP launcher — routes gbrain's tool-use LLM calls through the
 * native `claude -p --mcp-config` subprocess, billing against the user's
 * Claude Max subscription.
 *
 * Why this exists: Anthropic server blocks OAuth-token programmatic access
 * to /v1/messages (2026-04-24: HTTP 401 "OAuth authentication is currently
 * not supported"). Subagent's tool-use loop therefore can't run through the
 * Anthropic SDK directly on a Max subscription. Native `claude -p` still
 * authenticates (keychain session) + supports `--mcp-config` to load
 * arbitrary MCP servers + exposes their tools to the LLM loop.
 *
 * Architecture: spawn `claude -p --output-format json --mcp-config <tmp.json>`
 * with config pointing at `gbrain serve` (stdio MCP server). Claude runs
 * the entire agent loop internally, we read the final result JSON. This is
 * a drastic simplification over the SDK-based handler's turn-by-turn state
 * machine — we lose mid-dispatch replay granularity but gain subscription
 * billing.
 *
 * Scope v0.1: happy-path execution + abort signal propagation + exit-code
 * translation. The existing SDK handler's heartbeat/audit pipeline is NOT
 * wired up in this path yet — that's a v0.2 integration.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface McpLauncherOpts {
  /** System prompt for the subagent. */
  systemPrompt: string;
  /** User task / first turn content. */
  task: string;
  /**
   * Tool names the subagent is allowed to call via MCP. Narrower than the
   * full gbrain MCP surface — matches the subagent's `allowed_tools` from
   * `src/core/minions/handlers/subagent.ts`.
   */
  allowedTools?: string[];
  /**
   * Model alias ('opus' | 'sonnet' | 'haiku') or full model ID. Passed to
   * `claude -p --model`. Defaults to 'sonnet' (the subagent's baseline).
   */
  model?: string;
  /** Signal to abort the subprocess. Maps to SIGTERM + 5s grace + SIGKILL. */
  signal?: AbortSignal;
  /** Max subprocess wall-clock time in ms. Default 10 minutes. */
  timeoutMs?: number;
  /** Path to `gbrain` binary. Auto-detected if omitted. */
  gbrainBin?: string;
  /** Path to `claude` binary. Auto-detected if omitted. */
  claudeBin?: string;
  /** Override for testing. */
  spawnFn?: typeof spawn;
}

export interface McpLauncherResult {
  /** Final assistant text (the loop's concluding answer). */
  result: string;
  /** Token usage as reported by claude -p. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  /** Raw JSON output from claude -p, for audit. */
  rawOutput: unknown;
  /** Wall-clock ms. */
  latencyMs: number;
  /** Exit code of the subprocess. */
  exitCode: number;
  /** Cost reported by claude -p (informational; Max billing is flat). */
  costUsd: number;
}

export class McpLauncherError extends Error {
  readonly kind: 'spawn_failed' | 'timeout' | 'aborted' | 'bad_exit' | 'bad_output' | 'bin_missing';
  readonly detail: string;
  constructor(kind: McpLauncherError['kind'], detail: string) {
    super(`mcp-launcher: ${kind}: ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

function syncWhich(bin: string): string | null {
  try {
    const out = execSync(`command -v ${bin}`, { encoding: 'utf-8' }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Build the MCP config JSON pointing at `gbrain serve` (stdio MCP server).
 * This is the format Claude Code's `--mcp-config` expects — same schema
 * users paste into their Claude Desktop config.
 */
export function buildMcpConfig(gbrainBin: string): object {
  return {
    mcpServers: {
      gbrain: {
        command: gbrainBin,
        args: ['serve'],
        env: {
          // Route gbrain's own logging to stderr so it doesn't pollute the
          // MCP stdio transport.
          GBRAIN_LOG_TARGET: 'stderr',
        },
      },
    },
  };
}

/**
 * Spawn `claude -p` with the given MCP config + prompt. Returns a
 * structured result OR throws `McpLauncherError` on any failure mode.
 *
 * The caller is responsible for higher-level audit (heartbeats, job
 * status persistence, abort-signal wiring). This function owns only the
 * spawn + parse + cleanup layer.
 */
export async function runSubagentViaMcp(opts: McpLauncherOpts): Promise<McpLauncherResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const claudeBin = opts.claudeBin ?? syncWhich('claude');
  const gbrainBin = opts.gbrainBin ?? syncWhich('gbrain');
  if (!claudeBin) throw new McpLauncherError('bin_missing', 'claude binary not on PATH');
  if (!gbrainBin) throw new McpLauncherError('bin_missing', 'gbrain binary not on PATH');

  // Write MCP config to a temp file. claude -p --mcp-config accepts a
  // file path; it reads + spawns the declared servers on startup.
  const dir = await mkdtemp(join(tmpdir(), 'gbrain-mcp-'));
  const cfgPath = join(dir, 'mcp-config.json');
  const cfg = buildMcpConfig(gbrainBin);
  await writeFile(cfgPath, JSON.stringify(cfg), { encoding: 'utf-8', mode: 0o600 });

  // Assemble claude -p args.
  const args = [
    '-p',
    '--output-format', 'json',
    '--mcp-config', cfgPath,
    '--strict-mcp-config', // only use our config, ignore user global MCP
    '--model', opts.model ?? 'sonnet',
  ];
  if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt);
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    // Scope tools to those the subagent explicitly requested. Tool names
    // from MCP are prefixed with the server name in claude -p's view:
    // `mcp__gbrain__<toolName>`. Pass them in that shape.
    const scoped = opts.allowedTools.map((t) => `mcp__gbrain__${t}`);
    args.push('--allowed-tools', scoped.join(','));
  }
  args.push(opts.task);

  // Strip inheritable auth env vars — let claude's native keychain auth
  // take over (the subscription path; OAuth env-var path is 401-blocked).
  const cleanEnv: Record<string, string> = {
    HOME: process.env.HOME ?? '',
    USER: process.env.USER ?? '',
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    SHELL: process.env.SHELL ?? '/bin/bash',
  };

  const startedAt = Date.now();
  const child: ChildProcess = spawnFn(claudeBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv,
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5_000).unref();
  };
  opts.signal?.addEventListener('abort', onAbort);

  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const timeoutTimer = setTimeout(() => {
    if (!aborted) {
      aborted = true;
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5_000).unref();
    }
  }, timeoutMs).unref();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', (err) => reject(new McpLauncherError('spawn_failed', err.message)));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 0)));
  });
  clearTimeout(timeoutTimer);
  opts.signal?.removeEventListener('abort', onAbort);

  const latencyMs = Date.now() - startedAt;

  // Cleanup MCP config tmpfile. Non-fatal if it fails.
  try { await rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }

  if (aborted && opts.signal?.aborted) {
    throw new McpLauncherError('aborted', `killed after ${latencyMs}ms via signal`);
  }
  if (aborted) {
    throw new McpLauncherError('timeout', `killed after ${timeoutMs}ms`);
  }

  const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
  const stderr = Buffer.concat(stderrChunks).toString('utf-8');

  if (exitCode !== 0) {
    throw new McpLauncherError(
      'bad_exit',
      `claude -p exit ${exitCode}; stderr: ${stderr.slice(0, 400)}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch (e) {
    throw new McpLauncherError(
      'bad_output',
      `non-JSON stdout: ${stdout.slice(0, 200)} (${(e as Error).message})`,
    );
  }

  if (parsed.is_error) {
    throw new McpLauncherError(
      'bad_output',
      `claude -p reported is_error=true: ${String(parsed.result).slice(0, 400)}`,
    );
  }

  const usage = (parsed.usage ?? {}) as Record<string, unknown>;
  return {
    result: String(parsed.result ?? ''),
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
    },
    rawOutput: parsed,
    latencyMs,
    exitCode,
    costUsd: Number(parsed.total_cost_usd ?? 0),
  };
}

/**
 * Return true if the `claude -p --mcp-config` codepath should be used for
 * subagent LLM calls. Opt-in via env var; the SDK path remains the default.
 *
 * Primary env var is `OLYMPUS_SUBAGENT_PROVIDER` (matches the Olympus brand).
 * `GBRAIN_SUBAGENT_PROVIDER` is accepted as a deprecated alias for
 * backward compatibility — will be removed in a future major. When BOTH
 * are set, OLYMPUS_* wins.
 */
export function shouldUseMcpProvider(): boolean {
  const primary = process.env.OLYMPUS_SUBAGENT_PROVIDER;
  if (primary !== undefined) return primary === 'claude-cli-mcp';
  return process.env.GBRAIN_SUBAGENT_PROVIDER === 'claude-cli-mcp';
}
