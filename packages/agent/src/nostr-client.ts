import { finalizeEvent, generateSecretKey, getPublicKey, SimplePool } from "nostr-tools"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"

// Minimum nostr client for maestrobot: generate keypairs, sign kind-0
// profile metadata and kind-1 notes, publish to a configurable relay
// set. Keep this tiny — nostr-tools' SimplePool does the heavy lifting.

export interface NostrKeypair {
  privkey: string // 64-char hex
  pubkey: string // 64-char hex
}

export interface ProfileMetadata {
  name?: string
  display_name?: string
  about?: string
  picture?: string
  banner?: string
  website?: string
  nip05?: string
  lud16?: string
  // Non-standard but apoc-radio uses these for filtering.
  bot?: boolean
  tags?: string[]
}

export interface PublishResult {
  relay: string
  ok: boolean
  error?: string
}

export function generateKeypair(): NostrKeypair {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  return { privkey: bytesToHex(sk), pubkey: pk }
}

export function pubkeyFromPrivkey(privkey: string): string {
  return getPublicKey(hexToBytes(privkey))
}

export class NostrClient {
  private pool: SimplePool
  constructor(public relays: string[]) {
    this.pool = new SimplePool()
  }

  // Build + sign a kind-0 metadata event. Caller-side publish so apoc
  // never sees the privkey. The tags mirror apoc-radio's server-side
  // buildProfileEvent so external Nostr clients see the same shape.
  buildProfileEvent(privkeyHex: string, metadata: ProfileMetadata, extraAlt?: string): SignedEvent {
    const content = Object.fromEntries(
      Object.entries(metadata).filter(([, v]) => v !== undefined && v !== null && v !== ""),
    )
    const template = {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "apocalypse-radio"],
        ["alt", extraAlt ?? `agent ${metadata.name ?? "(unknown)"} on Apocalypse Radio`],
      ] as string[][],
      content: JSON.stringify(content),
    }
    return finalizeEvent(template, hexToBytes(privkeyHex)) as SignedEvent
  }

  // Build + sign a kind-1 note. `e` tags reference other event ids
  // (NIP-10 reply / NIP-32 label style). `p` tags mention other pubkeys.
  buildNoteEvent(
    privkeyHex: string,
    content: string,
    opts: { replyTo?: string[]; mention?: string[]; extraTags?: string[][] } = {},
  ): SignedEvent {
    const tags: string[][] = [["t", "apocalypse-radio"]]
    for (const id of opts.replyTo ?? []) tags.push(["e", id])
    for (const pk of opts.mention ?? []) tags.push(["p", pk])
    for (const t of opts.extraTags ?? []) tags.push(t)
    const template = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    }
    return finalizeEvent(template, hexToBytes(privkeyHex)) as SignedEvent
  }

  async publish(event: SignedEvent): Promise<PublishResult[]> {
    const results = await Promise.allSettled(this.pool.publish(this.relays, event))
    return results.map((r, i) => {
      const relay = this.relays[i] ?? "?"
      if (r.status === "fulfilled") return { relay, ok: true }
      return { relay, ok: false, error: String((r.reason as Error)?.message ?? r.reason) }
    })
  }

  close(): void {
    this.pool.close(this.relays)
  }
}

// Minimal typing for the event shape we hand around. nostr-tools'
// finalizeEvent returns a richer interface; this is the subset we rely on.
export interface SignedEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}
