import type { ProviderType } from "@maestrobot/providers"

export interface AgentPersona {
  callSign: string
  displayName: string
  bio: string
  avatarUrl?: string | null
}

export interface AgentTaste {
  loves: string
  hates: string
  // refs: audio corpus for CLAP/FAD comparison — deferred until audition() ships
}

export interface AgentDriver {
  provider: ProviderType
  model: string
  temperature?: number
  maxTokens?: number
}

export interface AgentDrivers {
  // Optional prose-plan stage before the compose tool call.
  // When present, this model writes a short textual brief that the
  // compose driver then realises via the generate_stem tool.
  plan?: AgentDriver
  // Optional polishing pass that takes the raw plan output and distils
  // it to 2-3 clean sentences. Pairs well with reasoning-capable plan
  // models (kimi-k2p5, glm-5p1, deepseek-reasoner) whose raw output
  // contains chain-of-thought scaffolding. Only runs if drivers.plan
  // also ran. Cheap non-reasoning instruct models fit (gemma-4-31b-it,
  // qwen3p6-plus, llama-v3p3-70b).
  planCleanup?: AgentDriver
  compose: AgentDriver
  judge: AgentDriver
  murmur: AgentDriver
}

export interface AgentCadence {
  tickEverySec: number
  // Local-time hours during which the agent is "live" (24h).
  // Missing = always live.
  activeHours?: [number, number]
}

export interface AgentAppetite {
  remixProb: number
  reactProb: number
  murmurProb: number
}

export interface AgentBudget {
  dailyUsdCap?: number
  dailyTokenCap?: number
}

export interface AgentConfig {
  persona: AgentPersona
  stylePrompt: string
  taste: AgentTaste
  drivers: AgentDrivers
  cadence: AgentCadence
  appetite: AgentAppetite
  affinities?: string[]
  budget?: AgentBudget
  journal?: boolean
  // Hex-encoded Nostr secret key. If absent, murmurs are synthesised but
  // not published.
  nostrSk?: string
}

export interface Stem {
  id: string
  title: string | null
  strudelCode: string
  generationPlan?: string | null
  modelUsed?: string | null
  bpm: number | null
  status: string
  createdAt: string
  creator: { id: string; callSign: string; kind: string }
  remixOf?: { id: string; title: string | null; creator: { callSign: string } } | null
  _count?: { likes: number; remixes: number }
}

export interface ApocAgent {
  id: string
  callSign: string
  displayName?: string | null
  kind: "HOUSE" | "SUMMONED"
  bio?: string | null
  avatarUrl?: string | null
  nostrPubkey?: string | null
  nip05?: string | null
}

export interface PairwisePreference {
  preferred: "a" | "b" | "tie"
  reasoning: string
}
