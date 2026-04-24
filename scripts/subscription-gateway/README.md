# Subscription Gateway — Max-subscription proxy for `@anthropic-ai/sdk` callers

Anthropic's server rejects OAuth-token programmatic access to `/v1/messages`
(HTTP 401 `"OAuth authentication is currently not supported"`, observed
2026-04-24). Native `claude -p` subprocess calls still work — they auth
through keychain-stored session credentials that Anthropic accepts.

This gateway sits in front of any Anthropic-SDK caller and translates
`POST /v1/messages` requests into `claude -p --output-format json` subprocess
invocations. The SDK sees a normal Anthropic-API endpoint; the subprocess
bills against the user's Claude Max subscription.

## Status: v0.1 — text only

Supported:
- Single- and multi-turn text-only messages
- `system` prompt (string or `[{type:"text", text}]` blocks)
- Model aliasing: `claude-*-opus-*` → `opus`, `*-sonnet-*` → `sonnet`, `*-haiku-*` → `haiku`
- Concurrent request queueing (default 3, bounded via `GATEWAY_MAX_CONCURRENT`)
- Anthropic-SDK-compatible response shape (`id`, `content[{type:"text",text}]`, `usage`)

Not supported (yet — returns HTTP 400 with clear error):
- `tools` / tool use
- `stream: true`
- Vision / image content blocks

## Usage

### Start the gateway

```bash
bun scripts/subscription-gateway/server.ts
# Or launch via env vars:
GATEWAY_PORT=8787 GATEWAY_MAX_CONCURRENT=3 bun scripts/subscription-gateway/server.ts
```

It logs one JSON line per accepted request + one on each failure.

### Point any Anthropic SDK caller at it

```bash
export ANTHROPIC_BASE_URL="http://localhost:8787"
export ANTHROPIC_API_KEY="dummy-gateway"   # SDK requires non-empty; value is ignored
```

Then any `new Anthropic()` / `anthropic.messages.create(...)` routes through
the gateway. For gbrain specifically, add these two env vars to `~/.gbrain/.env`
and re-source.

### Test end-to-end

```bash
curl -sS -X POST http://localhost:8787/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: dummy" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-3-5-sonnet-latest","max_tokens":20,
       "messages":[{"role":"user","content":"Reply with exactly: GATEWAY_OK"}]}' \
  | jq .
```

Expected: `{"id":"msg_gateway_...","content":[{"type":"text","text":"GATEWAY_OK"}],...}`

## Rationale

- `claude -p` spawn cost ≈ 3–6s (cache creation + CLI startup). Acceptable for
  background-brain work (query expansion, enrichment, summarization). Not
  appropriate for latency-sensitive chat UIs.
- Max subscription flat-rate billing absorbs the cost shown in `claude -p`'s
  `total_cost_usd` field — that number is informational, not a bill against
  the subscription.
- Concurrency cap prevents runaway forking under heavy gbrain import workloads.

## Rollback

Unset `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` in `~/.gbrain/.env` and
`~/.zshrc`. Kill the gateway process. gbrain reverts to direct SDK → Anthropic
API (which 401s, but doesn't break anything else — it's as if no key is set).

## Known gaps / follow-ups

1. **Tool-use translation** — non-trivial. Would require parsing the
   Anthropic SDK tool-use format and mapping to `claude -p`'s internal tool
   interface, then translating results back. Est. 2–3h.
2. **Streaming** — `claude -p` supports `--output-format stream-json`. Adding
   SSE at the gateway edge is ~1h.
3. **Prompt caching** — `claude -p` creates its own ephemeral cache blocks
   visible in the `usage` field; pass-through works, but we don't currently
   expose cache-control markers from the SDK caller's side to the CLI.
4. **Long-prompt splitting** — hard-capped at `MAX_PROMPT_CHARS=500_000`.
   Larger prompts get a 400 back; caller must split.
5. **Supervision** — no launchd/systemd unit shipped. For always-on, wrap in
   your preferred process manager.
