import { readFile } from "node:fs/promises"
import { ProviderRegistry } from "@maestrobot/providers"
import { ApocClient, MusicianAgent, dbToConfig } from "@maestrobot/agent"
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
  console.error(`usage: pnpm stem:publish <stemId> [--live]

  Publishes a locally-composed stem to world.apocalypseradio.xyz.
  Default mode is DRY-RUN — prints the exact payloads that would be
  sent without hitting the live API.

  Pass --live to actually register the persona (if unregistered) and
  commit the stem. Both actions are public and mostly-irreversible:
  registration publishes a Nostr kind-0 profile and triggers an
  Administrator welcome mention.

  Find stem ids in ./maestrobot.db (stems.id) or in the studio UI.
`)
  process.exit(1)
}

async function main(): Promise<void> {
  const [stemId, ...flags] = process.argv.slice(2)
  if (!stemId) usage()

  await loadDotenv()

  const dryRun = !flags.includes("--live")
  const dbPath = process.env.MAESTROBOT_DB_PATH ?? "./maestrobot.db"
  const db = new Maestrodb(dbPath)

  const stem = db.getStem(stemId)
  if (!stem) {
    console.error(`[publish] no stem with id ${stemId}`)
    process.exit(1)
  }
  const persona = db.listPersonas().find((p) => p.id === stem.personaId)
  if (!persona) {
    console.error(`[publish] stem's persona not in DB`)
    process.exit(1)
  }

  console.log(`[publish] persona: ${persona.displayName} (${persona.callSign})`)
  console.log(`[publish] stem:    ${stem.title ?? "(untitled)"} — ${stem.id}`)
  console.log(`[publish] mode:    ${dryRun ? "DRY-RUN (safe)" : "LIVE (will hit production)"}`)
  console.log()

  const registry = new ProviderRegistry()
  const apoc = new ApocClient(
    process.env.APOC_API_URL ?? "https://apoc-api-production.up.railway.app",
  )
  const agent = new MusicianAgent(dbToConfig(persona), {
    registry,
    apoc,
    db,
    personaId: persona.id,
  })

  try {
    const result = await agent.publishStem(stem.id, { dryRun })
    console.log(`[publish] result: ${result.status}`)
    if (result.reason) console.log(`[publish] reason: ${result.reason}`)
    if (result.apocAgentId) console.log(`[publish] apoc agent id: ${result.apocAgentId}`)
    if (result.apocStemId) console.log(`[publish] apoc stem id:  ${result.apocStemId}`)
    if (result.payloads) {
      console.log()
      console.log(`[publish] payloads that would be sent:`)
      if (result.payloads.register) {
        console.log("\n  POST /agents ─────────────────────────────")
        console.log(JSON.stringify(result.payloads.register, null, 2))
      } else {
        console.log("\n  POST /agents — skipped (persona already registered)")
      }
      if (result.payloads.profileEvent) {
        console.log("\n  kind-0 profile event → relay.apocalypseradio.xyz ─")
        console.log(JSON.stringify(result.payloads.profileEvent, null, 2))
      }
      if (result.payloads.profilePublishResults) {
        console.log("\n  relay publish results ────────────────────")
        for (const r of result.payloads.profilePublishResults) {
          console.log(`    ${r.relay}: ${r.ok ? "OK" : `FAIL — ${r.error}`}`)
        }
      }
      console.log("\n  POST /stems ──────────────────────────────")
      console.log(JSON.stringify(result.payloads.commit, null, 2))
    }
    if (dryRun) {
      console.log()
      console.log(`[publish] dry-run complete. re-run with --live to actually publish.`)
    }
  } catch (e) {
    console.error(`[publish] error:`, (e as Error).message)
    process.exit(1)
  } finally {
    db.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
