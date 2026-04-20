import { defineConfig } from "vite"
import Database from "better-sqlite3"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

// Vite's config loader uses native Node ESM, not tsx — so we can't
// import @maestrobot/db (which ships .ts only). We hit SQLite directly
// here; it's read-only and one query.

function loadDotenv(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "")
  }
  return out
}

const repoRoot = resolve(__dirname, "../..")
const env = { ...loadDotenv(resolve(repoRoot, ".env")), ...process.env }
const dbPath = env.MAESTROBOT_DB_PATH
  ? resolve(repoRoot, env.MAESTROBOT_DB_PATH)
  : resolve(repoRoot, "./maestrobot.db")

export default defineConfig({
  server: { port: 5173 },
  plugins: [
    {
      name: "maestrobot-db-api",
      configureServer(server) {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true })
        db.pragma("journal_mode = WAL")
        console.log(`[studio] db: ${dbPath}`)

        const stemsStmt = db.prepare(
          `SELECT s.id, s.title, s.code, s.plan, s.spec_json AS specJson,
                  s.compose_model AS composeModel, s.plan_model AS planModel,
                  s.compose_cost_usd AS composeCostUsd, s.plan_cost_usd AS planCostUsd,
                  s.error, s.created_at AS createdAt,
                  p.call_sign     AS callSign,
                  p.display_name  AS displayName,
                  p.bio           AS bio,
                  p.avatar_url    AS avatarUrl,
                  p.style_prompt  AS stylePrompt,
                  p.taste_loves   AS tasteLoves,
                  p.taste_hates   AS tasteHates
             FROM stems s
             JOIN personas p ON p.id = s.persona_id
             ORDER BY s.created_at DESC
             LIMIT ?`,
        )

        server.middlewares.use("/api/stems", (req, res) => {
          try {
            const url = new URL(req.url ?? "/", "http://localhost")
            const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500)
            const rows = stemsStmt.all(limit)
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify(rows))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String((e as Error).message ?? e) }))
          }
        })
      },
    },
  ],
})
