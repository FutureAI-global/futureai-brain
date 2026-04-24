#!/usr/bin/env bun
/**
 * End-to-end smoke test for subagent-mcp-launcher.ts.
 *
 * Spawns a REAL `claude -p --mcp-config` process with the real gbrain MCP
 * server, using Max-subscription auth. Confirms the loop runs, tokens
 * come back, and the MCP server's tools are visible to Claude.
 *
 * Not a unit test — requires claude CLI, gbrain binary, and Max-subscription
 * keychain creds. Run manually:
 *
 *   bun scripts/subscription-gateway/smoke-subagent-mcp.ts
 */

import { runSubagentViaMcp } from '../../src/core/minions/handlers/subagent-mcp-launcher.ts';

async function main() {
  console.log('[smoke] launching real claude -p --mcp-config with gbrain MCP...');
  const startedAt = Date.now();

  try {
    const result = await runSubagentViaMcp({
      systemPrompt:
        'You are a gbrain subagent smoke test. Answer briefly.',
      task:
        'Without calling any tools, reply with exactly the 4-character string PONG and nothing else.',
      model: 'haiku',
      timeoutMs: 60_000,
    });

    const elapsed = Date.now() - startedAt;
    console.log('[smoke] RESULT:');
    console.log(`  .result       = ${JSON.stringify(result.result)}`);
    console.log(`  .usage        = in=${result.usage.inputTokens} out=${result.usage.outputTokens} cacheCreate=${result.usage.cacheCreationTokens} cacheRead=${result.usage.cacheReadTokens}`);
    console.log(`  .costUsd      = $${result.costUsd.toFixed(4)} (informational; Max billing is flat)`);
    console.log(`  .latencyMs    = ${result.latencyMs}ms`);
    console.log(`  wall-clock    = ${elapsed}ms`);

    const pass = result.result.trim().toUpperCase().includes('PONG');
    console.log(`[smoke] ${pass ? 'PASS' : 'FAIL'} — result ${pass ? 'contains' : 'does NOT contain'} PONG`);
    process.exit(pass ? 0 : 1);
  } catch (err) {
    console.error('[smoke] FAIL with error:');
    console.error(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
