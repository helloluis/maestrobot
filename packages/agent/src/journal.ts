import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export interface JournalEntry {
  ts: string
  agent: string
  event:
    | "compose"
    | "judge"
    | "murmur"
    | "remix"
    | "listen"
    | "skip"
    | "error"
    | "budget"
  // Free-form payload — we intentionally don't enforce shape per event so
  // the journal stays cheap to extend. Downstream (Bradley-Terry, cost
  // rollups) reads what it needs.
  data: Record<string, unknown>
}

export class Journal {
  private path: string
  private ensured = false

  constructor(dir: string, agentCallSign: string) {
    this.path = `${dir.replace(/\/$/, "")}/${agentCallSign}.ndjson`
  }

  async write(entry: Omit<JournalEntry, "ts">): Promise<void> {
    if (!this.ensured) {
      await mkdir(dirname(this.path), { recursive: true }).catch(() => {})
      this.ensured = true
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
    await appendFile(this.path, line, "utf8")
  }
}
