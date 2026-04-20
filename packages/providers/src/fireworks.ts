import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  LLMProvider,
  ProviderType,
  Usage,
} from "./types.js"
import { ProviderError, parseToolCalls } from "./types.js"

const FIREWORKS_URL = "https://api.fireworks.ai/inference/v1/chat/completions"

// Per-million-token pricing for the currently-serverless catalog as of
// 2026-04. Exact rates come from fireworks.ai/pricing; (approx) flags
// ones not individually itemised on the public pricing table.
// Drifts over time — missing models fall back to DEFAULT_PRICE.
const PRICING: Record<string, { input: number; output: number }> = {
  // Kimi
  "accounts/fireworks/models/kimi-k2p5":                   { input: 0.60, output: 3.00 },
  "accounts/fireworks/models/kimi-k2-instruct":            { input: 0.60, output: 2.50 },
  // MiniMax
  "accounts/fireworks/models/minimax-m2p7":                { input: 0.30, output: 1.20 },
  "accounts/fireworks/models/minimax-m2p5":                { input: 0.30, output: 1.20 },
  // GLM (Zhipu)
  "accounts/fireworks/models/glm-5p1":                     { input: 1.40, output: 4.40 },
  "accounts/fireworks/models/glm-5":                       { input: 1.00, output: 3.20 },
  "accounts/fireworks/models/glm-4p7":                     { input: 0.60, output: 2.20 },
  "accounts/fireworks/models/glm-4p7-flash":               { input: 0.20, output: 0.80 }, // approx
  // Qwen
  "accounts/fireworks/models/qwen3p6-plus":                { input: 0.40, output: 1.20 }, // approx, newest
  "accounts/fireworks/models/qwen3-30b-a3b-instruct-2507": { input: 0.15, output: 0.60 },
  "accounts/fireworks/models/qwen3-4b-instruct-2507":      { input: 0.10, output: 0.30 }, // approx
  "accounts/fireworks/models/qwen3p5-9b":                  { input: 0.20, output: 0.40 }, // approx
  // Gemma
  "accounts/fireworks/models/gemma-4-31b-it":              { input: 0.30, output: 0.90 }, // approx
  "accounts/fireworks/models/gemma-4-31b-it-nvfp4":        { input: 0.30, output: 0.90 }, // approx, fp4 quantized
  // Llama
  "accounts/fireworks/models/llama-v3p3-70b-instruct":     { input: 0.90, output: 0.90 },
  "accounts/fireworks/models/llama-v3p2-3b-instruct":      { input: 0.10, output: 0.10 }, // approx
  // DeepSeek
  "accounts/fireworks/models/deepseek-v3p2":               { input: 0.56, output: 1.68 },
  "accounts/fireworks/models/deepseek-v3p1":               { input: 0.56, output: 1.68 },
  // Deep Cogito (hybrid reasoning)
  "accounts/fireworks/models/cogito-671b-v2-p1":           { input: 1.50, output: 4.50 }, // approx
  // OpenAI open-weights
  "accounts/fireworks/models/gpt-oss-120b":                { input: 0.15, output: 0.60 },
}
const DEFAULT_PRICE = { input: 0.50, output: 1.50 }

export class FireworksProvider implements LLMProvider {
  readonly name = "Fireworks"
  readonly type: ProviderType = "fireworks"
  readonly defaultModel: string

  constructor(
    private apiKey: string,
    defaultModel = "accounts/fireworks/models/kimi-k2p5",
  ) {
    this.defaultModel = defaultModel
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<CompleteResult> {
    const model = options.model ?? this.defaultModel
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
    }
    if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort
    if (options.tools?.length) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice ?? "auto"
    }

    // Fireworks intermittently 500s on tool-call requests, especially
    // with oneOf schemas. Retry with backoff on 5xx; bail on 4xx (those
    // are our fault and won't change).
    let res: Response
    let errBody = ""
    let attempt = 0
    const maxAttempts = 3
    while (true) {
      res = await fetch(FIREWORKS_URL, {
        method: "POST",
        signal: options.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      })
      if (res.ok) break
      errBody = await res.text().catch(() => "")
      const isTransient = res.status >= 500 && res.status < 600
      if (!isTransient || ++attempt >= maxAttempts) break
      const backoffMs = 500 * 2 ** (attempt - 1)
      console.warn(`[fireworks] ${model} ${res.status}, retry ${attempt}/${maxAttempts - 1} in ${backoffMs}ms`)
      await new Promise((r) => setTimeout(r, backoffMs))
    }
    if (!res.ok) {
      if (process.env.MAESTROBOT_DEBUG_HTTP === "1") {
        console.error("[fireworks] request body was:", JSON.stringify(body, null, 2).slice(0, 2000))
      }
      throw new ProviderError(this.type, res.status, errBody, `Fireworks ${model} ${res.status}`)
    }
    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null
          reasoning_content?: string | null
          tool_calls?: Array<{
            id?: string
            type?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
      usage?: { prompt_tokens: number; completion_tokens: number }
    }
    const msg = data.choices[0]?.message
    const content = msg?.content ?? ""
    const reasoning = msg?.reasoning_content ?? undefined
    const toolCalls = parseToolCalls(msg?.tool_calls)
    return { content, reasoning, toolCalls, usage: priceUsage(model, data.usage), model }
  }
}

function priceUsage(
  model: string,
  u?: { prompt_tokens: number; completion_tokens: number },
): Usage | null {
  if (!u) return null
  const p = PRICING[model] ?? DEFAULT_PRICE
  return {
    inputTokens: u.prompt_tokens,
    outputTokens: u.completion_tokens,
    costUsd: (u.prompt_tokens * p.input + u.completion_tokens * p.output) / 1_000_000,
  }
}
