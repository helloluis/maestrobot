import type { Tool } from "@maestrobot/providers"

export const BANKS = ["RolandTR808", "RolandTR909", "LinnDrum"] as const
export const SYNTHS = ["sawtooth", "sine", "square", "triangle"] as const

export type Bank = (typeof BANKS)[number]
export type Synth = (typeof SYNTHS)[number]

export interface DrumVoice {
  kind: "drum"
  pattern: string
  bank: Bank
  gain?: number
  decay?: number
  room?: number
  delay?: number
  lpf?: number
  hpf?: number
  pan?: number
}

export interface NoteVoice {
  kind: "note"
  pattern: string
  synth: Synth
  lpf?: number
  hpf?: number
  gain?: number
  room?: number
  delay?: number
  attack?: number
  release?: number
  decay?: number
  sustain?: number
  pan?: number
}

export type Voice = DrumVoice | NoteVoice

export interface StemSpec {
  title: string
  bpm: number
  voices: Voice[]
}

// The single tool every maestrobot agent uses to compose stems. Schema
// intentionally tight: ranges are Strudel-safe, enums prevent drift into
// Tidal syntax, mini-notation strings pass through but are guarded below.
export const GENERATE_STEM_TOOL: Tool = {
  type: "function",
  function: {
    name: "generate_stem",
    description:
      "Compose a short Strudel music pattern as a stack of simultaneous voices. Fill every argument: a short title in your voice, a bpm integer, and an array of voices. Musical creativity is expressed through which voices and effects you pick — the system handles syntax.",
    parameters: {
      type: "object",
      required: ["title", "bpm", "voices"],
      properties: {
        title: {
          type: "string",
          description:
            "A short, evocative title for this stem in your persona's voice. 2-5 words, lowercase allowed, 60 chars max. Name the work, don't describe it. Examples: 'amber drift', 'concrete blue', 'rolling submerged', 'third dawn chime'.",
        },
        bpm: {
          type: "integer",
          minimum: 40,
          maximum: 200,
          description: "Tempo in cycles per minute.",
        },
        voices: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          description:
            "Between 1 and 6 simultaneous voices stacked together. Each voice is either a drum voice (kind='drum' with bank) or a note voice (kind='note' with synth).",
          items: {
            type: "object",
            required: ["kind", "pattern"],
            properties: {
              kind: {
                enum: ["drum", "note"],
                description:
                  "'drum' plays a sample-bank pattern (requires bank). 'note' plays pitched synth notes (requires synth).",
              },
              pattern: {
                type: "string",
                description:
                  "Mini-notation pattern. For drum voices, use drum names (bd sd hh oh cp rim lt mt ht rd cr) with rests (~) and repetitions (*), e.g. 'bd ~ bd ~', 'hh*8', 'bd(3,8)'. For note voices, use pitch names with octave, e.g. 'c2 eb2 g2 bb2', '<c3 eb3 g3>', 'f2!4'. Must NOT contain: $ # >>= \\ or Haskell-style syntax.",
              },
              bank: {
                enum: [...BANKS],
                description: "Required when kind='drum'. Ignored for note voices.",
              },
              synth: {
                enum: [...SYNTHS],
                description: "Required when kind='note'. Ignored for drum voices.",
              },
              gain: { type: "number", minimum: 0, maximum: 1 },
              decay: { type: "number", minimum: 0, maximum: 5 },
              sustain: { type: "number", minimum: 0, maximum: 1 },
              attack: { type: "number", minimum: 0, maximum: 5 },
              release: { type: "number", minimum: 0, maximum: 5 },
              lpf: { type: "number", minimum: 50, maximum: 20000 },
              hpf: { type: "number", minimum: 50, maximum: 20000 },
              room: { type: "number", minimum: 0, maximum: 1 },
              delay: { type: "number", minimum: 0, maximum: 1 },
              pan: { type: "number", minimum: -1, maximum: 1 },
            },
          },
        },
      },
    },
  },
}

// Reject patterns containing tokens the Strudel runtime will choke on —
// this catches Tidal-syntax bleed that sometimes slips through even with
// a typed schema. Throw so the agent journals a schema-violation error
// instead of emitting invalid Strudel.
const BANNED_PATTERN = /\$|#|>>=|\\|\bmididefault\b|\bd1\b/

export class InvalidStemError extends Error {
  constructor(reason: string, public spec?: unknown) {
    super(reason)
  }
}

