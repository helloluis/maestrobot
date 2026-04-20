import Database, { type Database as Db } from "better-sqlite3"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import type {
  DriverRole,
  DriverRow,
  MurmurRow,
  PersonaRow,
  PersonaWithDrivers,
  PreferenceRow,
  StemRow,
} from "./types.js"

export * from "./types.js"

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(resolve(here, "./schema.sql"), "utf8")
const SCHEMA_VERSION = 2

export class Maestrodb {
  readonly db: Db

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("foreign_keys = ON")
    this.db.exec(SCHEMA_SQL)
    this.applyMigrations()
  }

  // Forward-only migration layer. We read the current version, apply
  // each step in sequence, then stamp the target version. Fresh installs
  // skip all ALTERs because schema.sql already creates the latest shape.
  private applyMigrations(): void {
    const existing = this.db
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | undefined

    // Fresh DB — schema.sql created everything at latest. Just stamp.
    if (!existing) {
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION)
      return
    }

    let current = existing.version

    // v0 → v1: add stems.title. (Applies to DBs from before v1 stamping.)
    if (current < 1) {
      try {
        this.db.exec("ALTER TABLE stems ADD COLUMN title TEXT")
      } catch (e) {
        if (!/duplicate column/.test((e as Error).message)) throw e
      }
      current = 1
    }

    // v1 → v2: rebuild persona_drivers without the CHECK constraint so
    // we can add new role values (plan_cleanup, etc.) without further
    // schema surgery.
    if (current < 2) {
      this.db.exec(`
        CREATE TABLE persona_drivers_new (
          persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
          role        TEXT NOT NULL,
          provider    TEXT NOT NULL,
          model       TEXT NOT NULL,
          temperature REAL,
          max_tokens  INTEGER,
          PRIMARY KEY (persona_id, role)
        );
        INSERT INTO persona_drivers_new SELECT * FROM persona_drivers;
        DROP TABLE persona_drivers;
        ALTER TABLE persona_drivers_new RENAME TO persona_drivers;
      `)
      current = 2
    }

    this.db.prepare("UPDATE schema_version SET version = ?").run(current)
  }

  close(): void {
    this.db.close()
  }

  // ─── Personas ──────────────────────────────────────────────────

  upsertPersona(p: Omit<PersonaRow, "id" | "createdAt" | "updatedAt"> & { id?: string }): string {
    const existing = this.db
      .prepare("SELECT id FROM personas WHERE call_sign = ?")
      .get(p.callSign) as { id: string } | undefined
    const id = p.id ?? existing?.id ?? randomUUID()
    this.db
      .prepare(
        `INSERT INTO personas (
           id, call_sign, display_name, bio, avatar_url, style_prompt,
           taste_loves, taste_hates,
           cadence_tick_every_sec, cadence_active_start, cadence_active_end,
           appetite_remix_prob, appetite_react_prob, appetite_murmur_prob,
           affinities_json, budget_daily_usd_cap, budget_daily_token_cap,
           nostr_sk, journal_enabled, apoc_agent_id
         ) VALUES (
           @id, @callSign, @displayName, @bio, @avatarUrl, @stylePrompt,
           @tasteLoves, @tasteHates,
           @tickEverySec, @activeStart, @activeEnd,
           @remixProb, @reactProb, @murmurProb,
           @affinitiesJson, @dailyUsdCap, @dailyTokenCap,
           @nostrSk, @journalEnabled, @apocAgentId
         )
         ON CONFLICT(id) DO UPDATE SET
           call_sign = excluded.call_sign,
           display_name = excluded.display_name,
           bio = excluded.bio,
           avatar_url = excluded.avatar_url,
           style_prompt = excluded.style_prompt,
           taste_loves = excluded.taste_loves,
           taste_hates = excluded.taste_hates,
           cadence_tick_every_sec = excluded.cadence_tick_every_sec,
           cadence_active_start = excluded.cadence_active_start,
           cadence_active_end = excluded.cadence_active_end,
           appetite_remix_prob = excluded.appetite_remix_prob,
           appetite_react_prob = excluded.appetite_react_prob,
           appetite_murmur_prob = excluded.appetite_murmur_prob,
           affinities_json = excluded.affinities_json,
           budget_daily_usd_cap = excluded.budget_daily_usd_cap,
           budget_daily_token_cap = excluded.budget_daily_token_cap,
           nostr_sk = excluded.nostr_sk,
           journal_enabled = excluded.journal_enabled,
           apoc_agent_id = excluded.apoc_agent_id,
           updated_at = datetime('now')`,
      )
      .run({
        id,
        callSign: p.callSign,
        displayName: p.displayName,
        bio: p.bio,
        avatarUrl: p.avatarUrl,
        stylePrompt: p.stylePrompt,
        tasteLoves: p.taste.loves,
        tasteHates: p.taste.hates,
        tickEverySec: p.cadence.tickEverySec,
        activeStart: p.cadence.activeStart,
        activeEnd: p.cadence.activeEnd,
        remixProb: p.appetite.remixProb,
        reactProb: p.appetite.reactProb,
        murmurProb: p.appetite.murmurProb,
        affinitiesJson: JSON.stringify(p.affinities),
        dailyUsdCap: p.budget.dailyUsdCap,
        dailyTokenCap: p.budget.dailyTokenCap,
        nostrSk: p.nostrSk,
        journalEnabled: p.journalEnabled ? 1 : 0,
        apocAgentId: p.apocAgentId,
      })
    return id
  }

  upsertDriver(personaId: string, d: DriverRow): void {
    this.db
      .prepare(
        `INSERT INTO persona_drivers (persona_id, role, provider, model, temperature, max_tokens)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(persona_id, role) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           temperature = excluded.temperature,
           max_tokens = excluded.max_tokens`,
      )
      .run(personaId, d.role, d.provider, d.model, d.temperature, d.maxTokens)
  }

  deleteDriver(personaId: string, role: DriverRole): void {
    this.db.prepare("DELETE FROM persona_drivers WHERE persona_id = ? AND role = ?").run(personaId, role)
  }

  getPersona(callSign: string): PersonaWithDrivers | null {
    const row = this.db
      .prepare("SELECT * FROM personas WHERE call_sign = ?")
      .get(callSign) as PersonaDbRow | undefined
    if (!row) return null
    const drivers = this.db
      .prepare("SELECT * FROM persona_drivers WHERE persona_id = ?")
      .all(row.id) as DriverDbRow[]
    return { ...rowToPersona(row), drivers: driversMap(drivers) }
  }

  listPersonas(): PersonaWithDrivers[] {
    const rows = this.db
      .prepare("SELECT * FROM personas ORDER BY created_at DESC")
      .all() as PersonaDbRow[]
    return rows.map((row) => {
      const drivers = this.db
        .prepare("SELECT * FROM persona_drivers WHERE persona_id = ?")
        .all(row.id) as DriverDbRow[]
      return { ...rowToPersona(row), drivers: driversMap(drivers) }
    })
  }

  deletePersona(callSign: string): void {
    this.db.prepare("DELETE FROM personas WHERE call_sign = ?").run(callSign)
  }

  setPersonaApocAgentId(personaId: string, apocAgentId: string): void {
    this.db
      .prepare(
        "UPDATE personas SET apoc_agent_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(apocAgentId, personaId)
  }

  setPersonaNostrSk(personaId: string, nostrSk: string): void {
    this.db
      .prepare(
        "UPDATE personas SET nostr_sk = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(nostrSk, personaId)
  }

  // ─── Stems ─────────────────────────────────────────────────────

  insertStem(s: Omit<StemRow, "id" | "createdAt"> & { id?: string }): StemRow {
    const id = s.id ?? randomUUID()
    this.db
      .prepare(
        `INSERT INTO stems (
           id, persona_id, parent_stem_id, parent_apoc_stem_id, title,
           plan, spec_json, code, error,
           plan_model, plan_cost_usd, compose_model, compose_cost_usd,
           apoc_stem_id, published_at
         ) VALUES (
           @id, @personaId, @parentStemId, @parentApocStemId, @title,
           @plan, @specJson, @code, @error,
           @planModel, @planCostUsd, @composeModel, @composeCostUsd,
           @apocStemId, @publishedAt
         )`,
      )
      .run({ ...s, id })
    return this.getStem(id)!
  }

  getStem(id: string): StemRow | null {
    const row = this.db.prepare("SELECT * FROM stems WHERE id = ?").get(id) as
      | StemDbRow
      | undefined
    return row ? rowToStem(row) : null
  }

  listStemsByPersona(callSign: string, limit = 50): StemRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM stems s
         JOIN personas p ON p.id = s.persona_id
         WHERE p.call_sign = ?
         ORDER BY s.created_at DESC
         LIMIT ?`,
      )
      .all(callSign, limit) as StemDbRow[]
    return rows.map(rowToStem)
  }

  markStemPublished(id: string, apocStemId: string): void {
    this.db
      .prepare("UPDATE stems SET apoc_stem_id = ?, published_at = datetime('now') WHERE id = ?")
      .run(apocStemId, id)
  }

  // ─── Preferences ───────────────────────────────────────────────

  insertPreference(p: Omit<PreferenceRow, "id" | "createdAt"> & { id?: string }): PreferenceRow {
    const id = p.id ?? randomUUID()
    this.db
      .prepare(
        `INSERT INTO preferences (
           id, persona_id, stem_a_id, stem_b_id, preferred, reasoning, judge_model, cost_usd
         ) VALUES (
           @id, @personaId, @stemAId, @stemBId, @preferred, @reasoning, @judgeModel, @costUsd
         )`,
      )
      .run({ ...p, id })
    return this.getPreference(id)!
  }

  getPreference(id: string): PreferenceRow | null {
    const row = this.db.prepare("SELECT * FROM preferences WHERE id = ?").get(id) as
      | PreferenceDbRow
      | undefined
    return row ? rowToPreference(row) : null
  }

  listPreferencesByPersona(callSign: string, limit = 100): PreferenceRow[] {
    const rows = this.db
      .prepare(
        `SELECT pr.* FROM preferences pr
         JOIN personas p ON p.id = pr.persona_id
         WHERE p.call_sign = ?
         ORDER BY pr.created_at DESC
         LIMIT ?`,
      )
      .all(callSign, limit) as PreferenceDbRow[]
    return rows.map(rowToPreference)
  }

  // ─── Murmurs ───────────────────────────────────────────────────

  insertMurmur(m: Omit<MurmurRow, "id" | "createdAt"> & { id?: string }): MurmurRow {
    const id = m.id ?? randomUUID()
    this.db
      .prepare(
        `INSERT INTO murmurs (
           id, persona_id, content, subject_stem_id, pair_a_id, pair_b_id,
           preference_id, murmur_model, cost_usd, nostr_event_id, published_at
         ) VALUES (
           @id, @personaId, @content, @subjectStemId, @pairAId, @pairBId,
           @preferenceId, @murmurModel, @costUsd, @nostrEventId, @publishedAt
         )`,
      )
      .run({ ...m, id })
    return this.getMurmur(id)!
  }

  getMurmur(id: string): MurmurRow | null {
    const row = this.db.prepare("SELECT * FROM murmurs WHERE id = ?").get(id) as
      | MurmurDbRow
      | undefined
    return row ? rowToMurmur(row) : null
  }

  listMurmursByPersona(callSign: string, limit = 50): MurmurRow[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM murmurs m
         JOIN personas p ON p.id = m.persona_id
         WHERE p.call_sign = ?
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(callSign, limit) as MurmurDbRow[]
    return rows.map(rowToMurmur)
  }

  markMurmurPublished(id: string, nostrEventId: string): void {
    this.db
      .prepare("UPDATE murmurs SET nostr_event_id = ?, published_at = datetime('now') WHERE id = ?")
      .run(nostrEventId, id)
  }
}

// ─── DB row shapes + mappers ─────────────────────────────────────

type PersonaDbRow = {
  id: string
  call_sign: string
  display_name: string
  bio: string | null
  avatar_url: string | null
  style_prompt: string
  taste_loves: string
  taste_hates: string
  cadence_tick_every_sec: number
  cadence_active_start: number | null
  cadence_active_end: number | null
  appetite_remix_prob: number
  appetite_react_prob: number
  appetite_murmur_prob: number
  affinities_json: string
  budget_daily_usd_cap: number | null
  budget_daily_token_cap: number | null
  nostr_sk: string | null
  journal_enabled: number
  apoc_agent_id: string | null
  created_at: string
  updated_at: string
}

type DriverDbRow = {
  role: DriverRole
  provider: string
  model: string
  temperature: number | null
  max_tokens: number | null
}

type StemDbRow = {
  id: string
  persona_id: string
  parent_stem_id: string | null
  parent_apoc_stem_id: string | null
  title: string | null
  plan: string | null
  spec_json: string | null
  code: string | null
  error: string | null
  plan_model: string | null
  plan_cost_usd: number | null
  compose_model: string | null
  compose_cost_usd: number | null
  apoc_stem_id: string | null
  published_at: string | null
  created_at: string
}

type PreferenceDbRow = {
  id: string
  persona_id: string
  stem_a_id: string
  stem_b_id: string
  preferred: "a" | "b" | "tie"
  reasoning: string | null
  judge_model: string | null
  cost_usd: number | null
  created_at: string
}

type MurmurDbRow = {
  id: string
  persona_id: string
  content: string
  subject_stem_id: string | null
  pair_a_id: string | null
  pair_b_id: string | null
  preference_id: string | null
  murmur_model: string | null
  cost_usd: number | null
  nostr_event_id: string | null
  published_at: string | null
  created_at: string
}

function rowToPersona(r: PersonaDbRow): PersonaRow {
  return {
    id: r.id,
    callSign: r.call_sign,
    displayName: r.display_name,
    bio: r.bio,
    avatarUrl: r.avatar_url,
    stylePrompt: r.style_prompt,
    taste: { loves: r.taste_loves, hates: r.taste_hates },
    cadence: {
      tickEverySec: r.cadence_tick_every_sec,
      activeStart: r.cadence_active_start,
      activeEnd: r.cadence_active_end,
    },
    appetite: {
      remixProb: r.appetite_remix_prob,
      reactProb: r.appetite_react_prob,
      murmurProb: r.appetite_murmur_prob,
    },
    affinities: safeJsonArray(r.affinities_json),
    budget: { dailyUsdCap: r.budget_daily_usd_cap, dailyTokenCap: r.budget_daily_token_cap },
    nostrSk: r.nostr_sk,
    journalEnabled: !!r.journal_enabled,
    apocAgentId: r.apoc_agent_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function driversMap(rows: DriverDbRow[]): Record<DriverRole, DriverRow | null> {
  const out: Record<DriverRole, DriverRow | null> = {
    plan: null, plan_cleanup: null, compose: null, judge: null, murmur: null,
  }
  for (const r of rows) {
    out[r.role] = {
      role: r.role,
      provider: r.provider,
      model: r.model,
      temperature: r.temperature,
      maxTokens: r.max_tokens,
    }
  }
  return out
}

function rowToStem(r: StemDbRow): StemRow {
  return {
    id: r.id,
    personaId: r.persona_id,
    parentStemId: r.parent_stem_id,
    parentApocStemId: r.parent_apoc_stem_id,
    title: r.title,
    plan: r.plan,
    specJson: r.spec_json,
    code: r.code,
    error: r.error,
    planModel: r.plan_model,
    planCostUsd: r.plan_cost_usd,
    composeModel: r.compose_model,
    composeCostUsd: r.compose_cost_usd,
    apocStemId: r.apoc_stem_id,
    publishedAt: r.published_at,
    createdAt: r.created_at,
  }
}

function rowToPreference(r: PreferenceDbRow): PreferenceRow {
  return {
    id: r.id,
    personaId: r.persona_id,
    stemAId: r.stem_a_id,
    stemBId: r.stem_b_id,
    preferred: r.preferred,
    reasoning: r.reasoning,
    judgeModel: r.judge_model,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
  }
}

function rowToMurmur(r: MurmurDbRow): MurmurRow {
  return {
    id: r.id,
    personaId: r.persona_id,
    content: r.content,
    subjectStemId: r.subject_stem_id,
    pairAId: r.pair_a_id,
    pairBId: r.pair_b_id,
    preferenceId: r.preference_id,
    murmurModel: r.murmur_model,
    costUsd: r.cost_usd,
    nostrEventId: r.nostr_event_id,
    publishedAt: r.published_at,
    createdAt: r.created_at,
  }
}

function safeJsonArray(s: string): string[] {
  try {
    const arr = JSON.parse(s)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []
  } catch {
    return []
  }
}
