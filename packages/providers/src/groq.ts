import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  LLMProvider,
  ProviderType,
  Usage,
} from "./types.js"
import { ProviderError, parseToolCalls } from "./types.js"

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

// Groq pricing is per-model and cheap. Annotating only the ones we use.
const PRICING: Record<string, { input: number; output: number }> = {
  "llama-3.3-70b-versatile":       { input: 0.59, output: 0.79 },
  "llama-3.1-8b-instant":          { input: 0.05, output: 0.08 },
  "moonshotai/kimi-k2-instruct":   { input: 1.00, output: 3.00 },
  "openai/gpt-oss-120b":           { input: 0.15, output: 0.60 },
  "qwen/qwen3-32b":                { input: 0.29, output: 0.59 },
}
const DEFAULT_PRICE = { input: 0.30, output: 0.60 }

export class GroqProvider implements LLMProvider {
  readonly name = "Groq"
  readonly type: ProviderType = "groq"
  readonly defaultModel: string

  constructor(
    private apiKey: string,
    defaultModel = "llama-3.3-70b-versatile",
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
    const res = await fetch(GROQ_URL, {
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
      throw new ProviderError(this.type, res.status, errBody, `Groq ${model} ${res.status}`)
    }
    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null
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
    const toolCalls = parseToolCalls(msg?.tool_calls)
    const usage: Usage | null = data.usage
      ? (() => {
          const p = PRICING[model] ?? DEFAULT_PRICE
          return {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            costUsd:
              (data.usage.prompt_tokens * p.input + data.usage.completion_tokens * p.output) /
              1_000_000,
          }
        })()
      : null
    return { content, toolCalls, usage, model }
  }
}
