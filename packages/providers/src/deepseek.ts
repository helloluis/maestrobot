import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  LLMProvider,
  ProviderType,
  Usage,
} from "./types.js"
import { ProviderError, parseToolCalls } from "./types.js"

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"

// DeepSeek's cache-hit tier is the reason to call it directly rather
// than via Fireworks — reasoning runs with a stable system prompt pay
// ~10× less on repeat. Track cacheHit tokens separately so budget
// accounting reflects what we actually spent.
const PRICING = {
  inputCacheHit:  0.028,
  inputCacheMiss: 0.28,
  output:         1.10,
}

export class DeepSeekProvider implements LLMProvider {
  readonly name = "DeepSeek"
  readonly type: ProviderType = "deepseek"
  readonly defaultModel: string

  constructor(
    private apiKey: string,
    defaultModel = "deepseek-reasoner",
  ) {
    this.defaultModel = defaultModel
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<CompleteResult> {
    const model = options.model ?? this.defaultModel
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.5,
      max_tokens: options.maxTokens ?? 2048,
    }
    if (options.tools?.length) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice ?? "auto"
    }
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      throw new ProviderError(this.type, res.status, errBody, `DeepSeek ${model} ${res.status}`)
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
      usage?: {
        prompt_tokens: number
        completion_tokens: number
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
      }
    }
    const msg = data.choices[0]?.message
    const content = msg?.content ?? ""
    const reasoning = msg?.reasoning_content ?? undefined
    const toolCalls = parseToolCalls(msg?.tool_calls)

    let usage: Usage | null = null
    if (data.usage) {
      const hit = data.usage.prompt_cache_hit_tokens ?? 0
      const miss = data.usage.prompt_cache_miss_tokens ?? data.usage.prompt_tokens
      const cost =
        (hit * PRICING.inputCacheHit +
          miss * PRICING.inputCacheMiss +
          data.usage.completion_tokens * PRICING.output) /
        1_000_000
      usage = {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        costUsd: cost,
        cacheHitTokens: hit,
      }
    }
    return { content, reasoning, toolCalls, usage, model }
  }
}
