import { open } from "node:fs/promises";

import { Hono } from "hono";
import type { Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { streamSSE } from "hono/streaming";
import { validator } from "hono/validator";
import pm2 from "pm2";

import { name as pkgName, version as pkgVersion } from "./version";

export type Pm2Call = (method: string, ...args: any[]) => Promise<any>;
export type LaunchBus = (cb: (err: Error | null, bus?: any) => void) => unknown;

export interface CreateAppOptions {
  /** Promise-returning PM2 invoker. Defaults to a connect-per-request wrapper. */
  pm2Call?: Pm2Call;
  /** Opens PM2's log/event bus (used by the SSE stream route). */
  launchBus?: LaunchBus;
  /** When set, all routes require `Authorization: Bearer <token>`. */
  token?: string;
  /** Version reported by `/` and `/health`. */
  version?: string;
}

interface ServiceInfo {
  name: string;
  version: string;
  status: string;
}
interface Summary {
  pm2_version: string | null;
  total: number;
  online: number;
  stopped: number;
  errored: number;
  by_status: Record<string, number>;
  cpu: number;
  memory: number;
}
interface ProcessInfo {
  pm_id: number;
  name: string;
  pid: number;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
  unstable_restarts: number;
  exec_mode: string;
  node_version: string;
  script: string;
  created_at: number;
}
interface Logs {
  name: string;
  pm_id: number;
  lines: number;
  out?: string[];
  err?: string[];
}

// Fallback PM2 caller: connects and disconnects around every request. Used when
// createApp() is constructed standalone (e.g. as a library) without a shared
// connection. startServer() injects a faster persistent-connection variant.
function defaultPm2Call(method: string, ...args: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) return reject(err);
      // pm2 exposes named methods (no index signature); this control call is
      // dispatched dynamically by name, so only the lookup is cast.
      (pm2 as unknown as Record<string, (...a: any[]) => void>)[method](
        ...args,
        (cbErr: Error | null, result: unknown) => {
          pm2.disconnect();
          if (cbErr) return reject(cbErr);
          resolve(result);
        },
      );
    });
  });
}

// Subscribe to PM2's real-time log/event bus. Relies on an existing connection
// (startServer establishes one; the pm2 module is a singleton across imports).
function defaultLaunchBus(cb: (err: Error | null, bus?: any) => void) {
  return pm2.launchBus(cb);
}

// PM2 reports a missing process as an error rather than an empty result on the
// control routes; surface that as 404 instead of a generic 500.
function statusForError(err: unknown): 404 | 500 {
  const msg = String((err as Error | undefined)?.message || "").toLowerCase();
  return msg.includes("not found") || msg.includes("doesn't exist") ? 404 : 500;
}

// Parse an optional JSON request body, tolerating an empty/non-JSON body.
async function readJson(c: Context): Promise<Record<string, any>> {
  try {
    return ((await c.req.json()) as Record<string, any>) ?? {};
  } catch {
    return {};
  }
}

// Coerce a query value to an integer within [min, max], or fall back.
function clampInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Return the last `maxLines` lines of a file, reading only the tail bytes so
// huge logs don't get loaded whole. Missing files yield an empty array.
async function tailLines(
  path: string | undefined,
  maxLines: number,
  maxBytes = 256 * 1024,
): Promise<string[]> {
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  } finally {
    await fh?.close();
  }
}

/**
 * Build the Hono app exposing PM2 process control over HTTP. Routes are chained
 * into a single expression so `AppType` (= the return type) carries the full RPC
 * schema for typed `hc<AppType>()` clients.
 */
