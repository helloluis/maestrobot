import { ArceeProvider } from "./arcee.js"
import { DashScopeProvider } from "./dashscope.js"
import { DeepSeekProvider } from "./deepseek.js"
import { FireworksProvider } from "./fireworks.js"
import { GroqProvider } from "./groq.js"
import { NimProvider } from "./nim.js"
import type { LLMProvider, ProviderType } from "./types.js"

export * from "./types.js"
export { ArceeProvider, DashScopeProvider, DeepSeekProvider, FireworksProvider, GroqProvider, NimProvider }

export interface ProviderRegistryEnv {
  FIREWORKS_API_KEY?: string
  NVIDIA_NIM_API_KEY?: string
  NVIDIA_NIM_BASE_URL?: string
  GROQ_API_KEY?: string
  DEEPSEEK_API_KEY?: string
  DASHSCOPE_API_KEY?: string
  ARCEE_API_KEY?: string
}

export class ProviderRegistry {
  private providers = new Map<ProviderType, LLMProvider>()

  constructor(env: ProviderRegistryEnv = process.env as ProviderRegistryEnv) {
    if (env.FIREWORKS_API_KEY) {
      this.providers.set("fireworks", new FireworksProvider(env.FIREWORKS_API_KEY))
    }
    if (env.NVIDIA_NIM_API_KEY) {
      this.providers.set("nim", new NimProvider(env.NVIDIA_NIM_API_KEY, undefined, env.NVIDIA_NIM_BASE_URL))
    }
    if (env.GROQ_API_KEY) {
      this.providers.set("groq", new GroqProvider(env.GROQ_API_KEY))
    }
    if (env.DEEPSEEK_API_KEY) {
      this.providers.set("deepseek", new DeepSeekProvider(env.DEEPSEEK_API_KEY))
    }
    if (env.DASHSCOPE_API_KEY) {
      this.providers.set("dashscope", new DashScopeProvider(env.DASHSCOPE_API_KEY))
    }
    if (env.ARCEE_API_KEY) {
      this.providers.set("arcee", new ArceeProvider(env.ARCEE_API_KEY))
    }
  }

  get(type: ProviderType): LLMProvider {
    const p = this.providers.get(type)
    if (!p) {
      throw new Error(
        `provider '${type}' not configured — set the matching env key (see .env.example)`,
      )
    }
    return p
  }

  has(type: ProviderType): boolean {
    return this.providers.has(type)
  }

  available(): ProviderType[] {
    return Array.from(this.providers.keys())
  }
}
