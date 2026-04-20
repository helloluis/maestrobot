import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  LLMProvider,
  ProviderType,
  Usage,
} from "./types.js"
import { ProviderError, parseToolCalls } from "./types.js"

const ARCEE_URL = "https://api.arcee.ai/api/v1/chat/completions"

// Current Trinity serverless catalog (2026-04). Arcee's older Virtuoso/
// Caller/Coder/Maestro names are gone — probe returned 404. If Arcee
// reintroduces them, add rows here.
const PRICING: Record<string, { input: number; output: number }> = {
  "trinity-mini":            { input: 0.045, output: 0.15 },
  "trinity-large-preview":   { input: 0.25,  output: 1.00 },
  "trinity-large-thinking":  { input: 0.25,  output: 0.90 },
}
const DEFAULT_PRICE = { input: 0.25, output: 1.00 }

export class ArceeProvider implements LLMProvider {
  readonly name = "Arcee"
  readonly type: ProviderType = "arcee"
  readonly defaultModel: string

  constructor(
    private apiKey: string,
    defaultModel = "trinity-large-preview",
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
    const res = await fetch(ARCEE_URL, {
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
      throw new ProviderError(this.type, res.status, errBody, `Arcee ${model} ${res.status}`)
    }
    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null
          reasoning?: string | null
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
    const reasoning = msg?.reasoning ?? msg?.reasoning_content ?? undefined
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
