import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  LLMProvider,
  ProviderType,
  Usage,
} from "./types.js"
import { ProviderError, parseToolCalls } from "./types.js"

// DashScope exposes an OpenAI-compatible endpoint. The international
// domain is the right one for callers outside mainland China.
const DASHSCOPE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"

const PRICING: Record<string, { input: number; output: number }> = {
  "qwen-plus":    { input: 0.40, output: 1.20 },
  "qwen-flash":   { input: 0.03, output: 0.06 },
  "qwen-max":     { input: 1.60, output: 6.40 },
  "qwen3-coder-plus": { input: 0.60, output: 1.80 },
}
const DEFAULT_PRICE = { input: 0.40, output: 1.20 }

export class DashScopeProvider implements LLMProvider {
  readonly name = "DashScope"
  readonly type: ProviderType = "dashscope"
  readonly defaultModel: string

  constructor(
    private apiKey: string,
    defaultModel = "qwen-plus",
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
    if (options.tools?.length) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice ?? "auto"
    }
    const res = await fetch(DASHSCOPE_URL, {
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
      throw new ProviderError(this.type, res.status, errBody, `DashScope ${model} ${res.status}`)
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

    let usage: Usage | null = null
    if (data.usage) {
      const p = PRICING[model] ?? DEFAULT_PRICE
      usage = {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        costUsd:
          (data.usage.prompt_tokens * p.input + data.usage.completion_tokens * p.output) /
          1_000_000,
      }
    }
    return { content, reasoning, toolCalls, usage, model }
  }
}
