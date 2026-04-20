import { existsSync, readdirSync, copyFileSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Maestrodb } from "@maestrobot/db"
import { upsertFromJson, type JsonPersonaFile } from "@maestrobot/agent"

// First-run bootstrap. Idempotent — safe to re-run.
//   1. Copy .env.example → .env if .env is missing.
//   2. Import every agents/*.json persona into the SQLite DB.
//
// Does NOT fetch the sample banks (~1 GB). Run `pnpm samples:fetch`
// separately if you intend to use the studio.

function loadDotenv(envPath: string): void {
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    if (!process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "")
  }
}

function step(n: number, msg: string): void {
  console.log(`[setup] ${n}. ${msg}`)
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolve(here, "..")

  // 1. .env
  const envPath = resolve(root, ".env")
  const envExamplePath = resolve(root, ".env.example")
  if (existsSync(envPath)) {
    step(1, ".env already exists — leaving it alone")
  } else if (existsSync(envExamplePath)) {
    copyFileSync(envExamplePath, envPath)
    step(1, `copied .env.example → .env. Edit it to add provider API keys.`)
  } else {
    step(1, "no .env.example found — skipping")
  }

  // Load .env now so MAESTROBOT_DB_PATH is honoured.
  loadDotenv(envPath)

  // 2. Seed personas from agents/*.json
  const agentsDir = resolve(root, "agents")
  if (!existsSync(agentsDir)) {
    step(2, "no agents/ directory — skipping persona import")
    return
  }
  const jsonFiles = readdirSync(agentsDir).filter((f) => f.endsWith(".json"))
  if (jsonFiles.length === 0) {
    step(2, "agents/ has no .json files — skipping persona import")
    return
  }

  const dbPath = process.env.MAESTROBOT_DB_PATH
    ? resolve(root, process.env.MAESTROBOT_DB_PATH)
    : resolve(root, "./maestrobot.db")
  step(2, `importing ${jsonFiles.length} persona(s) into ${dbPath}`)

  const db = new Maestrodb(dbPath)
  let ok = 0
  let failed = 0
  for (const f of jsonFiles) {
    try {
      const json = JSON.parse(readFileSync(resolve(agentsDir, f), "utf8")) as JsonPersonaFile
      const { personaId } = upsertFromJson(db, json)
      console.log(`  ${json.persona.callSign} → ${personaId.slice(0, 8)}…`)
      ok++
    } catch (e) {
      console.error(`  ${f}: FAILED — ${(e as Error).message}`)
      failed++
    }
  }
  db.close()
  console.log(`[setup] done. imported=${ok} failed=${failed}`)
}

main()
