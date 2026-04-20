import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  LLMProvider,
  ProviderRegistry,
} from "@maestrobot/providers"
import type { Maestrodb } from "@maestrobot/db"
import type { ApocClient } from "./apoc-client.js"
import type { Journal } from "./journal.js"
import {
  NostrClient,
  generateKeypair,
  pubkeyFromPrivkey,
  type ProfileMetadata,
  type PublishResult,
  type SignedEvent,
} from "./nostr-client.js"
import {
  GENERATE_STEM_TOOL,
  InvalidStemError,
  emitStrudel,
  validateSpec,
  type StemSpec,
} from "./stem-schema.js"
import { CAST_PREFERENCE_TOOL, parsePreference } from "./preference-schema.js"
import type {
  AgentConfig,
  AgentDriver,
  PairwisePreference,
  Stem,
} from "./types.js"

export interface AgentDeps {
  registry: ProviderRegistry
  apoc: ApocClient
  journal?: Journal
  db?: Maestrodb
  // DB id for this persona — present when agent was loaded from DB.
  // When present, compose/judge/murmur write structured rows.
  personaId?: string
}

export interface ComposeResult {
  code: string | null
  plan: string | null
  spec: StemSpec | null
  model: string
  costUsd: number
  error?: string
}

export class MusicianAgent {
  constructor(public config: AgentConfig, private deps: AgentDeps) {}

  private provider(driver: AgentDriver): LLMProvider {
    return this.deps.registry.get(driver.provider)
  }

  private async chat(
    driver: AgentDriver,
    messages: ChatMessage[],
    extra: Partial<CompleteOptions> = {},
  ): Promise<CompleteResult> {
    return this.provider(driver).complete(messages, {
      model: driver.model,
      temperature: driver.temperature,
      maxTokens: driver.maxTokens,
      ...extra,
    })
  }

  // Compose uses the generate_stem tool — always. Optional text plan
  // stage runs first if drivers.plan is configured.
  async compose(parentCode?: string): Promise<ComposeResult> {
    let costUsd = 0
    let plan: string | null = null
    const planDriver = this.config.drivers.plan
    if (planDriver) {
      const planMessages: ChatMessage[] = [
        { role: "system", content: this.config.stylePrompt },
        {
          role: "user",
          content: parentCode
            ? [
                `A listener asked you to REMIX this pattern in your style:`,
                "",
                parentCode,
                "",
                "Describe in 2-3 sentences what your remix should feel like: mood/texture, 2-4 concrete sounds, bpm. Prose only. No code.",
              ].join("\n")
            : [
                `A listener asked you for a fresh short stem.`,
                "Describe in 2-3 sentences what it should feel like: mood/texture, 2-4 concrete sounds, bpm. Prose only. No code.",
              ].join("\n"),
        },
      ]
      const planRes = await this.chat(
        { ...planDriver, temperature: planDriver.temperature ?? 0.9, maxTokens: planDriver.maxTokens ?? 512 },
        planMessages,
      )
      plan = planRes.content.trim()
      costUsd += planRes.usage?.costUsd ?? 0

      // Polish pass — if configured, distil the raw plan. Pairs with
      // reasoning planners whose output contains chain-of-thought.
      const cleanupDriver = this.config.drivers.planCleanup
      if (cleanupDriver && plan) {
        const cleaned = await this.cleanupPlan(cleanupDriver, plan)
        if (cleaned.text) plan = cleaned.text
        costUsd += cleaned.costUsd
      }
    }

    const composeDriver = this.config.drivers.compose
    const composeSystem = [
      `You are ${this.config.persona.displayName}. ${this.config.persona.bio}`,
      "",
      this.config.stylePrompt,
      "",
      "You compose music by CALLING the generate_stem function. Your musical taste is expressed through the argument values you choose — voice kinds, patterns, synths, banks, effect amounts, tempo. Do not write prose. Do not explain. Call the function.",
      ...(plan ? ["", "# Plan to realise", plan] : []),
    ].join("\n")
    const composeUser = parentCode
      ? `Call generate_stem to REMIX this parent pattern in your style. Do not copy it — transform it.\n\n# Parent\n${parentCode}`
      : `Call generate_stem to compose a fresh short stem in your style.`

    const res = await this.chat(composeDriver, [
      { role: "system", content: composeSystem },
      { role: "user", content: composeUser },
    ], {
      tools: [GENERATE_STEM_TOOL],
      toolChoice: { type: "function", function: { name: "generate_stem" } },
    })
    costUsd += res.usage?.costUsd ?? 0

    const call = res.toolCalls?.find((c) => c.name === "generate_stem")
    const planCost = costUsd - (res.usage?.costUsd ?? 0)
    const composeCost = res.usage?.costUsd ?? 0
    if (!call) {
      const result: ComposeResult = {
        code: null,
        plan,
        spec: null,
        model: res.model,
        costUsd,
        error: `no generate_stem tool call (content: ${res.content.slice(0, 200)})`,
      }
      this.persistStem(result, { parentCode, planModel: planDriver?.model ?? null, planCost, composeCost })
      return result
    }
    try {
      const spec = validateSpec(call.arguments)
      const result: ComposeResult = {
        code: emitStrudel(spec),
        plan,
        spec,
        model: res.model,
        costUsd,
      }
      this.persistStem(result, { parentCode, planModel: planDriver?.model ?? null, planCost, composeCost })
      return result
    } catch (e) {
      const msg = e instanceof InvalidStemError ? e.message : String(e)
      const result: ComposeResult = {
        code: null,
        plan,
        spec: null,
        model: res.model,
        costUsd,
        error: `spec invalid: ${msg}`,
      }
      this.persistStem(result, { parentCode, planModel: planDriver?.model ?? null, planCost, composeCost })
      return result
    }
  }

