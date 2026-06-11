import { open } from "node:fs/promises";

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { streamSSE } from "hono/streaming";
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

// Subscribe to PM2's real-time log/event bus. Relies on an existing connection
// (startServer establishes one; the pm2 module is a singleton across imports).
function defaultLaunchBus(cb) {
  return pm2.launchBus(cb);
}

// PM2 reports a missing process as an error rather than an empty result on the
// control routes; surface that as 404 instead of a generic 500.
function statusForError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("not found") || msg.includes("doesn't exist") ? 404 : 500;
}

// Parse an optional JSON request body, tolerating an empty/non-JSON body.
async function readJson(c) {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

// Coerce a query value to an integer within [min, max], or fall back.
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Return the last `maxLines` lines of a file, reading only the tail bytes so
// huge logs don't get loaded whole. Missing files yield an empty array.
async function tailLines(path, maxLines, maxBytes = 256 * 1024) {
  if (!path) return [];
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    // Drop a partial first line when we started mid-file.
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(nl + 1);
    }
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-maxLines);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  } finally {
    await fh?.close();
  }
}

/**
 * Build the Hono app exposing PM2 process control over HTTP.
 *
 * @param {object} [options]
 * @param {(method: string, ...args: any[]) => Promise<any>} [options.pm2Call]
 *   Promise-returning PM2 invoker. Defaults to a connect-per-request wrapper.
 * @param {(cb: (err: Error|null, bus?: any) => void) => any} [options.launchBus]
 *   Opens PM2's log/event bus (used by the SSE stream route).
 * @param {string} [options.token] When set, all routes require
 *   `Authorization: Bearer <token>`.
 * @param {string} [options.version] Version reported by `/` and `/health`.
 * @returns {import("hono").Hono}
 */
