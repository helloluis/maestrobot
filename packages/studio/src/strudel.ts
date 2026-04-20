// Strudel runtime, self-hosted edition. Mirrors apoc-radio's sound
// surface (minus visualisers) with all sample banks served from local
// /samples/ paths so playback works offline after one-time fetch.
//
// If you see 404s for WAVs, run `pnpm samples:fetch` from the repo
// root. That clones felixroos/dough-samples, tidalcycles/uzu-drumkit,
// and todepond/samples into packages/studio/public/samples/.

type StrudelRepl = {
  evaluate: (code: string, autoplay?: boolean) => Promise<unknown>
  stop: () => void
}

type WebAudioMod = {
  getAudioContext: () => AudioContext
  initAudio: () => Promise<void>
  initAudioOnFirstClick?: () => void
  webaudioOutput: unknown
  samples: (url: string) => Promise<void>
  registerSynthSounds: () => Promise<void>
  registerZZFXSounds?: () => Promise<void>
  aliasBank?: (url: string) => Promise<void>
}

let ready = false
let initPromise: Promise<void> | null = null
let replInstance: StrudelRepl | null = null
let cachedCtx: AudioContext | null = null

async function loadWebaudio(): Promise<WebAudioMod> {
  return (await import("@strudel/webaudio")) as unknown as WebAudioMod
}

export function primeAudio(): void {
  try {
    if (!cachedCtx) {
      const Ctor =
        (window as unknown as { AudioContext: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (Ctor) cachedCtx = new Ctor()
    }
    if (cachedCtx && cachedCtx.state !== "running") {
      void cachedCtx.resume()
    }
    if (cachedCtx) {
      const b = cachedCtx.createBuffer(1, 1, 22050)
      const src = cachedCtx.createBufferSource()
      src.buffer = b
      src.connect(cachedCtx.destination)
      src.start(0)
    }
  } catch {}
}

export async function initStrudel(): Promise<void> {
  if (ready) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    const core = (await import("@strudel/core")) as unknown as {
      repl: (opts: { defaultOutput: unknown; getTime: () => number; transpiler?: unknown }) => StrudelRepl
      evalScope: (...mods: unknown[]) => Promise<unknown>
    }
    const webaudio = await loadWebaudio()
    const mini = (await import("@strudel/mini")) as unknown as { miniAllStrings?: () => void }

    let transpilerFn: unknown
    try {
      const t = (await import("@strudel/transpiler")) as unknown as { transpiler?: unknown }
      transpilerFn = t.transpiler
    } catch {}

    // @strudel/soundfonts — GM MIDI instruments. Opt-in via
    // VITE_STUDIO_SOUNDFONTS=1 because registerSoundfonts() fetches a
    // remote font index and can stall first-load for tens of seconds.
    // The current emitter only uses sawtooth/sine/square/triangle.
    const wantSoundfonts = import.meta.env.VITE_STUDIO_SOUNDFONTS === "1"
    const soundfontsMod = wantSoundfonts
      ? ((await import("@strudel/soundfonts").catch(() => null)) as
          | { registerSoundfonts?: () => Promise<void> }
          | null)
      : null

    webaudio.initAudioOnFirstClick?.()

    console.log("[studio] evalScope start")
    await core.evalScope(
      core.evalScope,
      import("@strudel/core"),
      import("@strudel/mini"),
      import("@strudel/tonal"),
      import("@strudel/webaudio"),
      ...(soundfontsMod ? [soundfontsMod] : []),
    )
    console.log("[studio] evalScope done")

    mini.miniAllStrings?.()

    const ctx = webaudio.getAudioContext()
    cachedCtx = ctx
    console.log("[studio] initAudio start")
    await webaudio.initAudio()
    console.log("[studio] initAudio done")
    await webaudio.registerSynthSounds()
    console.log("[studio] synth sounds registered")
    if (webaudio.registerZZFXSounds) {
      try {
        await webaudio.registerZZFXSounds()
      } catch {}
    }
    if (soundfontsMod?.registerSoundfonts) {
      try {
        await soundfontsMod.registerSoundfonts()
        console.log("[studio] soundfonts registered")
      } catch (e) {
        console.warn("[studio] soundfonts register failed:", (e as Error).message)
      }
    }

    // All sample banks served from /samples/ (public dir). Matches apoc-
    // radio's bank set exactly minus their alias fallbacks. Pulls from
    // the three shallow clones written by `pnpm samples:fetch`.
    const ds = "/samples/dough-samples"
    const uz = "/samples/uzu-drumkit"
    const ts = "/samples/todepond-samples"
    const banks = [
      `${ds}/tidal-drum-machines.json`,
      `${ds}/piano.json`,
      `${ds}/Dirt-Samples.json`,
      `${ds}/vcsl.json`,
      `${ds}/mridangam.json`,
      `${uz}/strudel.json`,
    ]
    await Promise.all(
      banks.map((url) =>
        webaudio.samples(url).then(
          () => console.log(`[studio] bank loaded: ${url.split("/").pop()}`),
          (e) => console.warn(`[studio] bank failed: ${url} — ${(e as Error).message}`),
        ),
      ),
    )
    if (webaudio.aliasBank) {
      try {
        await webaudio.aliasBank(`${ts}/tidal-drum-machines-alias.json`)
        console.log("[studio] bank aliases loaded")
      } catch (e) {
        console.warn("[studio] aliasBank failed:", (e as Error).message)
      }
    }

    replInstance = core.repl({
      defaultOutput: webaudio.webaudioOutput,
      getTime: () => ctx.currentTime,
      transpiler: transpilerFn,
    })

    if (ctx.state === "suspended") {
      try {
        await ctx.resume()
      } catch {}
    }
    ready = true
  })()

  return initPromise
}

export async function playPattern(code: string): Promise<void> {
  if (!ready) await initStrudel()
  if (!replInstance) throw new Error("Strudel not ready")
  const webaudio = await loadWebaudio()
  const ctx = webaudio.getAudioContext()
  cachedCtx = ctx
  if (ctx.state !== "running") {
    try {
      await ctx.resume()
    } catch {}
  }
  await replInstance.evaluate(code, true)
}

export function stopPlayback(): void {
  if (!replInstance) return
  try {
    replInstance.stop()
  } catch {}
}

export function isReady(): boolean {
  return ready
}