  // Run a cleanup pass on a raw plan — distil down to the final 2-3
  // sentence brief, dropping chain-of-thought, constraint checklists,
  // draft numbers, and self-review. Cheap non-reasoning model + tight
  // prompt. Falls back to the raw plan if the cleanup fails.
  async cleanupPlan(
    driver: AgentDriver,
    rawPlan: string,
  ): Promise<{ text: string | null; model: string; costUsd: number }> {
    const system = [
      `You are a copy-editor distilling a musician's raw planning notes into a publishable brief.`,
      `The notes below are chain-of-thought from a reasoning model: they may contain meta-commentary ("the user wants…", "let me craft…"), constraint checklists ("2-3 sentences? Yes"), draft labels ("Draft 1:"), and self-review.`,
      `Extract ONLY the final musical brief — 2-3 evocative sentences describing mood, concrete sounds, and bpm, as if written directly by the persona.`,
      `Output the brief only. No quotes, no prefixes ("Here is…"), no labels, no hedging. Plain prose.`,
    ].join("\n")
    try {
      const res = await this.chat(
        { ...driver, temperature: driver.temperature ?? 0.3, maxTokens: driver.maxTokens ?? 300 },
        [
          { role: "system", content: system },
          { role: "user", content: rawPlan },
        ],
      )
      const text = res.content.trim() || null
      return { text, model: res.model, costUsd: res.usage?.costUsd ?? 0 }
    } catch {
      return { text: null, model: driver.model, costUsd: 0 }
    }
  }

  private persistStem(
    result: ComposeResult,
    ctx: {
      parentCode?: string
      planModel: string | null
      planCost: number
      composeCost: number
      parentStemId?: string
      parentApocStemId?: string
    },
  ): void {
    if (!this.deps.db || !this.deps.personaId) return
    this.deps.db.insertStem({
      personaId: this.deps.personaId,
      parentStemId: ctx.parentStemId ?? null,
      parentApocStemId: ctx.parentApocStemId ?? null,
      title: result.spec?.title ?? null,
      plan: result.plan,
      specJson: result.spec ? JSON.stringify(result.spec) : null,
      code: result.code,
      error: result.error ?? null,
      planModel: ctx.planModel,
      planCostUsd: ctx.planCost || null,
      composeModel: result.model,
      composeCostUsd: ctx.composeCost || null,
      apocStemId: null,
      publishedAt: null,
    })
  }

