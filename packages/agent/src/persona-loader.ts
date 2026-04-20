import type { Maestrodb, PersonaWithDrivers } from "@maestrobot/db"
import type { AgentConfig, AgentDriver, AgentDrivers } from "./types.js"

// JSON persona config shape — what agents/*.json files contain. This is the
// same as AgentConfig but kept as a distinct type so the DB round-trip stays
// honest: the loader is the one place JSON ↔ DB mapping lives.
export type JsonPersonaFile = AgentConfig

export function upsertFromJson(
  db: Maestrodb,
  json: JsonPersonaFile,
): { personaId: string; config: AgentConfig } {
  const id = db.upsertPersona({
    callSign: json.persona.callSign,
    displayName: json.persona.displayName,
    bio: json.persona.bio ?? null,
    avatarUrl: json.persona.avatarUrl ?? null,
    stylePrompt: json.stylePrompt,
    taste: { loves: json.taste.loves, hates: json.taste.hates },
    cadence: {
      tickEverySec: json.cadence.tickEverySec,
      activeStart: json.cadence.activeHours?.[0] ?? null,
      activeEnd: json.cadence.activeHours?.[1] ?? null,
    },
    appetite: {
      remixProb: json.appetite.remixProb,
      reactProb: json.appetite.reactProb,
      murmurProb: json.appetite.murmurProb,
    },
    affinities: json.affinities ?? [],
    budget: {
      dailyUsdCap: json.budget?.dailyUsdCap ?? null,
      dailyTokenCap: json.budget?.dailyTokenCap ?? null,
    },
    nostrSk: json.nostrSk ?? null,
    journalEnabled: json.journal !== false,
    apocAgentId: null,
  })
  const roleMap: Array<[keyof AgentDrivers, "plan" | "plan_cleanup" | "compose" | "judge" | "murmur"]> = [
    ["plan", "plan"],
    ["planCleanup", "plan_cleanup"],
    ["compose", "compose"],
    ["judge", "judge"],
    ["murmur", "murmur"],
  ]
  for (const [configKey, dbRole] of roleMap) {
    const d = json.drivers[configKey]
    if (!d) {
      db.deleteDriver(id, dbRole)
      continue
    }
    db.upsertDriver(id, {
      role: dbRole,
      provider: d.provider,
      model: d.model,
      temperature: d.temperature ?? null,
      maxTokens: d.maxTokens ?? null,
    })
  }
  const config = dbToConfig(db.getPersona(json.persona.callSign)!)
  return { personaId: id, config }
}

export function dbToConfig(row: PersonaWithDrivers): AgentConfig {
  const drivers: AgentDrivers = {
    compose: driverOrThrow(row, "compose"),
    judge: driverOrThrow(row, "judge"),
    murmur: driverOrThrow(row, "murmur"),
  }
  const plan = row.drivers.plan
  if (plan) drivers.plan = toAgentDriver(plan)
  const planCleanup = row.drivers.plan_cleanup
  if (planCleanup) drivers.planCleanup = toAgentDriver(planCleanup)
  return {
    persona: {
      callSign: row.callSign,
      displayName: row.displayName,
      bio: row.bio ?? "",
      avatarUrl: row.avatarUrl,
    },
    stylePrompt: row.stylePrompt,
    taste: { loves: row.taste.loves, hates: row.taste.hates },
    drivers,
    cadence: {
      tickEverySec: row.cadence.tickEverySec,
      ...(row.cadence.activeStart !== null && row.cadence.activeEnd !== null
        ? { activeHours: [row.cadence.activeStart, row.cadence.activeEnd] as [number, number] }
        : {}),
    },
    appetite: row.appetite,
    affinities: row.affinities,
    ...(row.budget.dailyUsdCap !== null || row.budget.dailyTokenCap !== null
      ? {
          budget: {
            ...(row.budget.dailyUsdCap !== null ? { dailyUsdCap: row.budget.dailyUsdCap } : {}),
            ...(row.budget.dailyTokenCap !== null
              ? { dailyTokenCap: row.budget.dailyTokenCap }
              : {}),
          },
        }
      : {}),
    journal: row.journalEnabled,
    ...(row.nostrSk ? { nostrSk: row.nostrSk } : {}),
  }
}

function driverOrThrow(
  row: PersonaWithDrivers,
  role: "compose" | "judge" | "murmur",
): AgentDriver {
  const d = row.drivers[role]
  if (!d) {
    throw new Error(
      `persona '${row.callSign}' has no '${role}' driver configured — every agent must have compose, judge, murmur.`,
    )
  }
  return toAgentDriver(d)
}

function toAgentDriver(d: {
  provider: string
  model: string
  temperature: number | null
  maxTokens: number | null
}): AgentDriver {
  return {
    provider: d.provider as AgentDriver["provider"],
    model: d.model,
    ...(d.temperature !== null ? { temperature: d.temperature } : {}),
    ...(d.maxTokens !== null ? { maxTokens: d.maxTokens } : {}),
  }
}
