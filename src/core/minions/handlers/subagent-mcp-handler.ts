/**
 * MCP-provider path for the subagent handler. Routes the LLM+tool loop
 * through `claude -p --mcp-config` (native Claude Code CLI) so the
 * subscription covers the inference cost.
 *
 * Called from `subagent.ts` when `shouldUseMcpProvider()` returns true.
 * Produces the same `SubagentResult` shape as the SDK path, with these
 * observability tradeoffs explicitly accepted:
 *
 *   - No per-turn persistence. Claude Code runs the full tool loop
 *     inside its own process; we read a single final JSON. Crash-resume
 *     is therefore NOT SUPPORTED on this path — if the worker dies
 *     mid-run, the job is terminal.
 *   - Heartbeat audit is start + end only (no tool_called / tool_result
 *     events per turn). The `--verbose` flag on claude -p could surface
 *     intermediate events; adding that is a follow-up.
 *   - `turns_count` reports 1 (claude -p owns the loop; its turn counter
 *     isn't exposed in the JSON output). Token rollup IS accurate from
 *     claude -p's `usage` block.
 *
 * Gain: subscription billing instead of pay-as-you-go API costs.
 */

import type { MinionJobContext } from '../types.ts';
import type {
  SubagentHandlerData,
  SubagentResult,
  SubagentStopReason,
} from '../types.ts';
import { runSubagentViaMcp, McpLauncherError } from './subagent-mcp-launcher.ts';
import {
  logSubagentSubmission,
  logSubagentHeartbeat,
} from './subagent-audit.ts';

/**
 * Map a full Anthropic model ID to the alias `claude -p --model` accepts.
 * Kept in sync with the launcher's internal mapping.
 */
function modelToAlias(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes('opus')) return 'opus';
  if (id.includes('haiku')) return 'haiku';
  return 'sonnet';
}

export async function runSubagentMcpPath(
  ctx: MinionJobContext,
  data: SubagentHandlerData,
): Promise<SubagentResult> {
  const model = data.model ?? 'claude-sonnet-4-6';
  const systemPrompt = data.system ?? 'You are a helpful assistant running as a gbrain subagent.';

  logSubagentSubmission({
    caller: 'worker',
    remote: true,
    job_id: ctx.id,
    model,
    tools_count: (data.allowed_tools ?? []).length,
    allowed_tools: data.allowed_tools ?? [],
    provider: 'claude-cli-mcp',
  });

  logSubagentHeartbeat({ job_id: ctx.id, event: 'llm_call_started', turn_idx: 0, provider: 'claude-cli-mcp' });

  let launcherResult;
  try {
    launcherResult = await runSubagentViaMcp({
      systemPrompt,
      task: data.prompt,
      allowedTools: data.allowed_tools,
      model: modelToAlias(model),
      signal: ctx.signal,
      timeoutMs: 10 * 60 * 1000,
    });
  } catch (err) {
    const stopReason: SubagentStopReason = err instanceof McpLauncherError && err.kind === 'aborted'
      ? 'error'
      : 'error';
    logSubagentHeartbeat({
      job_id: ctx.id,
      event: 'tool_failed', // closest available event; represents overall loop failure
      turn_idx: 0,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      provider: 'claude-cli-mcp',
    });
    // Preserve the launcher's typed-error semantics: re-throw so the job
    // marker reflects 'error' state with the original message. Caller
    // (subagent.ts) will route to the job-failure persistence path.
    throw err;
  }

  logSubagentHeartbeat({
    job_id: ctx.id,
    event: 'llm_call_completed',
    turn_idx: 0,
    tokens_in: launcherResult.usage.inputTokens,
    tokens_out: launcherResult.usage.outputTokens,
    ms_elapsed: launcherResult.latencyMs,
    provider: 'claude-cli-mcp',
  });

  const result: SubagentResult = {
    result: launcherResult.result,
    // claude -p doesn't expose a turn counter in JSON output; report 1
    // (the "session" ran once) rather than a fabricated count.
    turns_count: 1,
    stop_reason: 'end_turn' as SubagentStopReason,
    tokens: {
      in: launcherResult.usage.inputTokens,
      out: launcherResult.usage.outputTokens,
      cache_read: launcherResult.usage.cacheReadTokens ?? 0,
      cache_create: launcherResult.usage.cacheCreationTokens ?? 0,
    },
  };
  return result;
}
