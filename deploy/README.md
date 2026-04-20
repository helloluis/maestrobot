# maestrobot — Vultr deployment

Process supervision via PM2, git-pull deploy model. Same shape as beaniebot, tuned for maestrobot's needs (one PM2 process per persona, SQLite on local disk, daily backups optional).

## Prerequisites on a fresh Vultr VPS (Ubuntu 24.04)

Run these as root, once, for a new box.

```bash
# base deps
apt update && apt install -y git build-essential curl
# node 22 LTS (matches our engines field)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
# pnpm + pm2
npm i -g pnpm@9 pm2

# unprivileged user to run the agents
useradd -m -s /bin/bash maestrobot
sudo -u maestrobot -i

# clone
git clone https://github.com/helloluis/maestrobot.git ~/maestrobot
cd ~/maestrobot
pnpm install

# fill in provider keys + apoc URLs
cp .env.example .env
$EDITOR .env

# seed DB from JSON (one row per persona in agents/*.json)
pnpm setup

# optional — fetch ~1 GB of sample banks if you plan to run the studio remotely
# pnpm samples:fetch

# boot the tick loops
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup   # emits a systemd cmd to paste as root — persists PM2 across reboots
```

## Redeploys

```bash
ssh maestrobot@<vps>
cd ~/maestrobot
git pull
pnpm install          # no-op if lockfile unchanged
pnpm setup            # idempotent — re-imports JSON if agents changed
pm2 reload deploy/ecosystem.config.cjs
```

For the typical prompt/persona tweak flow:

1. Edit `agents/<callSign>.json` locally.
2. `git commit && git push`.
3. On the VPS: `git pull && pnpm setup && pm2 restart maestrobot-<callSign>`.

## Secrets layout

On the VPS, `.env` lives at `/home/maestrobot/maestrobot/.env`, owned by the `maestrobot` user (`chmod 600`). Provider API keys and the apoc URLs are here. **Never commit this file.**

Per-persona Nostr privkeys live inside SQLite (`personas.nostr_sk`), generated on first publish, stored in `~/maestrobot/maestrobot.db`. The file is owned by `maestrobot`; don't back it up to anywhere that'd leak the keys. An encryption-at-rest pass is a legitimate follow-up — see notes in `feedback_persona_naming.md` and apoc's own task 380.

## Monitoring

```bash
pm2 list                              # status of all persona processes
pm2 logs maestrobot-plum-sibelius     # tail one persona's logs
pm2 monit                             # top-like live view
```

Agent decisions are also journalled to `./journal/<callSign>.ndjson`. Useful for post-hoc Bradley-Terry analysis of pairwise preferences.

## Resource sizing

- **Minimal**: 1 vCPU, 1 GB RAM ($6/mo Vultr "Cloud Compute"). Fine for 2-3 personas ticking every 3 minutes. Keep `pnpm samples:fetch` off — samples are only needed for the studio UI.
- **Comfortable**: 2 vCPU, 2 GB RAM. Room for the studio + 4-5 personas + occasional fresh compose (LLM calls are I/O-bound but spikes happen).
- **Studio-on-VPS**: if you want the studio reachable remotely, either (a) ssh port-forward `ssh -L 5173:localhost:5173 maestrobot@vps` and run `pnpm studio` on the VPS temporarily, or (b) put nginx in front of a production Vite build. MVP is (a).

## Backups

SQLite file + journal NDJSON are the only mutable state worth keeping:

```bash
# simple daily snapshot, rotated weekly
0 4 * * * cd /home/maestrobot/maestrobot && \
  cp maestrobot.db /home/maestrobot/backups/maestrobot-$(date +\%F).db && \
  find /home/maestrobot/backups -name 'maestrobot-*.db' -mtime +7 -delete
```

Offsite sync is a good idea; rclone to an S3 bucket or Backblaze B2 is the usual move. Remember: the file contains Nostr privkeys — encrypt at rest on the backup target.
