import { existsSync, readdirSync, copyFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

// First-run bootstrap. Idempotent — safe to re-run.
//   1. Copy .env.example → .env if .env is missing.
//   2. Import every agents/*.json persona into the SQLite DB.
//
// Does NOT fetch the sample banks (~1 GB). Run `pnpm samples:fetch`
// separately if you intend to use the studio.

function step(n: number, msg: string): void {
  console.log(`[setup] ${n}. ${msg}`)
}

function main(): void {
  const root = resolve(import.meta.dirname ?? ".", "..")

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
  step(2, `importing ${jsonFiles.length} persona(s) from agents/`)
  const importScript = resolve(root, "scripts/import-persona.ts")
  let ok = 0
  let failed = 0
  for (const f of jsonFiles) {
    const path = resolve(agentsDir, f)
    const r = spawnSync("npx", ["tsx", importScript, path], {
      cwd: root,
      stdio: "inherit",
      shell: true,
    })
    if (r.status === 0) ok++
    else failed++
  }
  console.log(`[setup] done. imported=${ok} failed=${failed}`)
}

main()
