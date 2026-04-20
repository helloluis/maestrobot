import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Maestrodb } from "@maestrobot/db"
import { upsertFromJson, type JsonPersonaFile } from "@maestrobot/agent"

async function main(): Promise<void> {
  const [file] = process.argv.slice(2)
  if (!file) {
    console.error("usage: pnpm persona:import <path/to/agent.json>")
    process.exit(1)
  }
  const dbPath = process.env.MAESTROBOT_DB_PATH ?? "./maestrobot.db"
  const db = new Maestrodb(dbPath)
  const json = JSON.parse(await readFile(resolve(file), "utf8")) as JsonPersonaFile
  const { personaId } = upsertFromJson(db, json)
  db.close()
  console.log(`[maestrobot] upserted ${json.persona.callSign} (${personaId}) into ${dbPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
