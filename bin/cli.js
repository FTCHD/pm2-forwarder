#!/usr/bin/env node
import { parseArgs } from "node:util";

import { startServer } from "../src/server.js";
import { version } from "../src/version.js";

const HELP = `pm2-forwarder v${version}

  REST API over your local PM2 daemon — list, inspect, and control processes.

USAGE
  pm2-forwarder [options]

OPTIONS
  -p, --port <port>    Port to listen on   (env PM2_FORWARDER_PORT, then PORT)  [default: 9616]
  -H, --host <host>    Address to bind     (env PM2_FORWARDER_HOST)             [default: 127.0.0.1]
  -t, --token <token>  Require "Authorization: Bearer <token>" on every route
                       (env PM2_FORWARDER_TOKEN)
  -h, --help           Show this help
  -v, --version        Show version

SECURITY
  Binds to 127.0.0.1 (localhost) by default. Use --host 0.0.0.0 to expose it on
  your network — only do that together with --token, since the API can stop and
  delete processes.

EXAMPLES
  npx pm2-forwarder
  npx pm2-forwarder --port 8080
  npx pm2-forwarder --host 0.0.0.0 --token "$(openssl rand -hex 16)"
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      token: { type: "string", short: "t" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: false,
  }));
} catch (err) {
  fail(`pm2-forwarder: ${err.message}\n\n${HELP}`);
}

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (values.version) {
  console.log(version);
  process.exit(0);
}

// Precedence: CLI flag > PM2_FORWARDER_* env > generic PORT > default.
const portRaw =
  values.port ?? process.env.PM2_FORWARDER_PORT ?? process.env.PORT ?? "9616";
const port = Number(portRaw);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  fail(`pm2-forwarder: invalid port "${portRaw}" (expected an integer 0-65535)`);
}

const host = values.host ?? process.env.PM2_FORWARDER_HOST ?? "127.0.0.1";
const token = values.token ?? process.env.PM2_FORWARDER_TOKEN;

startServer({ port, host, token: token || undefined }).catch((err) => {
  fail(`pm2-forwarder: failed to start — ${err.message}`);
});