export function createApp({
  pm2Call = defaultPm2Call,
  launchBus = defaultLaunchBus,
  token,
  version = pkgVersion,
}: CreateAppOptions = {}) {
  const app = new Hono();

  if (token) {
    app.use("*", bearerAuth({ token }));
  }

  const serviceInfo = (): ServiceInfo => ({
    name: pkgName,
    version,
    status: "ok",
  });

  const routes = app
    // GET `/`, `/health` — liveness/service info; does not touch PM2.
    .get("/", (c) => c.json({ data: serviceInfo() }))
    .get("/health", (c) => c.json({ data: serviceInfo() }))
    // GET `/summary` — PM2 version + process counts by status + total cpu/memory.
    .get("/summary", async (c) => {
      try {
        const [list, pm2Version] = await Promise.all([
          pm2Call("list"),
          pm2Call("getVersion").catch(() => null),
        ]);
        const byStatus: Record<string, number> = {};
        let cpu = 0;
        let memory = 0;
        for (const p of list) {
          const status = p.pm2_env?.status || "unknown";
          byStatus[status] = (byStatus[status] || 0) + 1;
          cpu += p.monit?.cpu || 0;
          memory += p.monit?.memory || 0;
        }
        const data: Summary = {
          pm2_version: pm2Version,
          total: list.length,
          online: byStatus.online || 0,
          stopped: byStatus.stopped || 0,
          errored: byStatus.errored || 0,
          by_status: byStatus,
          cpu,
          memory,
        };
        return c.json({ data });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
    })
    // GET `/processes` — list all processes with status, cpu, memory, uptime, restarts.
    .get("/processes", async (c) => {
      try {
        const list = await pm2Call("list");
        const processes: ProcessInfo[] = list.map((p: any) => ({
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
        return c.json({ error: (err as Error).message }, 500);
      }
    })
    // GET `/processes/:id` — full PM2 description of one process by name or pm_id.
    .get("/processes/:id", async (c) => {
      try {
        const id = c.req.param("id");
        // A numeric string is treated as a pm_id; anything else as a name.
        const desc = await pm2Call(
          "describe",
          isNaN(Number(id)) ? id : Number(id),
        );
        if (!desc || desc.length === 0) {
          return c.json({ error: "Process not found" }, 404);
        }
        return c.json({ data: desc[0] as Record<string, unknown> });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
    })
    // GET `/processes/:id/logs` — tail recent stdout/stderr for one process.
    // Query: `lines` (1–5000, default 200), `type` (`out` | `err` | `all`, default `all`).
    .get(
      "/processes/:id/logs",
      validator("query", (value) => {
        const raw = value as Record<string, string | string[] | undefined>;
        const out: { lines?: string; type?: "out" | "err" | "all" } = {};
        if (typeof raw.lines === "string") out.lines = raw.lines;
        // Narrow the client to the known values. An empty value means "unset"
        // (→ all, as the JS `query("type") || "all"` did); any other out-of-range
        // `type` passes through and yields empty logs below, also matching the JS.
        if (typeof raw.type === "string" && raw.type !== "") {
          out.type = raw.type.toLowerCase() as "out" | "err" | "all";
        }
        return out;
      }),
      async (c) => {
        try {
          const id = c.req.param("id");
          const desc = await pm2Call(
            "describe",
            isNaN(Number(id)) ? id : Number(id),
          );
          if (!desc || desc.length === 0) {
            return c.json({ error: "Process not found" }, 404);
          }
          const env = desc[0].pm2_env || {};
          const q = c.req.valid("query");
          const lines = clampInt(q.lines, 200, 1, 5000);
          const type = q.type ?? "all";
          const data: Logs = { name: desc[0].name, pm_id: desc[0].pm_id, lines };
          if (type === "out" || type === "all") {
            data.out = await tailLines(env.pm_out_log_path, lines);
          }
          if (type === "err" || type === "all") {
            data.err = await tailLines(env.pm_err_log_path, lines);
          }
          return c.json({ data });
        } catch (err) {
          return c.json({ error: (err as Error).message }, 500);
        }
      },
    )
    // GET `/processes/:id/logs/stream` — live stdout/stderr as Server-Sent Events.
    .get("/processes/:id/logs/stream", async (c) => {
      const id = c.req.param("id");
      let desc: any;
      try {
        desc = await pm2Call("describe", isNaN(Number(id)) ? id : Number(id));
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
      if (!desc || desc.length === 0) {
        return c.json({ error: "Process not found" }, 404);
      }

      const byName = isNaN(Number(id));
      const wantName = desc[0].name;
      const wantId = desc[0].pm_id;
      const matches = (proc: any) =>
        byName ? proc?.name === wantName : proc?.pm_id === wantId;
      const type = (c.req.query("type") || "all").toLowerCase();
      const events =
        type === "out"
          ? ["log:out"]
          : type === "err"
            ? ["log:err"]
            : ["log:out", "log:err"];

      return streamSSE(c, async (stream) => {
        let bus: any;
        try {
          bus = await new Promise<any>((resolve, reject) =>
            launchBus((err, b) => (err ? reject(err) : resolve(b))),
          );
        } catch (err) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: (err as Error).message }),
          });
          return;
        }

        const handlers = events.map((event) => {
          const kind = event === "log:err" ? "err" : "out";
          const handler = (packet: any) => {
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
          return [event, handler] as const;
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
    })
    // POST `/processes/:name/restart` — restart; optional `{ "updateEnv": true }`.
    .post("/processes/:name/restart", async (c) => {
      try {
        const name = c.req.param("name");
        const body = await readJson(c);
        if (body.updateEnv) await pm2Call("restart", name, { updateEnv: true });
        else await pm2Call("restart", name);
        return c.json({ data: { message: "restarted" } });
      } catch (err) {
        return c.json({ error: (err as Error).message }, statusForError(err));
      }
    })
    // POST `/processes/:name/stop` — stop the process.
    .post("/processes/:name/stop", async (c) => {
      try {
        await pm2Call("stop", c.req.param("name"));
        return c.json({ data: { message: "stopped" } });
      } catch (err) {
        return c.json({ error: (err as Error).message }, statusForError(err));
      }
    })
    // POST `/processes/:name/reload` — reload; optional `{ "updateEnv": true }`.
    .post("/processes/:name/reload", async (c) => {
      try {
        const name = c.req.param("name");
        const body = await readJson(c);
        if (body.updateEnv) await pm2Call("reload", name, { updateEnv: true });
        else await pm2Call("reload", name);
        return c.json({ data: { message: "reloaded" } });
      } catch (err) {
        return c.json({ error: (err as Error).message }, statusForError(err));
      }
    })
    // POST `/processes/:name/scale` — set cluster instance count; body `{ instances }`.
    .post(
      "/processes/:name/scale",
      validator("json", (value, c) => {
        const instances = Number(((value ?? {}) as { instances?: unknown }).instances);
        if (!Number.isInteger(instances) || instances < 1) {
          return c.json(
            { error: "Body must include an integer 'instances' >= 1" },
            400,
          );
        }
        return { instances };
      }),
      async (c) => {
        try {
          const { instances } = c.req.valid("json");
          await pm2Call("scale", c.req.param("name"), instances);
          return c.json({ data: { message: `scaled to ${instances}` } });
        } catch (err) {
          return c.json({ error: (err as Error).message }, statusForError(err));
        }
      },
    )
    // POST `/processes/:name/signal` — send an OS signal; body `{ signal }`.
    .post(
      "/processes/:name/signal",
      validator("json", (value, c) => {
        const signal = ((value ?? {}) as { signal?: unknown }).signal;
        if (!signal || typeof signal !== "string") {
          return c.json(
            { error: "Body must include a 'signal' string (e.g. SIGUSR2)" },
            400,
          );
        }
        return { signal };
      }),
      async (c) => {
        try {
          const { signal } = c.req.valid("json");
          await pm2Call("sendSignalToProcessName", signal, c.req.param("name"));
          return c.json({ data: { message: `sent ${signal}` } });
        } catch (err) {
          return c.json({ error: (err as Error).message }, statusForError(err));
        }
      },
    )
    // POST `/processes/:name/flush` — clear the process's log files.
    .post("/processes/:name/flush", async (c) => {
      try {
        await pm2Call("flush", c.req.param("name"));
        return c.json({ data: { message: "flushed" } });
      } catch (err) {
        return c.json({ error: (err as Error).message }, statusForError(err));
      }
    })
    // POST `/processes/:name/reset` — reset restart counters/metadata.
    .post("/processes/:name/reset", async (c) => {
      try {
        await pm2Call("reset", c.req.param("name"));
        return c.json({ data: { message: "reset" } });
      } catch (err) {
        return c.json({ error: (err as Error).message }, statusForError(err));
      }
    })
    // DELETE `/processes/:name` — remove the process from PM2.
    .delete("/processes/:name", async (c) => {
      try {
        await pm2Call("delete", c.req.param("name"));
        return c.json({ data: { message: "deleted" } });
      } catch (err) {
        return c.json({ error: (err as Error).message }, statusForError(err));
      }
    })
    // POST `/dump` — persist the current process list (survives reboot / resurrect).
    .post("/dump", async (c) => {
      try {
        await pm2Call("dump", false);
        return c.json({ data: { message: "saved" } });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
    })
    // POST `/resurrect` — restore the process list previously saved by `/dump`.
    .post("/resurrect", async (c) => {
      try {
        await pm2Call("resurrect");
        return c.json({ data: { message: "resurrected" } });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
    });

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
