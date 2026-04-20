import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { ProviderRegistry } from "@maestrobot/providers"
import {
  ApocClient,
  Journal,
  MusicianAgent,
  dbToConfig,
  upsertFromJson,
  type AgentConfig,
  type JsonPersonaFile,
} from "@maestrobot/agent"
import { Maestrodb } from "@maestrobot/db"

async function loadDotenv(path = ".env"): Promise<void> {
  try {
    const raw = await readFile(path, "utf8")
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      const [, k, v] = m
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "")
    }
  } catch {}
}

function usage(): never {
  console.error("usage: pnpm agent:run <callSign | path/to/agent.json> [--dry-run] [--once]")
  process.exit(1)
}

// Resolve either a callSign (load from DB) or a JSON file (upsert + load).
async function resolvePersona(
  db: Maestrodb,
  arg: string,
): Promise<{ personaId: string; config: AgentConfig; source: "db" | "json" }> {
  const looksLikeFile = arg.endsWith(".json") || existsSync(resolve(arg))
  if (looksLikeFile) {
    const json = JSON.parse(await readFile(resolve(arg), "utf8")) as JsonPersonaFile
    const { personaId, config } = upsertFromJson(db, json)
    return { personaId, config, source: "json" }
  }
  const row = db.getPersona(arg)
  if (!row) {
    console.error(`no persona with callSign '${arg}' in DB — import a JSON file first, or pass one.`)
    process.exit(1)
  }
  return { personaId: row.id, config: dbToConfig(row), source: "db" }
}

async function main(): Promise<void> {
  const [arg, ...flags] = process.argv.slice(2)
  if (!arg) usage()

  await loadDotenv()

  const dryRun = flags.includes("--dry-run")
  const once = flags.includes("--once") || dryRun

  const dbPath = process.env.MAESTROBOT_DB_PATH ?? "./maestrobot.db"
  const db = new Maestrodb(dbPath)

  const { personaId, config, source } = await resolvePersona(db, arg)
  console.log(
    `[maestrobot] persona: ${config.persona.displayName} (loaded from ${source}, db=${dbPath})`,
  )

  const registry = new ProviderRegistry()
  console.log(
    `[maestrobot] providers available: ${registry.available().join(", ") || "(none — set keys in .env)"}`,
  )

  const apoc = new ApocClient(
    process.env.APOC_API_URL ?? "https://apoc-api-production.up.railway.app",
  )
  const journalDir = process.env.MAESTROBOT_JOURNAL_DIR ?? "./journal"
  const journal = config.journal === false ? undefined : new Journal(journalDir, config.persona.callSign)

  const agent = new MusicianAgent(config, { registry, apoc, journal, db, personaId })

  if (dryRun) {
    console.log(`[maestrobot] ${config.persona.displayName} dry run — composing one stem…`)
    const r = await agent.compose()
    console.log(`\nmodel: ${r.model}   cost: $${r.costUsd.toFixed(5)}`)
    if (r.plan) console.log(`\nplan:\n${r.plan}\n`)
    if (r.error) console.log(`error: ${r.error}`)
    console.log(`code:\n${r.code ?? "(empty)"}\n`)
    console.log(`[db] stem row written to ${dbPath}`)
    db.close()
    return
  }

  const tickSec = config.cadence.tickEverySec
  console.log(`[maestrobot] ${config.persona.displayName} live — tick every ${tickSec}s`)
  let running = true
  process.on("SIGINT", () => {
    console.log("\n[maestrobot] shutting down…")
    running = false
  })

  while (running) {
    try {
      const { actions, costUsd } = await agent.tick()
      console.log(
        `[tick ${new Date().toISOString()}] ${actions.length ? actions.join(" · ") : "(idle)"} — $${costUsd.toFixed(5)}`,
      )
    } catch (e) {
      console.error(`[tick error]`, (e as Error).message)
      await journal?.write({
        agent: config.persona.callSign,
        event: "error",
        data: { message: (e as Error).message },
      })
    }
    if (once) break
    await new Promise((r) => setTimeout(r, tickSec * 1000))
  }
  db.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
