#!/usr/bin/env bun
/**
 * Subscription Gateway — Anthropic-API-compatible HTTP shim that routes
 * `POST /v1/messages` requests through the native `claude -p` subprocess,
 * which authenticates against the user's Claude Max subscription.
 *
 * Why: Anthropic server-side blocks OAuth-token programmatic access to
 * /v1/messages (2026-04 policy shift). The native `claude` CLI still
 * authenticates via keychain-stored session auth and its subscription
 * billing path works. This shim brings the subscription into any SDK
 * caller that respects `ANTHROPIC_BASE_URL`.
 *
 * Scope (v0.1): text-only messages. Tool use, streaming, and vision
 * are not translated; the shim rejects those with a clear 400 error
 * so gbrain callers fall back to their error paths. Tool-use support
 * is a future extension.
 *
 * Usage:
 *   bun scripts/subscription-gateway/server.ts --port 8787
 *   export ANTHROPIC_BASE_URL=http://localhost:8787
 *   export ANTHROPIC_API_KEY=dummy-gateway  # SDK requires non-empty
 *   # Now any `new Anthropic().messages.create(...)` hits this shim.
 */

import { spawn } from "bun";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
}

interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  system?: string | Array<{ type: string; text: string }>;
  messages: AnthropicMessage[];
  tools?: unknown[];
  stream?: boolean;
  temperature?: number;
}

const PORT = Number(process.env.GATEWAY_PORT ?? 8787);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const MAX_CONCURRENT = Number(process.env.GATEWAY_MAX_CONCURRENT ?? 3);
const MAX_PROMPT_CHARS = 500_000;

let active = 0;
const queue: Array<() => void> = [];

async function acquireSlot(): Promise<() => void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return () => {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    };
  }
  return new Promise<() => void>((resolve) => {
    queue.push(() => {
      active += 1;
      resolve(() => {
        active -= 1;
        const next = queue.shift();
        if (next) next();
      });
    });
  });
}

function flattenContent(
  content: AnthropicMessage["content"] | AnthropicRequest["system"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function mapModelToCliAlias(modelId: string): string {
  // `claude -p --model` accepts aliases: opus, sonnet, haiku (+ explicit IDs).
  // Gbrain requests often carry full model IDs like `claude-sonnet-4-5-20250929`
  // or `claude-3-5-haiku-latest`; map to the nearest alias.
  const id = modelId.toLowerCase();
  if (id.includes("opus")) return "opus";
  if (id.includes("haiku")) return "haiku";
  if (id.includes("sonnet")) return "sonnet";
  // Default to the current Claude Code-configured model.
  return "sonnet";
}

interface ClaudeResult {
  type: "result";
  is_error: boolean;
  result: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  total_cost_usd?: number;
}

async function callClaude(opts: {
  system: string;
  prompt: string;
  model: string;
  maxTokens: number;
}): Promise<ClaudeResult> {
  const args = ["-p", "--output-format", "json", "--model", opts.model];
  if (opts.system) {
    args.push("--append-system-prompt", opts.system);
  }
  args.push(opts.prompt);

  // Strip inheritable auth env vars — native `claude` must read its own
  // keychain credentials, not a stale or non-existent env OAuth token.
  const cleanEnv: Record<string, string> = {
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    SHELL: process.env.SHELL ?? "/bin/bash",
  };

  const proc = spawn({
    cmd: [CLAUDE_BIN, ...args],
    env: cleanEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`claude -p exited ${exitCode}: ${stderr.slice(0, 400)}`);
  }
  const parsed = JSON.parse(stdout);
  if (parsed.is_error) {
    throw new Error(`claude -p returned error: ${String(parsed.result).slice(0, 400)}`);
  }
  return parsed as ClaudeResult;
}

function anthropicError(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

async function handleMessages(req: Request): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await req.json()) as AnthropicRequest;
  } catch {
    return anthropicError(400, "invalid_request_error", "malformed JSON body");
  }

  if (!body.model) {
    return anthropicError(400, "invalid_request_error", "missing model");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return anthropicError(400, "invalid_request_error", "missing messages");
  }
  if (body.stream) {
    return anthropicError(400, "invalid_request_error", "stream unsupported by gateway v0.1");
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return anthropicError(400, "invalid_request_error", "tool_use unsupported by gateway v0.1");
  }

  const systemPrompt = flattenContent(body.system ?? "");
  const promptBody = body.messages
    .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${flattenContent(m.content)}`)
    .join("\n\n");

  if (promptBody.length > MAX_PROMPT_CHARS) {
    return anthropicError(
      400,
      "invalid_request_error",
      `prompt exceeds ${MAX_PROMPT_CHARS} char cap`,
    );
  }

  const release = await acquireSlot();
  try {
    const started = Date.now();
    const result = await callClaude({
      system: systemPrompt,
      prompt: promptBody,
      model: mapModelToCliAlias(body.model),
      maxTokens: body.max_tokens ?? 1024,
    });
    const latencyMs = Date.now() - started;

    const usage = result.usage ?? { input_tokens: 0, output_tokens: 0 };
    const responseId = `msg_gateway_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const anthropicResponse = {
      id: responseId,
      type: "message" as const,
      role: "assistant" as const,
      content: [{ type: "text" as const, text: result.result }],
      model: body.model,
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
    };
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        level: "info",
        msg: "gateway.messages.ok",
        model: body.model,
        cliAlias: mapModelToCliAlias(body.model),
        in: usage.input_tokens,
        out: usage.output_tokens,
        latencyMs,
        queueDepth: queue.length,
      }),
    );
    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        level: "error",
        msg: "gateway.messages.fail",
        model: body.model,
        err: msg.slice(0, 400),
      }),
    );
    return anthropicError(502, "api_error", msg.slice(0, 400));
  } finally {
    release();
  }
}

async function handleHealth(): Promise<Response> {
  return new Response(
    JSON.stringify({
      ok: true,
      gateway: "anthropic-subscription-shim",
      version: "0.1.0",
      active,
      queue_depth: queue.length,
      max_concurrent: MAX_CONCURRENT,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname === "/") return handleHealth();
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      return handleMessages(req);
    }
    return anthropicError(404, "not_found_error", `no route for ${req.method} ${url.pathname}`);
  },
});

console.log(
  JSON.stringify({
    t: new Date().toISOString(),
    level: "info",
    msg: "gateway.listening",
    port: PORT,
    max_concurrent: MAX_CONCURRENT,
    claude_bin: CLAUDE_BIN,
  }),
);
