import { readFile } from "node:fs/promises"
import { ProviderRegistry } from "@maestrobot/providers"
import { ApocClient, MusicianAgent, dbToConfig } from "@maestrobot/agent"
import { Maestrodb } from "@maestrobot/db"

// Retroactively runs the planCleanup driver on stored plans. Targets:
//   pnpm plan:cleanup <stemId>        — one stem
//   pnpm plan:cleanup --persona <cs>  — all stems for a callSign
//   pnpm plan:cleanup --all           — every stem with a non-null plan
// Use --dry-run (default off for this script) to preview without writing.

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
  console.error(`usage:
  pnpm plan:cleanup <stemId>              — clean one stem
  pnpm plan:cleanup --persona <callSign>  — clean all stems for a persona
  pnpm plan:cleanup --all                 — clean every stem with a plan
  flags: --dry-run to preview without writing
`)
  process.exit(1)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 0) usage()
  const dryRun = args.includes("--dry-run")

  await loadDotenv()

  const dbPath = process.env.MAESTROBOT_DB_PATH ?? "./maestrobot.db"
  const db = new Maestrodb(dbPath)
  const registry = new ProviderRegistry()
  const apoc = new ApocClient(
    process.env.APOC_API_URL ?? "https://apoc-api-production.up.railway.app",
  )

  // Collect target stem ids based on flags.
  const personaFlag = args.indexOf("--persona")
  const personaCallSign = personaFlag >= 0 ? args[personaFlag + 1] : undefined
  const all = args.includes("--all")
  const stemIdArg = args.find((a) => !a.startsWith("--") && a !== personaCallSign)

  let stemIds: string[] = []
  if (stemIdArg) stemIds = [stemIdArg]
  else if (personaCallSign) {
    const rows = db.listStemsByPersona(personaCallSign, 1000)
    stemIds = rows.filter((s) => s.plan).map((s) => s.id)
  } else if (all) {
    const rows = db.db
      .prepare("SELECT id FROM stems WHERE plan IS NOT NULL ORDER BY created_at DESC")
      .all() as Array<{ id: string }>
    stemIds = rows.map((r) => r.id)
  } else {
    usage()
  }

  console.log(`[plan:cleanup] targets: ${stemIds.length} stem(s)`)
  console.log(`[plan:cleanup] mode:    ${dryRun ? "DRY-RUN" : "WRITE"}`)
  console.log()

  let cleaned = 0
  let skipped = 0
  let failed = 0
  let totalCost = 0

  for (const stemId of stemIds) {
    const stem = db.getStem(stemId)
    if (!stem) {
      console.log(`  ${stemId}: not found`)
      skipped++
      continue
    }
    if (!stem.plan) {
      console.log(`  ${stemId}: no plan, skipped`)
      skipped++
      continue
    }
    const persona = db.listPersonas().find((p) => p.id === stem.personaId)
    if (!persona) {
      console.log(`  ${stemId}: persona not found`)
      skipped++
      continue
    }
    const config = dbToConfig(persona)
    const cleanupDriver = config.drivers.planCleanup
    if (!cleanupDriver) {
      console.log(`  ${stemId}: persona ${persona.callSign} has no planCleanup driver, skipped`)
      skipped++
      continue
    }
    const agent = new MusicianAgent(config, { registry, apoc, db, personaId: persona.id })
    const before = stem.plan.length
    const result = await agent.cleanupPlan(cleanupDriver, stem.plan).catch((e) => ({
      text: null,
      model: cleanupDriver.model,
      costUsd: 0,
      error: (e as Error).message,
    }))
    if (!result.text) {
      console.log(`  ${stemId}: cleanup returned empty, skipped`)
      failed++
      continue
    }
    totalCost += result.costUsd
    const after = result.text.length
    console.log(
      `  ${stemId} [${persona.callSign}]: ${before} → ${after} chars · $${result.costUsd.toFixed(5)}`,
    )
    console.log(`    ${result.text.slice(0, 200)}${result.text.length > 200 ? "…" : ""}`)
    if (!dryRun) {
      db.db
        .prepare("UPDATE stems SET plan = ? WHERE id = ?")
        .run(result.text, stem.id)
    }
    cleaned++
  }

  console.log()
  console.log(
    `[plan:cleanup] done. cleaned=${cleaned} skipped=${skipped} failed=${failed} total=$${totalCost.toFixed(5)}`,
  )
  if (dryRun) console.log(`[plan:cleanup] re-run without --dry-run to apply.`)
  db.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
