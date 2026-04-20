import type { ApocAgent, Stem } from "./types.js"

export class ApocClient {
  constructor(private baseUrl: string) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`apoc ${init.method ?? "GET"} ${path} ${res.status}: ${body.slice(0, 200)}`)
    }
    return res.json() as Promise<T>
  }

  listStems(limit = 60): Promise<Stem[]> {
    return this.req<Stem[]>(`/stems?limit=${limit}`)
  }

  getStem(id: string): Promise<Stem> {
    return this.req<Stem>(`/stems/${id}`)
  }

  listAgents(): Promise<ApocAgent[]> {
    return this.req<ApocAgent[]>(`/agents`)
  }

  getAgent(key: string): Promise<ApocAgent | null> {
    return this.req<ApocAgent>(`/agents/${encodeURIComponent(key)}`).catch(() => null)
  }

  // Register a new agent on apoc-radio. Payload shape is Nostr-flavoured
  // (name / about / picture / style_prompt) because the server maps those
  // onto its internal model + publishes a kind-0 Nostr profile on create.
  //
  // When `nostrPubkey` is supplied, apoc runs caller-custody mode —
  // stores only the pubkey, skips the server-side kind-0 publish, and
  // leaves `nostrPrivkey` null. Requires the server-side change from
  // PR apoc-radio-v2#feat/accept-external-nostr-pubkey (2026-04-20).
  registerAgent(input: {
    callSign: string
    stylePrompt: string
    bio?: string
    avatarUrl?: string
    bannerUrl?: string
    website?: string
    kind?: "HOUSE" | "SUMMONED"
    nostrPubkey?: string
  }): Promise<ApocAgent> {
    return this.req<ApocAgent>(`/agents`, {
      method: "POST",
      body: JSON.stringify({
        name: input.callSign,
        style_prompt: input.stylePrompt,
        about: input.bio ?? undefined,
        picture: input.avatarUrl ?? undefined,
        banner: input.bannerUrl ?? undefined,
        website: input.website ?? undefined,
        kind: input.kind ?? "SUMMONED",
        nostr_pubkey: input.nostrPubkey ?? undefined,
      }),
    })
  }

  // Server-side generation path. Hands model choice back to the server.
  // Maestrobot uses this only as a diagnostic; regular publishing should
  // call commitStem() with locally-emitted code instead.
  generateStem(
    agentId: string,
    opts: { remixOfId?: string } = {},
  ): Promise<Stem> {
    return this.req<Stem>(`/agents/${agentId}/generate-stem`, {
      method: "POST",
      body: JSON.stringify(opts),
    })
  }

  // Commit a pre-generated Strudel pattern as a READY track. This is the
  // canonical maestrobot path — we own model selection, emit locally,
  // and only ship the finished pattern + metadata up to apoc.
  commitStem(input: {
    agentId: string
    code: string
    title?: string
    plan?: string
    modelUsed?: string
    remixOfId?: string
  }): Promise<Stem> {
    return this.req<Stem>(`/stems`, {
      method: "POST",
      body: JSON.stringify({
        agentId: input.agentId,
        code: input.code,
        title: input.title ?? null,
        plan: input.plan ?? null,
        modelUsed: input.modelUsed ?? null,
        remixOfId: input.remixOfId ?? null,
      }),
    })
  }
}
