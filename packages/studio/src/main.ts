import { initStrudel, isReady, playPattern, primeAudio, stopPlayback } from "./strudel.js"

interface StemRow {
  id: string
  title: string | null
  code: string | null
  plan: string | null
  specJson: string | null
  composeModel: string | null
  planModel: string | null
  composeCostUsd: number | null
  planCostUsd: number | null
  error: string | null
  createdAt: string
  callSign: string
  displayName: string
  bio: string | null
  avatarUrl: string | null
  stylePrompt: string
  tasteLoves: string
  tasteHates: string
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const listEl = $("stem-list") as HTMLUListElement
const codeEl = $("code") as HTMLTextAreaElement
const statusEl = $("status")
const bootEl = $("boot-status")
const errorEl = $("error")
const stemTitleBlock = $("stem-title-block")
const stemTitleMain = $("stem-title-main")
const personaBlock = $("persona-block")
const personaSwatch = $("persona-swatch")
const personaDisplay = $("persona-display")
const personaCallsign = $("persona-callsign")
const personaBio = $("persona-bio")
const personaMeta = $("persona-meta")
const stylePromptEl = $("style-prompt") as HTMLPreElement
const tasteLovesEl = $("taste-loves") as HTMLPreElement
const tasteHatesEl = $("taste-hates") as HTMLPreElement
const specEl = $("spec-json") as HTMLPreElement
const planEl = $("plan") as HTMLPreElement
const playBtn = $("play") as HTMLButtonElement
const stopBtn = $("stop") as HTMLButtonElement
const refreshBtn = $("refresh") as HTMLButtonElement

let selected: StemRow | null = null

async function fetchStems(): Promise<StemRow[]> {
  const res = await fetch("/api/stems?limit=100")
  if (!res.ok) throw new Error(`api/stems ${res.status}`)
  return (await res.json()) as StemRow[]
}

function renderList(stems: StemRow[]): void {
  listEl.innerHTML = ""
  if (stems.length === 0) {
    const li = document.createElement("li")
    li.className = "empty"
    li.textContent = "no stems yet — run pnpm agent:run"
    listEl.appendChild(li)
    return
  }
  for (const s of stems) {
    const li = document.createElement("li")
    li.className = "stem" + (s.error ? " has-error" : "") + (!s.code ? " empty-code" : "")
    li.dataset.stemId = s.id
    li.style.setProperty("--persona-color", personaColor(s.callSign))
    const composeShort = s.composeModel?.split("/").pop() ?? "?"
    const cost = ((s.composeCostUsd ?? 0) + (s.planCostUsd ?? 0)).toFixed(5)
    const title = s.title?.trim() || "(untitled)"
    li.innerHTML = `
      <div class="stem-title">${escape(title)}</div>
      <div class="stem-persona-row">
        <span class="stem-swatch" aria-hidden="true"></span>
        <span class="stem-persona-name">${escape(s.displayName)}</span>
      </div>
      <div class="stem-meta">${formatDate(s.createdAt)} · ${escape(composeShort)} · $${cost}</div>
      ${s.error ? `<div class="stem-badge">ERROR</div>` : ""}
    `
    li.onclick = () => selectStem(s)
    listEl.appendChild(li)
  }
  if (stems[0]) selectStem(stems[0])
}

function selectStem(stem: StemRow): void {
  selected = stem
  for (const li of Array.from(listEl.children)) {
    li.classList.remove("active")
  }
  const match = Array.from(listEl.children).find(
    (li) => (li as HTMLElement).dataset.stemId === stem.id,
  )
  match?.classList.add("active")

  // Stem title — the work itself.
  stemTitleBlock.hidden = false
  stemTitleMain.textContent = stem.title?.trim() || "(untitled)"

  // Persona block — the part that answers "who made this?"
  personaBlock.hidden = false
  personaBlock.style.setProperty("--persona-color", personaColor(stem.callSign))
  personaSwatch.style.background = personaColor(stem.callSign)
  personaDisplay.textContent = stem.displayName
  personaCallsign.textContent = `@${stem.callSign}`
  personaBio.textContent = stem.bio ?? "(no bio)"
  const composeShort = stem.composeModel?.split("/").pop() ?? "?"
  const cost = ((stem.composeCostUsd ?? 0) + (stem.planCostUsd ?? 0)).toFixed(5)
  personaMeta.textContent = `${formatDate(stem.createdAt)} · compose: ${composeShort} · $${cost}`

  stylePromptEl.textContent = stem.stylePrompt
  tasteLovesEl.textContent = stem.tasteLoves
  tasteHatesEl.textContent = stem.tasteHates

  codeEl.value = stem.code ?? ""
  planEl.textContent = stem.plan ?? "(no plan)"
  specEl.textContent = stem.specJson ? prettyJson(stem.specJson) : "(no spec — compose errored)"
  errorEl.textContent = stem.error ?? ""
  errorEl.style.display = stem.error ? "block" : "none"
  playBtn.disabled = !stem.code
}

// Deterministic colour per callSign so the same persona gets the same
// hue everywhere. Good enough for distinguishing ~20 personas at a
// glance without a colour-picker UI.
function personaColor(callSign: string): string {
  let h = 0
  for (let i = 0; i < callSign.length; i++) {
    h = (h * 31 + callSign.charCodeAt(i)) >>> 0
  }
  const hue = h % 360
  return `hsl(${hue} 70% 60%)`
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso.replace(" ", "T") + "Z")
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function escape(s: string): string {
  const div = document.createElement("div")
  div.textContent = s
  return div.innerHTML
}

playBtn.onclick = async () => {
  primeAudio()
  errorEl.textContent = ""
  errorEl.style.display = "none"
  statusEl.textContent = isReady() ? "loading…" : "booting runtime…"
  try {
    await playPattern(codeEl.value)
    statusEl.textContent = "playing"
  } catch (e) {
    statusEl.textContent = "error"
    errorEl.textContent = String((e as Error).message ?? e)
    errorEl.style.display = "block"
  }
}

stopBtn.onclick = () => {
  stopPlayback()
  statusEl.textContent = "stopped"
}

refreshBtn.onclick = async () => {
  try {
    renderList(await fetchStems())
  } catch (e) {
    errorEl.textContent = String((e as Error).message ?? e)
    errorEl.style.display = "block"
  }
}

// Boot only fetches stems. Strudel init is deferred to first Play click
// because @strudel/webaudio's initAudio() needs a user gesture to resume
// the AudioContext — eager init can hang the page.
async function boot(): Promise<void> {
  try {
    const stems = await fetchStems()
    renderList(stems)
    bootEl.textContent = "ready — click play to boot the strudel runtime"
    playBtn.disabled = !selected?.code
    statusEl.textContent = "idle"
  } catch (e) {
    bootEl.textContent = `boot failed: ${(e as Error).message}`
  }
}

boot()
