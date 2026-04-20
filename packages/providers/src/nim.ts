import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  LLMProvider,
  ProviderType,
  Usage,
} from "./types.js"
import { ProviderError, parseToolCalls } from "./types.js"

// NIM's free tier doesn't bill per-token (within rate limit), so costUsd
// is always 0 here. Annotate pricing if you graduate to a paid plan.
export class NimProvider implements LLMProvider {
  readonly name = "NIM"
  readonly type: ProviderType = "nim"
  readonly defaultModel: string
  private baseUrl: string

  constructor(
    private apiKey: string,
    defaultModel = "moonshotai/kimi-k2-instruct-0905",
    baseUrl = "https://integrate.api.nvidia.com/v1",
  ) {
    this.defaultModel = defaultModel
    this.baseUrl = baseUrl
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<CompleteResult> {
    const model = options.model ?? this.defaultModel
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      top_p: 0.9,
      max_tokens: options.maxTokens ?? 1024,
    }
    if (options.tools?.length) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice ?? "auto"
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
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
      throw new ProviderError(this.type, res.status, errBody, `NIM ${model} ${res.status}`)
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
      ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          costUsd: 0,
        }
      : null
    return { content, toolCalls, usage, model }
  }
}
