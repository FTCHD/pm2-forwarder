import { pathToFileURL } from "node:url";

import { startServer } from "./server.js";

export { createApp } from "./app.js";
export { startServer } from "./server.js";

// Auto-start only when this file is run directly (`node src/index.js`). PM2
// modules use src/pm2-module.js (PM2 runs modules through a wrapper, so this
// argv[1] check is false there); library importers get the exports above with
// no server started.
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const isTruthy = (v) =>
    v != null && v !== "" && v !== "0" && String(v).toLowerCase() !== "false";

  const port = Number(
    process.env.PM2_FORWARDER_PORT ?? process.env.PORT ?? 9616,
  );
  const host = process.env.PM2_FORWARDER_HOST || "127.0.0.1";
  const token = process.env.PM2_FORWARDER_TOKEN || undefined;

  const cfToken =
    process.env.CLOUDFLARED_TOKEN || process.env.PM2_FORWARDER_CF_TOKEN || undefined;
  const tunnelEnabled =
    isTruthy(process.env.PM2_FORWARDER_TUNNEL) || isTruthy(cfToken);

  startServer({
    port,
    host,
    token,
    tunnel: { enabled: tunnelEnabled, cfToken },
  }).catch((err) => {
    console.error(`pm2-forwarder: failed to start — ${err.message}`);
    process.exit(1);
  });
}
