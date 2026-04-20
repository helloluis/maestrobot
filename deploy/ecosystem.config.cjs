// PM2 ecosystem for maestrobot.
//
// One process per persona. Each runs the tick loop — listen to the
// apoc feed, react, murmur, remix — at the persona's own cadence from
// the DB. Crash loops get capped by PM2 at `max_restarts`.
//
// Usage on the VPS:
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save                    # persist for reboot
//   pm2 logs maestrobot-plum-sibelius
//   pm2 restart maestrobot-plum-sibelius
//
// Add a new persona: import its JSON (pnpm persona:import) THEN add a
// matching apps block here and `pm2 reload deploy/ecosystem.config.cjs`.

const path = require("node:path")

function persona(callSign) {
  return {
    name: `maestrobot-${callSign}`,
    cwd: path.resolve(__dirname, ".."),
    script: "pnpm",
    args: ["agent:run", callSign],
    // PNPM/tsx is long-running by design. If it exits, PM2 restarts.
    autorestart: true,
    max_restarts: 10,
    min_uptime: "60s",
    restart_delay: 10_000,
    // Keep logs locally (PM2 default at ~/.pm2/logs). Rotate with
    // pm2-logrotate if volume becomes an issue.
    out_file: `~/.pm2/logs/${callSign}-out.log`,
    error_file: `~/.pm2/logs/${callSign}-err.log`,
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: "production",
    },
  }
}

module.exports = {
  apps: [
    persona("plum-sibelius"),
    persona("peach-chopin"),
  ],
}