export function createApp({
  pm2Call = defaultPm2Call,
  launchBus = defaultLaunchBus,
  token,
  version = pkgVersion,
} = {}) {
  const app = new Hono();

  if (token) {
    app.use("*", bearerAuth({ token }));
  }

  /** GET `/`, `/health` — liveness/service info; does not touch PM2. */
  const info = (c) =>
    c.json({ data: { name: pkgName, version, status: "ok" } });
  app.get("/", info);
  app.get("/health", info);

  /** GET `/summary` — dashboard rollup: PM2 version + process counts by status + total cpu/memory. */
  app.get("/summary", async (c) => {
    try {
      const [list, pm2Version] = await Promise.all([
        pm2Call("list"),
        pm2Call("getVersion").catch(() => null),
      ]);
      const byStatus = {};
      let cpu = 0;
      let memory = 0;
      for (const p of list) {
        const status = p.pm2_env?.status || "unknown";
        byStatus[status] = (byStatus[status] || 0) + 1;
        cpu += p.monit?.cpu || 0;
        memory += p.monit?.memory || 0;
      }
      return c.json({
        data: {
          pm2_version: pm2Version,
          total: list.length,
          online: byStatus.online || 0,
          stopped: byStatus.stopped || 0,
          errored: byStatus.errored || 0,
          by_status: byStatus,
          cpu,
          memory,
        },
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  /** GET `/processes` — list all processes with status, cpu, memory, uptime, restarts. */
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

  /** GET `/processes/:id` — full PM2 description of one process by name or pm_id. */
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

  /**
   * GET `/processes/:id/logs` — tail recent stdout/stderr for one process.
   * Query: `lines` (1–5000, default 200), `type` (`out` | `err` | `all`, default `all`).
   */
  app.get("/processes/:id/logs", async (c) => {
    try {
      const id = c.req.param("id");
      const desc = await pm2Call("describe", isNaN(id) ? id : Number(id));
      if (!desc || desc.length === 0) {
        return c.json({ error: "Process not found" }, 404);
      }
      const env = desc[0].pm2_env || {};
      const lines = clampInt(c.req.query("lines"), 200, 1, 5000);
      const type = (c.req.query("type") || "all").toLowerCase();
      const data = { name: desc[0].name, pm_id: desc[0].pm_id, lines };
      if (type === "out" || type === "all") {
        data.out = await tailLines(env.pm_out_log_path, lines);
      }
      if (type === "err" || type === "all") {
        data.err = await tailLines(env.pm_err_log_path, lines);
      }
      return c.json({ data });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  /**
   * GET `/processes/:id/logs/stream` — live stdout/stderr as Server-Sent Events.
   * Query: `type` (`out` | `err` | `all`, default `all`). Events: `out`/`err`
   * (each `{at,name,pm_id,line}`), `ping` (heartbeat), `error`. By name → every
   * cluster instance; by pm_id → just that one. SSE doesn't work over Cloudflare
   * guest tunnels (use a named tunnel or hit it locally).
   */
  app.get("/processes/:id/logs/stream", async (c) => {
    const id = c.req.param("id");
    let desc;
    try {
      desc = await pm2Call("describe", isNaN(id) ? id : Number(id));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
    if (!desc || desc.length === 0) {
      return c.json({ error: "Process not found" }, 404);
    }

    const byName = isNaN(id);
    const wantName = desc[0].name;
    const wantId = desc[0].pm_id;
    const matches = (proc) =>
      byName ? proc?.name === wantName : proc?.pm_id === wantId;
    const type = (c.req.query("type") || "all").toLowerCase();
    const events =
      type === "out"
        ? ["log:out"]
        : type === "err"
          ? ["log:err"]
          : ["log:out", "log:err"];

    return streamSSE(c, async (stream) => {
      let bus;
      try {
        bus = await new Promise((resolve, reject) =>
          launchBus((err, b) => (err ? reject(err) : resolve(b))),
        );
      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: err.message }),
        });
        return;
      }

      const handlers = events.map((event) => {
        const kind = event === "log:err" ? "err" : "out";
        const handler = (packet) => {
          if (!matches(packet?.process)) return;
          const line =
            typeof packet.data === "string"
              ? packet.data.replace(/\n$/, "")
              : packet.data;
          stream
            .writeSSE({
              event: kind,
              data: JSON.stringify({
                at: packet.at,
                name: packet.process?.name,
                pm_id: packet.process?.pm_id,
                line,
              }),
            })
            .catch(() => {}); // ignore writes after the client disconnects
        };
        bus.on(event, handler);
        return [event, handler];
      });

      const cleanup = () => {
        for (const [event, handler] of handlers) {
          if (typeof bus.off === "function") bus.off(event, handler);
          else bus.removeListener?.(event, handler);
        }
        try {
          bus.close?.();
        } catch {
          // bus already closed
        }
      };
      stream.onAbort(cleanup);

      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ name: wantName, pm_id: wantId, type }),
      });

      // Keep the response open and send a heartbeat; the loop ends when the
      // client disconnects (stream.aborted), which also triggers cleanup.
      let beats = 0;
      while (!stream.aborted) {
        await stream.sleep(15000);
        if (stream.aborted) break;
        await stream.writeSSE({ event: "ping", data: String(++beats) });
      }
      cleanup();
    });
  });

  // POST `/processes/:name/{restart,stop,reload}` — lifecycle control. restart
  // and reload accept an optional `{ "updateEnv": true }` body to re-read env vars.
  const actions = [
    ["restart", "restarted"],
    ["stop", "stopped"],
    ["reload", "reloaded"],
  ];
  for (const [method, message] of actions) {
    /** POST `/processes/:name/${method}` — ${message} the process (`all` targets every process). */
    app.post(`/processes/:name/${method}`, async (c) => {
      try {
        const name = c.req.param("name");
        if (method === "stop") {
          await pm2Call("stop", name);
        } else {
          const body = await readJson(c);
          if (body.updateEnv) await pm2Call(method, name, { updateEnv: true });
          else await pm2Call(method, name);
        }
        return c.json({ data: { message } });
      } catch (err) {
        return c.json({ error: err.message }, statusForError(err));
      }
    });
  }

  /** POST `/processes/:name/scale` — set cluster instance count; body `{ "instances": <int >= 1> }`. */
  app.post("/processes/:name/scale", async (c) => {
    try {
      const body = await readJson(c);
      const instances = Number(body.instances);
      if (!Number.isInteger(instances) || instances < 1) {
        return c.json(
          { error: "Body must include an integer 'instances' >= 1" },
          400,
        );
      }
      await pm2Call("scale", c.req.param("name"), instances);
      return c.json({ data: { message: `scaled to ${instances}` } });
    } catch (err) {
      return c.json({ error: err.message }, statusForError(err));
    }
  });

  /** POST `/processes/:name/signal` — send an OS signal; body `{ "signal": "SIGUSR2" }`. */
  app.post("/processes/:name/signal", async (c) => {
    try {
      const body = await readJson(c);
      const signal = body.signal;
      if (!signal || typeof signal !== "string") {
        return c.json(
          { error: "Body must include a 'signal' string (e.g. SIGUSR2)" },
          400,
        );
      }
      await pm2Call("sendSignalToProcessName", signal, c.req.param("name"));
      return c.json({ data: { message: `sent ${signal}` } });
    } catch (err) {
      return c.json({ error: err.message }, statusForError(err));
    }
  });

  /** POST `/processes/:name/flush` — clear the process's stdout/stderr log files. */
  app.post("/processes/:name/flush", async (c) => {
    try {
      await pm2Call("flush", c.req.param("name"));
      return c.json({ data: { message: "flushed" } });
    } catch (err) {
      return c.json({ error: err.message }, statusForError(err));
    }
  });

  /** POST `/processes/:name/reset` — reset restart counters/metadata for the process. */
  app.post("/processes/:name/reset", async (c) => {
    try {
      await pm2Call("reset", c.req.param("name"));
      return c.json({ data: { message: "reset" } });
    } catch (err) {
      return c.json({ error: err.message }, statusForError(err));
    }
  });

  /** DELETE `/processes/:name` — remove the process from PM2 (`all` targets every process). */
  app.delete("/processes/:name", async (c) => {
    try {
      await pm2Call("delete", c.req.param("name"));
      return c.json({ data: { message: "deleted" } });
    } catch (err) {
      return c.json({ error: err.message }, statusForError(err));
    }
  });

  /** POST `/dump` — persist the current process list so it survives a reboot / `resurrect`. */
  app.post("/dump", async (c) => {
    try {
      await pm2Call("dump", false);
      return c.json({ data: { message: "saved" } });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  /** POST `/resurrect` — restore the process list previously saved by `/dump`. */
  app.post("/resurrect", async (c) => {
    try {
      await pm2Call("resurrect");
      return c.json({ data: { message: "resurrected" } });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return app;
}