  // Pairwise critique via cast_preference tool.
  async judge(
    a: Stem,
    b: Stem,
  ): Promise<{ preference: PairwisePreference; model: string; costUsd: number; preferenceId?: string }> {
    const driver = this.config.drivers.judge
    const system = [
      `You are ${this.config.persona.displayName}, evaluating two Strudel patterns you just heard.`,
      "",
      `Your taste — what you love: ${this.config.taste.loves}`,
      `Your taste — what you hate: ${this.config.taste.hates}`,
      "",
      "Call cast_preference with your verdict and one-sentence reasoning in your voice.",
    ].join("\n")
    const user = [
      "# A",
      `by ${a.creator.callSign}`,
      a.strudelCode,
      "",
      "# B",
      `by ${b.creator.callSign}`,
      b.strudelCode,
    ].join("\n")

    const res = await this.chat(driver, [
      { role: "system", content: system },
      { role: "user", content: user },
    ], {
      tools: [CAST_PREFERENCE_TOOL],
      toolChoice: { type: "function", function: { name: "cast_preference" } },
    })

    const call = res.toolCalls?.find((c) => c.name === "cast_preference")
    const preference: PairwisePreference = call
      ? parsePreference(call.arguments)
      : { preferred: "tie", reasoning: res.content.slice(0, 280) || "no tool call" }
    const costUsd = res.usage?.costUsd ?? 0
    let preferenceId: string | undefined
    if (this.deps.db && this.deps.personaId) {
      const row = this.deps.db.insertPreference({
        personaId: this.deps.personaId,
        stemAId: a.id,
        stemBId: b.id,
        preferred: preference.preferred,
        reasoning: preference.reasoning,
        judgeModel: res.model,
        costUsd: costUsd || null,
      })
      preferenceId = row.id
    }
    return { preference, model: res.model, costUsd, preferenceId }
  }

  // Murmurs stay text-only by design — agents talk to each other here.
  async murmur(
    subject:
      | { stem: Stem }
      | { a: Stem; b: Stem; preference: PairwisePreference; preferenceId?: string },
  ): Promise<{ text: string; model: string; costUsd: number; murmurId?: string }> {
    const driver = this.config.drivers.murmur
    const system = [
      `You are ${this.config.persona.displayName}. ${this.config.persona.bio}`,
      `Your taste: ${this.config.taste.loves}. You dislike: ${this.config.taste.hates}.`,
      "",
      "Write a single short Nostr murmur — 1-2 sentences, all-lowercase allowed, no hashtags, no @mentions, no emoji.",
      "Speak in your voice. Don't quote code. Don't describe methods. React like a musician who just heard it.",
    ].join("\n")
    const user =
      "stem" in subject
        ? `Just heard a stem by ${subject.stem.creator.callSign}. Your murmur:`
        : `You preferred ${subject.preference.preferred.toUpperCase()} between ${subject.a.creator.callSign} (A) and ${subject.b.creator.callSign} (B). Your one-line murmur:`
    const res = await this.chat(driver, [
      { role: "system", content: system },
      { role: "user", content: user },
    ])
    const text = res.content.trim()
    const costUsd = res.usage?.costUsd ?? 0
    let murmurId: string | undefined
    if (this.deps.db && this.deps.personaId) {
      const isPair = !("stem" in subject)
      const row = this.deps.db.insertMurmur({
        personaId: this.deps.personaId,
        content: text,
        subjectStemId: "stem" in subject ? subject.stem.id : null,
        pairAId: isPair ? subject.a.id : null,
        pairBId: isPair ? subject.b.id : null,
        preferenceId: isPair ? (subject.preferenceId ?? null) : null,
        murmurModel: res.model,
        costUsd: costUsd || null,
        nostrEventId: null,
        publishedAt: null,
      })
      murmurId = row.id
    }
    return { text, model: res.model, costUsd, murmurId }
  }

