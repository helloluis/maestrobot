-- maestrobot schema. Applied once on Db open if tables don't exist.
-- Bump schema_version when making changes; no auto-migration yet —
-- the expected workflow at this stage is to blow the file away on
-- breaking changes.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id                        TEXT PRIMARY KEY,
  call_sign                 TEXT UNIQUE NOT NULL,
  display_name              TEXT NOT NULL,
  bio                       TEXT,
  avatar_url                TEXT,
  style_prompt              TEXT NOT NULL,
  taste_loves               TEXT NOT NULL,
  taste_hates               TEXT NOT NULL,
  cadence_tick_every_sec    INTEGER NOT NULL DEFAULT 180,
  cadence_active_start      INTEGER,
  cadence_active_end        INTEGER,
  appetite_remix_prob       REAL NOT NULL DEFAULT 0.3,
  appetite_react_prob       REAL NOT NULL DEFAULT 0.6,
  appetite_murmur_prob      REAL NOT NULL DEFAULT 0.4,
  affinities_json           TEXT NOT NULL DEFAULT '[]',
  budget_daily_usd_cap      REAL,
  budget_daily_token_cap    INTEGER,
  nostr_sk                  TEXT,
  journal_enabled           INTEGER NOT NULL DEFAULT 1,
  apoc_agent_id             TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- role values: plan | plan_cleanup | compose | judge | murmur. Validation
-- lives in the app (persona-loader) so new roles can be added without
-- schema rebuilds.
CREATE TABLE IF NOT EXISTS persona_drivers (
  persona_id   TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  temperature  REAL,
  max_tokens   INTEGER,
  PRIMARY KEY (persona_id, role)
);

CREATE TABLE IF NOT EXISTS stems (
  id                  TEXT PRIMARY KEY,
  persona_id          TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  parent_stem_id      TEXT,
  parent_apoc_stem_id TEXT,
  title               TEXT,
  plan                TEXT,
  spec_json           TEXT,
  code                TEXT,
  error               TEXT,
  plan_model          TEXT,
  plan_cost_usd       REAL,
  compose_model       TEXT,
  compose_cost_usd    REAL,
  apoc_stem_id        TEXT,
  published_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stems_persona ON stems(persona_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stems_parent  ON stems(parent_stem_id);

CREATE TABLE IF NOT EXISTS preferences (
  id            TEXT PRIMARY KEY,
  persona_id    TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  stem_a_id     TEXT NOT NULL,
  stem_b_id     TEXT NOT NULL,
  preferred     TEXT NOT NULL CHECK (preferred IN ('a', 'b', 'tie')),
  reasoning     TEXT,
  judge_model   TEXT,
  cost_usd      REAL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_preferences_persona ON preferences(persona_id, created_at DESC);

CREATE TABLE IF NOT EXISTS murmurs (
  id                TEXT PRIMARY KEY,
  persona_id        TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  subject_stem_id   TEXT,
  pair_a_id         TEXT,
  pair_b_id         TEXT,
  preference_id     TEXT REFERENCES preferences(id) ON DELETE SET NULL,
  murmur_model      TEXT,
  cost_usd          REAL,
  nostr_event_id    TEXT,
  published_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_murmurs_persona ON murmurs(persona_id, created_at DESC);
