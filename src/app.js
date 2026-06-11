import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import pm2 from "pm2";

import { name as pkgName, version as pkgVersion } from "./version.js";

// Fallback PM2 caller: connects and disconnects around every request. Used when
// createApp() is constructed standalone (e.g. as a library) without a shared
// connection. startServer() injects a faster persistent-connection variant.
function defaultPm2Call(method, ...args) {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) return reject(err);
      pm2[method](...args, (cbErr, result) => {
        pm2.disconnect();
        if (cbErr) return reject(cbErr);
        resolve(result);
      });
    });
  });
}

// PM2 reports a missing process as an error rather than an empty result on the
// control routes; surface that as 404 instead of a generic 500.
function statusForError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("not found") || msg.includes("doesn't exist") ? 404 : 500;
}

/**
 * Build the Hono app exposing PM2 process control over HTTP.
 *
 * @param {object} [options]
 * @param {(method: string, ...args: any[]) => Promise<any>} [options.pm2Call]
 *   Promise-returning PM2 invoker. Defaults to a connect-per-request wrapper.
 * @param {string} [options.token] When set, all routes require
 *   `Authorization: Bearer <token>`.
 * @param {string} [options.version] Version reported by `/` and `/health`.
 * @returns {import("hono").Hono}
 */
export function createApp({
  pm2Call = defaultPm2Call,
  token,
  version = pkgVersion,
} = {}) {
  const app = new Hono();

  if (token) {
    app.use("*", bearerAuth({ token }));
  }

  const info = (c) =>
    c.json({ data: { name: pkgName, version, status: "ok" } });
  app.get("/", info);
  app.get("/health", info);

  app.get("/processes", async (c) => {
    try {
      const list = await pm2Call("list");
      const processes = list.map((p) => ({
        pm_id: p.pm_id,
        name: p.name,
        pid: p.pid,
        status: p.pm2_env.status,
        cpu: p.monit.cpu,
        memory: p.monit.memory,
        uptime: p.pm2_env.pm_uptime,
        restarts: p.pm2_env.restart_time,
        unstable_restarts: p.pm2_env.unstable_restarts,
        exec_mode: p.pm2_env.exec_mode,
        node_version: p.pm2_env.node_version,
        script: p.pm2_env.pm_exec_path,
        created_at: p.pm2_env.created_at,
      }));
      return c.json({ data: processes });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/processes/:id", async (c) => {
    try {
      const id = c.req.param("id");
      // A numeric string is treated as a pm_id; anything else as a name. A
      // process literally named like a number is therefore looked up by id.
      const desc = await pm2Call("describe", isNaN(id) ? id : Number(id));
      if (!desc || desc.length === 0) {
        return c.json({ error: "Process not found" }, 404);
      }
      return c.json({ data: desc[0] });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  const actions = [
    ["restart", "restarted"],
    ["stop", "stopped"],
    ["reload", "reloaded"],
  ];
  for (const [method, message] of actions) {
    app.post(`/processes/:name/${method}`, async (c) => {
      try {
        await pm2Call(method, c.req.param("name"));
        return c.json({ data: { message } });
      } catch (err) {
        return c.json({ error: err.message }, statusForError(err));
      }
    });
  }

  app.delete("/processes/:name", async (c) => {
    try {
      await pm2Call("delete", c.req.param("name"));
      return c.json({ data: { message: "deleted" } });
    } catch (err) {
      return c.json({ error: err.message }, statusForError(err));
    }
  });

  return app;
}