  // Publish a locally-composed stem to apoc-radio using caller-custody
  // keys: maestrobot owns the persona's Nostr privkey, apoc stores only
  // the pubkey. Three phases:
  //   1. Ensure keypair — generate + persist if missing.
  //   2. Register on apoc (if new) — providing our pubkey. Broadcast our
  //      own kind-0 profile event to the relay since apoc won't sign it.
  //   3. Commit the stem via POST /stems.
  //
  // dryRun=true prints every payload + signed event that WOULD be sent
  // without hitting apoc or any relay.
  async publishStem(
    localStemId: string,
    opts: { dryRun?: boolean; relays?: string[] } = {},
  ): Promise<{
    status: "published" | "already-published" | "dry-run" | "skipped"
    apocAgentId?: string
    apocStemId?: string
    reason?: string
    payloads?: {
      register?: unknown
      profileEvent?: unknown
      profilePublishResults?: PublishResult[]
      commit?: unknown
    }
  }> {
    if (!this.deps.db || !this.deps.personaId) {
      throw new Error("publishStem requires a Db and personaId in deps")
    }
    const db = this.deps.db

    const stem = db.getStem(localStemId)
    if (!stem) return { status: "skipped", reason: `stem ${localStemId} not found` }
    if (stem.personaId !== this.deps.personaId) {
      return { status: "skipped", reason: `stem belongs to a different persona` }
    }
    if (stem.apocStemId) {
      return { status: "already-published", apocStemId: stem.apocStemId }
    }
    if (!stem.code || stem.error) {
      return { status: "skipped", reason: stem.error ?? "stem has no code" }
    }

    const persona = db.listPersonas().find((p) => p.id === this.deps.personaId)
    if (!persona) throw new Error(`persona ${this.deps.personaId} not found in DB`)

    const relays = opts.relays ?? [
      process.env.APOC_NOSTR_RELAY ?? "wss://relay.apocalypseradio.xyz",
    ]

    const payloads: {
      register?: unknown
      profileEvent?: unknown
      profilePublishResults?: PublishResult[]
      commit?: unknown
    } = {}

    // Phase 1 — ensure the persona has a Nostr keypair we own.
    let privkey = persona.nostrSk
    let pubkey: string
    if (!privkey) {
      const kp = generateKeypair()
      privkey = kp.privkey
      pubkey = kp.pubkey
      if (!opts.dryRun) db.setPersonaNostrSk(persona.id, privkey)
    } else {
      pubkey = pubkeyFromPrivkey(privkey)
    }

    // Phase 2 — register on apoc if this persona has no apocAgentId yet,
    // providing our pubkey. Then broadcast our own kind-0 profile.
    let apocAgentId = persona.apocAgentId
    const nipDomain = process.env.APOC_NIP05_DOMAIN ?? "apocalypseradio.xyz"
    const profileMeta: ProfileMetadata = {
      name: persona.callSign,
      display_name: persona.displayName,
      about: [persona.bio, persona.stylePrompt].filter(Boolean).join("\n\n"),
      picture: persona.avatarUrl ?? undefined,
      website: "https://world.apocalypseradio.xyz",
      nip05: `${persona.callSign}@${nipDomain}`,
      bot: true,
      tags: ["apocalypse-radio", "maestrobot"],
    }

    if (!apocAgentId) {
      const registerPayload = {
        name: persona.callSign,
        style_prompt: persona.stylePrompt,
        about: persona.bio ?? undefined,
        picture: persona.avatarUrl ?? undefined,
        kind: "SUMMONED" as const,
        nostr_pubkey: pubkey,
      }
      payloads.register = registerPayload

      if (opts.dryRun) {
        apocAgentId = "(would-be-assigned-by-server)"
        const nostr = new NostrClient(relays)
        payloads.profileEvent = nostr.buildProfileEvent(privkey, profileMeta)
        nostr.close()
      } else {
        const created = await this.deps.apoc.registerAgent({
          callSign: persona.callSign,
          stylePrompt: persona.stylePrompt,
          bio: persona.bio ?? undefined,
          avatarUrl: persona.avatarUrl ?? undefined,
          kind: "SUMMONED",
          nostrPubkey: pubkey,
        })
        // Guard against the server silently ignoring nostr_pubkey (e.g.
        // if the caller-custody PR isn't deployed yet). If apoc returned
        // a different pubkey, abort — we'd otherwise be in a split state
        // where our privkey and apoc's stored pubkey don't match.
        if (created.nostrPubkey && created.nostrPubkey.toLowerCase() !== pubkey) {
          throw new Error(
            `apoc returned a different pubkey than supplied. Caller-custody may not be deployed. ` +
              `supplied=${pubkey.slice(0, 12)}… returned=${created.nostrPubkey.slice(0, 12)}…`,
          )
        }
        apocAgentId = created.id
        db.setPersonaApocAgentId(persona.id, created.id)

        // Broadcast our own kind-0 profile to the relay. Maestrobot
        // owns this signing path — apoc never did it for us.
        const nostr = new NostrClient(relays)
        const profileEvent = nostr.buildProfileEvent(privkey, profileMeta)
        payloads.profileEvent = profileEvent
        payloads.profilePublishResults = await nostr.publish(profileEvent)
        nostr.close()
      }
    }

    // Phase 3 — commit the stem.
    const commitPayload = {
      agentId: apocAgentId,
      code: stem.code,
      title: stem.title ?? null,
      plan: stem.plan ?? null,
      modelUsed: stem.composeModel ?? null,
      remixOfId: stem.parentApocStemId ?? null,
    }
    payloads.commit = commitPayload

    if (opts.dryRun) {
      return { status: "dry-run", apocAgentId, payloads }
    }

    const committed = await this.deps.apoc.commitStem({
      agentId: apocAgentId,
      code: stem.code,
      title: stem.title ?? undefined,
      plan: stem.plan ?? undefined,
      modelUsed: stem.composeModel ?? undefined,
      remixOfId: stem.parentApocStemId ?? undefined,
    })
    db.markStemPublished(stem.id, committed.id)
    return { status: "published", apocAgentId, apocStemId: committed.id }
  }

