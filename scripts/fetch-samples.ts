import { execSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// Mirror Strudel's sample banks locally. This is more work than a vanilla
// git clone because:
//  (a) the JSON manifests in felixroos/dough-samples each have a "_base"
//      field pointing at a *different* remote repo (tidalcycles/Dirt-Samples,
//      ritchse/tidal-drum-machines, yaxu/mrid, sgossner/VCSL) — so we have
//      to clone those too, and
//  (b) dough-samples references those repos as submodules but in some cases
//      points at a different fork than the _base — so we clone the _base
//      upstream directly instead of recursing submodules.
//
// After cloning, we rewrite every _base URL in every JSON to a local
// /samples/... path so Strudel fetches WAVs from Vite's static server.

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const target = resolve(repoRoot, "packages/studio/public/samples")
const sourcesDir = resolve(target, "sources")

interface RepoSpec {
  name: string
  url: string
  dest: string
  sizeHint: string
  optional?: boolean
  flag?: string
}

const REPOS: RepoSpec[] = [
  // Top-level — manifests live in these.
  {
    name: "dough-samples",
    url: "https://github.com/felixroos/dough-samples.git",
    dest: resolve(target, "dough-samples"),
    sizeHint: "~12 MB — hosts the bank JSON manifests + piano samples",
  },
  {
    name: "uzu-drumkit",
    url: "https://github.com/tidalcycles/uzu-drumkit.git",
    dest: resolve(target, "uzu-drumkit"),
    sizeHint: "~5 MB — Strudel's default drum kit",
  },
  {
    name: "todepond-samples",
    url: "https://github.com/todepond/samples.git",
    dest: resolve(target, "todepond-samples"),
    sizeHint: "~10 MB — mostly the tidal-drum-machines alias map",
  },
  // Sources — what the _base URLs in the manifests actually point at.
  {
    name: "tidal-drum-machines (ritchse)",
    url: "https://github.com/ritchse/tidal-drum-machines.git",
    dest: resolve(sourcesDir, "tidal-drum-machines"),
    sizeHint: "~50-80 MB — drum-machine WAVs referenced by tidal-drum-machines.json + EmuSP12.json",
  },
  {
    name: "Dirt-Samples (tidalcycles)",
    url: "https://github.com/tidalcycles/Dirt-Samples.git",
    dest: resolve(sourcesDir, "Dirt-Samples"),
    sizeHint: "~100-150 MB — the canonical TidalCycles samples (bd, sd, hh, cp, rim, ...)",
  },
  {
    name: "mrid (yaxu)",
    url: "https://github.com/yaxu/mrid.git",
    dest: resolve(sourcesDir, "mrid"),
    sizeHint: "~5-15 MB — mridangam (Indian percussion) samples",
  },
  {
    name: "VCSL (sgossner)",
    url: "https://github.com/sgossner/VCSL.git",
    dest: resolve(sourcesDir, "VCSL"),
    sizeHint: "~1-2 GB — Versilian Community Sample Library (orchestral). Only clone with --with-vcsl.",
    optional: true,
    flag: "--with-vcsl",
  },
]

function clone(repo: RepoSpec, force: boolean): boolean {
  if (existsSync(repo.dest)) {
    if (!force) {
      console.log(`[samples] ${repo.name}: already present, skipping`)
      return true
    }
    console.log(`[samples] ${repo.name}: --force, removing`)
    rmSync(repo.dest, { recursive: true, force: true })
  }
  console.log(`[samples] cloning ${repo.url}`)
  console.log(`          destination: ${repo.dest}`)
  console.log(`          estimate:    ${repo.sizeHint}`)
  try {
    execSync(`git clone --depth 1 --single-branch ${repo.url} "${repo.dest}"`, {
      stdio: "inherit",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    return true
  } catch (e) {
    console.error(`[samples] ${repo.name}: FAILED — ${(e as Error).message}`)
    return false
  }
}

// After cloning, rewrite _base in every JSON manifest to point at a
// local path. Map each known upstream URL prefix to the local mirror.
const BASE_REWRITES: Array<{ remote: string; local: string }> = [
  {
    remote: "https://raw.githubusercontent.com/ritchse/tidal-drum-machines/main/",
    local: "/samples/sources/tidal-drum-machines/",
  },
  {
    remote: "https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/",
    local: "/samples/sources/Dirt-Samples/",
  },
  {
    remote: "https://raw.githubusercontent.com/yaxu/mrid/main/",
    local: "/samples/sources/mrid/",
  },
  {
    remote: "https://raw.githubusercontent.com/sgossner/VCSL/master/",
    local: "/samples/sources/VCSL/",
  },
  {
    remote: "https://raw.githubusercontent.com/felixroos/dough-samples/main/",
    local: "/samples/dough-samples/",
  },
  {
    remote: "https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/",
    local: "/samples/uzu-drumkit/",
  },
]

function rewriteBase(raw: string): { text: string; changed: boolean } {
  let text = raw
  let changed = false
  for (const { remote, local } of BASE_REWRITES) {
    if (text.includes(remote)) {
      text = text.split(remote).join(local)
      changed = true
    }
  }
  return { text, changed }
}

function rewriteManifests(): void {
  const manifestPaths = [
    resolve(target, "dough-samples/tidal-drum-machines.json"),
    resolve(target, "dough-samples/EmuSP12.json"),
    resolve(target, "dough-samples/Dirt-Samples.json"),
    resolve(target, "dough-samples/piano.json"),
    resolve(target, "dough-samples/mridangam.json"),
    resolve(target, "dough-samples/vcsl.json"),
    resolve(target, "uzu-drumkit/strudel.json"),
  ]
  for (const p of manifestPaths) {
    if (!existsSync(p)) {
      console.warn(`[samples] manifest missing: ${p}`)
      continue
    }
    const raw = readFileSync(p, "utf8")
    const { text, changed } = rewriteBase(raw)
    if (changed) {
      writeFileSync(p, text, "utf8")
      console.log(`[samples] rewrote _base in ${p.split("samples/")[1]}`)
    }
  }
}

function main(): void {
  mkdirSync(target, { recursive: true })
  mkdirSync(sourcesDir, { recursive: true })

  const force = process.argv.includes("--force")
  let anyFail = false
  for (const repo of REPOS) {
    if (repo.optional && repo.flag && !process.argv.includes(repo.flag)) {
      console.log(`[samples] ${repo.name}: optional, pass ${repo.flag} to include — skipping`)
      continue
    }
    if (!clone(repo, force)) anyFail = true
  }

  console.log("[samples] rewriting _base URLs → local paths")
  rewriteManifests()

  console.log("[samples] done. contents:")
  try {
    const du = execSync(`du -sh "${target}"/* "${target}"/sources/* 2>/dev/null`, { encoding: "utf8" })
    console.log(du)
  } catch {}

  if (anyFail) process.exitCode = 1
}

main()
