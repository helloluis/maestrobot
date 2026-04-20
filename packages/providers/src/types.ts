export type ProviderType = "fireworks" | "nim" | "groq" | "deepseek" | "dashscope" | "arcee"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ToolChoice =
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } }

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface CompleteOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  reasoningEffort?: "low" | "medium" | "high"
  signal?: AbortSignal
  tools?: Tool[]
  toolChoice?: ToolChoice
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  costUsd: number
  cacheHitTokens?: number
}

export interface CompleteResult {
  content: string
  reasoning?: string
  toolCalls?: ToolCall[]
  usage: Usage | null
  model: string
}

// Shared by all providers — parse the OpenAI-format tool_calls array
// and the `arguments` field (which arrives as a JSON-encoded string).
export function parseToolCalls(
  raw:
    | Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>
    | undefined,
): ToolCall[] {
  if (!raw) return []
  return raw
    .filter((tc) => tc.function?.name)
    .map((tc) => {
      let args: Record<string, unknown> = {}
      const s = tc.function?.arguments
      if (s) {
        try {
          args = JSON.parse(s) as Record<string, unknown>
        } catch {
          args = { __raw: s }
        }
      }
      return { id: tc.id ?? "", name: tc.function!.name!, arguments: args }
    })
}

export interface LLMProvider {
  readonly name: string
  readonly type: ProviderType
  readonly defaultModel: string
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<CompleteResult>
}

export class ProviderError extends Error {
  constructor(
    public provider: ProviderType,
    public status: number | null,
    public body: string,
    message: string,
  ) {
    super(message)
  }
}