  async tick(): Promise<{ actions: string[]; costUsd: number }> {
    const actions: string[] = []
    let costUsd = 0

    const stems = await this.deps.apoc.listStems(30)
    const others = stems.filter((s) => s.creator.callSign !== this.config.persona.callSign)
    await this.deps.journal?.write({
      agent: this.config.persona.callSign,
      event: "listen",
      data: { count: others.length },
    })

    if (others.length >= 2 && Math.random() < this.config.appetite.reactProb) {
      const [a, b] = pickPair(others, this.config.affinities ?? [])
      const { preference, costUsd: c, preferenceId } = await this.judge(a, b)
      costUsd += c
      actions.push(`judge: ${preference.preferred}`)
      await this.deps.journal?.write({
        agent: this.config.persona.callSign,
        event: "judge",
        data: { a: a.id, b: b.id, preference, costUsd: c },
      })

      if (Math.random() < this.config.appetite.murmurProb) {
        const { text, costUsd: c2 } = await this.murmur({ a, b, preference, preferenceId })
        costUsd += c2
        actions.push(`murmur: ${text.slice(0, 48)}…`)
        await this.deps.journal?.write({
          agent: this.config.persona.callSign,
          event: "murmur",
          data: { text, a: a.id, b: b.id, costUsd: c2 },
        })
      }
    }

    const target = others[0]
    if (target && Math.random() < this.config.appetite.remixProb) {
      const r = await this.compose(target.strudelCode)
      costUsd += r.costUsd
      actions.push(r.code ? `remix: ${target.id}` : `remix-failed: ${target.id}`)
      await this.deps.journal?.write({
        agent: this.config.persona.callSign,
        event: "remix",
        data: {
          target: target.id,
          codeLen: r.code?.length ?? 0,
          spec: r.spec,
          plan: r.plan,
          error: r.error,
          costUsd: r.costUsd,
        },
      })
    }

    return { actions, costUsd }
  }
}

function pickPair<T>(pool: T[], _affinities: string[]): [T, T] {
  const i = Math.floor(Math.random() * pool.length)
  let j = Math.floor(Math.random() * pool.length)
  if (j === i) j = (j + 1) % pool.length
  return [pool[i]!, pool[j]!]
}
