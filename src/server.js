import { serve } from "@hono/node-server";
import pm2 from "pm2";

import { createApp } from "./app.js";
import { name as pkgName, version } from "./version.js";

function connectPm2() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => (err ? reject(err) : resolve()));
  });
}

// Caller bound to the already-open connection from connectPm2(). No connect/
// disconnect per request, so concurrent requests can't tear down each other's
// connection mid-call.
function makePm2Call() {
  return (method, ...args) =>
    new Promise((resolve, reject) => {
      pm2[method](...args, (err, result) =>
        err ? reject(err) : resolve(result),
      );
    });
}

/**
 * Connect to the local PM2 daemon and start the HTTP forwarder.
 *
 * @param {object} [options]
 * @param {number} [options.port=9616]
 * @param {string} [options.host="127.0.0.1"]
 * @param {string} [options.token] Optional bearer token required on every route.
 * @returns {Promise<import("@hono/node-server").ServerType>}
 */
export async function startServer({
  port = 9616,
  host = "127.0.0.1",
  token,
} = {}) {
  await connectPm2();

  const app = createApp({ pm2Call: makePm2Call(), token, version });

  const server = serve(
    { fetch: app.fetch, port, hostname: host },
    (info) => {
      const auth = token ? "enabled (bearer token)" : "disabled";
      console.log(
        `${pkgName} v${version} → http://${info.address}:${info.port}  (auth: ${auth})`,
      );
      if (host === "0.0.0.0" && !token) {
        console.error(
          "WARNING: bound to all interfaces without a token — anyone on your " +
            "network can control PM2. Pass --token to require authentication.",
        );
      }
    },
  );

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      pm2.disconnect();
      process.exit(0);
    });
    // Force exit if the server doesn't close promptly (e.g. a hung socket).
    setTimeout(() => {
      pm2.disconnect();
      process.exit(0);
    }, 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}