export function validateSpec(raw: unknown): StemSpec {
  if (!raw || typeof raw !== "object") throw new InvalidStemError("spec must be an object")
  const spec = raw as Record<string, unknown>
  let title = typeof spec.title === "string" ? spec.title.trim() : ""
  if (title.length > 60) title = title.slice(0, 60)
  // Permissive fallback — the tool schema marks title required but
  // some models drop it. Better to accept the stem with a placeholder
  // than reject the whole compose. Caller can rename via the studio.
  if (!title) title = "untitled"
  const bpm = Number(spec.bpm)
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 200) {
    throw new InvalidStemError(`bpm out of range: ${spec.bpm}`)
  }
  if (!Array.isArray(spec.voices) || spec.voices.length === 0 || spec.voices.length > 6) {
    throw new InvalidStemError(`voices must be an array of 1-6 items`)
  }

  const voices: Voice[] = spec.voices.map((v, i) => {
    if (!v || typeof v !== "object") throw new InvalidStemError(`voice ${i} not an object`)
    const voice = v as Record<string, unknown>
    const pattern = String(voice.pattern ?? "")
    if (!pattern || BANNED_PATTERN.test(pattern)) {
      throw new InvalidStemError(`voice ${i} pattern invalid: ${pattern}`)
    }
    if (voice.kind === "drum") {
      if (!BANKS.includes(voice.bank as Bank)) {
        throw new InvalidStemError(`voice ${i} bank invalid: ${voice.bank}`)
      }
      return {
        kind: "drum",
        pattern,
        bank: voice.bank as Bank,
        ...numericFields(voice, ["gain", "decay", "room", "delay", "lpf", "hpf", "pan"]),
      }
    }
    if (voice.kind === "note") {
      if (!SYNTHS.includes(voice.synth as Synth)) {
        throw new InvalidStemError(`voice ${i} synth invalid: ${voice.synth}`)
      }
      return {
        kind: "note",
        pattern,
        synth: voice.synth as Synth,
        ...numericFields(voice, [
          "lpf", "hpf", "gain", "room", "delay",
          "attack", "release", "decay", "sustain", "pan",
        ]),
      }
    }
    throw new InvalidStemError(`voice ${i} kind must be 'drum' or 'note'`)
  })

  return { title, bpm: Math.round(bpm), voices }
}

function numericFields(
  src: Record<string, unknown>,
  keys: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of keys) {
    const v = src[k]
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v
  }
  return out
}

export function emitStrudel(spec: StemSpec): string {
  const lines = spec.voices.map((v) => (v.kind === "drum" ? drumLine(v) : noteLine(v)))
  const body = lines.length === 1 ? lines[0]! : `stack(\n  ${lines.join(",\n  ")}\n)`
  return `${body}.cpm(${spec.bpm})`
}

function drumLine(v: DrumVoice): string {
  const parts: string[] = [`s(${jsStr(v.pattern)})`, `.bank(${jsStr(v.bank)})`]
  appendIf(parts, "gain", v.gain)
  appendIf(parts, "decay", v.decay)
  appendIf(parts, "room", v.room)
  appendIf(parts, "delay", v.delay)
  appendIf(parts, "lpf", v.lpf)
  appendIf(parts, "hpf", v.hpf)
  appendIf(parts, "pan", v.pan)
  return parts.join("")
}

function noteLine(v: NoteVoice): string {
  const parts: string[] = [`note(${jsStr(v.pattern)})`, `.s(${jsStr(v.synth)})`]
  appendIf(parts, "lpf", v.lpf)
  appendIf(parts, "hpf", v.hpf)
  appendIf(parts, "gain", v.gain)
  appendIf(parts, "room", v.room)
  appendIf(parts, "delay", v.delay)
  appendIf(parts, "attack", v.attack)
  appendIf(parts, "release", v.release)
  appendIf(parts, "decay", v.decay)
  appendIf(parts, "sustain", v.sustain)
  appendIf(parts, "pan", v.pan)
  return parts.join("")
}

function appendIf(parts: string[], name: string, val: number | undefined): void {
  if (val === undefined) return
  parts.push(`.${name}(${roundFinite(val)})`)
}

function roundFinite(n: number): number | string {
  if (!Number.isFinite(n)) return 0
  // Keep 3 decimals; drop trailing zeros for shorter emitted Strudel.
  return Number(n.toFixed(3))
}

function jsStr(s: string): string {
  return JSON.stringify(s)
}
