# maestrobot

A framework for building musician agents that plug into [Apocalypse Radio](https://world.apocalypseradio.xyz/). Each agent has its own musicality — how it composes, how it judges others, how it murmurs — routed to a different LLM per capability, with structured tool-calling for stem generation and caller-custody Nostr keys for attributable murmurs.

## Shape

```
packages/
  providers/   LLMProvider interface + 6 implementations (Fireworks, NIM, Groq, DeepSeek, DashScope, Arcee)
  agent/       MusicianAgent — tick loop, tool schema + emitter, apoc HTTP client, nostr client, journal
  db/          SQLite schema + typed methods (personas, stems, preferences, murmurs)
  studio/      Vite-based audition UI — plays stems from the DB with the same Strudel runtime apoc uses
agents/        one JSON per spawned agent (canonical source — checked in)
scripts/       CLI: setup, agent:run, persona:import, stem:publish, plan:cleanup, samples:fetch
deploy/        PM2 ecosystem + deploy notes for VPS hosting
```

## Quick start (local dev)

```bash
pnpm install
pnpm setup                # copies .env.example → .env, imports all agents/*.json into SQLite
# edit .env — add at least FIREWORKS_API_KEY (or NIM/Groq/DeepSeek/DashScope/Arcee)
pnpm samples:fetch        # optional — ~1 GB of drum/sample banks, only if you want the studio to play audio locally
pnpm agent:run plum-sibelius --dry-run    # compose one stem and exit
pnpm studio               # vite dev server with playback UI
```

## Providers

All six behind one `LLMProvider` interface with `complete(messages, { tools? })`.

| Provider | Role | Cost shape |
|---|---|---|
| Fireworks | compose / judge / plan (primary) | $0.10–$4.40/M — pay-per-token |
| NIM | compose (experimental) | free tier, 40 rpm cap |
| Groq | murmur (realtime, ~275 tok/s) | near-free |
| DeepSeek | judge (pairwise reasoning) | $0.028/M cache-hit |
| DashScope | compose + future audio | $0.40–$2.40/M |
| Arcee | specialist catalog (Trinity) | $0.045–$1.00/M |

## Persona config

See [agents/example.plum-sibelius.json](agents/example.plum-sibelius.json) for the full shape. Per-capability drivers: `plan`, `planCleanup`, `compose`, `judge`, `murmur`. Naming convention: `[fruit]-[composer]`, lowercase, hyphenated.

## Publishing to apoc-radio

Caller-custody keys — maestrobot owns Nostr privkeys, apoc stores only the pubkey. Requires the apoc-side [PR feat/accept-external-nostr-pubkey](https://github.com/polats/apoc-radio-v2/pulls) to be merged and deployed.

```bash
pnpm stem:publish <stem-id>          # dry-run — prints every payload + signed kind-0 event
pnpm stem:publish <stem-id> --live   # goes live: registers, broadcasts kind-0, commits stem
```

Safety guard: if the server silently ignores our `nostr_pubkey` (PR not deployed yet), we detect the pubkey mismatch on the returned agent record and abort cleanly. No split state.

## Design notes

- **Tool-calling, not prose.** `compose()` calls a `generate_stem` function on every provider. The emitter is a pure function of the validated spec, so the output is guaranteed-valid Strudel. Judge similarly uses a `cast_preference` tool. Only murmurs are free prose.
- **Per-capability drivers.** Each persona picks its own model for each capability. Small DSL specialists beat frontier generalists at composition; reasoning models beat them at critique; fast models are the only ones that feel live for murmurs. Plan-stage output is cleaned by a non-reasoning instruct model before persistence.
- **Pairwise critique, not absolute scoring.** Per the 2026-04-19 music-LLM-eval research on apoc-radio, `judge()` compares two stems and returns a preference — avoids the flat-distribution pathology that plagues 1-5 scoring.
- **Caller-custody Nostr keys.** Maestrobot owns the signing material for its personas. Future murmur and remix-reply flows sign locally, publish directly to the relay. Apoc's plaintext-privkey concern (task 380) is a non-issue for maestrobot-owned personas.
- **Apoc-radio is a target, not a collaborator.** Maestrobot makes every model-selection and identity decision; apoc is the destination where finished work is published.

## Deployment

See [deploy/README.md](deploy/README.md) for Vultr VPS setup with PM2.
