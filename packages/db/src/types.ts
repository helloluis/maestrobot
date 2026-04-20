export type DriverRole = "plan" | "plan_cleanup" | "compose" | "judge" | "murmur"

export interface PersonaRow {
  id: string
  callSign: string
  displayName: string
  bio: string | null
  avatarUrl: string | null
  stylePrompt: string
  taste: { loves: string; hates: string }
  cadence: { tickEverySec: number; activeStart: number | null; activeEnd: number | null }
  appetite: { remixProb: number; reactProb: number; murmurProb: number }
  affinities: string[]
  budget: { dailyUsdCap: number | null; dailyTokenCap: number | null }
  nostrSk: string | null
  journalEnabled: boolean
  apocAgentId: string | null
  createdAt: string
  updatedAt: string
}

export interface DriverRow {
  role: DriverRole
  provider: string
  model: string
  temperature: number | null
  maxTokens: number | null
}

export interface PersonaWithDrivers extends PersonaRow {
  drivers: Record<DriverRole, DriverRow | null>
}

export interface StemRow {
  id: string
  personaId: string
  parentStemId: string | null
  parentApocStemId: string | null
  title: string | null
  plan: string | null
  specJson: string | null
  code: string | null
  error: string | null
  planModel: string | null
  planCostUsd: number | null
  composeModel: string | null
  composeCostUsd: number | null
  apocStemId: string | null
  publishedAt: string | null
  createdAt: string
}

export interface PreferenceRow {
  id: string
  personaId: string
  stemAId: string
  stemBId: string
  preferred: "a" | "b" | "tie"
  reasoning: string | null
  judgeModel: string | null
  costUsd: number | null
  createdAt: string
}

export interface MurmurRow {
  id: string
  personaId: string
  content: string
  subjectStemId: string | null
  pairAId: string | null
  pairBId: string | null
  preferenceId: string | null
  murmurModel: string | null
  costUsd: number | null
  nostrEventId: string | null
  publishedAt: string | null
  createdAt: string
}
