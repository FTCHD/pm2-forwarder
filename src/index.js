import { pathToFileURL } from "node:url";

import { startServer } from "./server.js";

export { createApp } from "./app.js";
export { startServer } from "./server.js";

// When PM2 runs this package as a module (`pm2 install pm2-forwarder`), it
// executes this file as the process entry. Configuration comes from env vars,
// which PM2 populates from the package.json `config` block and `pm2 set`.
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(
    process.env.PM2_FORWARDER_PORT ?? process.env.PORT ?? 9616,
  );
  const host = process.env.PM2_FORWARDER_HOST || "127.0.0.1";
  const token = process.env.PM2_FORWARDER_TOKEN || undefined;

  startServer({ port, host, token }).catch((err) => {
    console.error(`pm2-forwarder: failed to start — ${err.message}`);
    process.exit(1);
  });
}
