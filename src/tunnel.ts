import { existsSync } from "node:fs";

export interface TunnelHandle {
  url: string | null;
  mode: "quick" | "named";
  connected: boolean;
  stop: () => void;
}

// Resolve the first of `successEvent` (returning its value) or end early on
// `exit`/`error`/timeout (returning null). Avoids hanging when cloudflared dies
// before it ever emits a URL or connection. The tunnel is an EventEmitter whose
// per-event listener types don't unify here, so it's typed loosely.
function waitFor(
  // biome-ignore lint/suspicious/noExplicitAny: event-emitter glue
  tunnel: any,
  successEvent: "url" | "connected",
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve) => {
    const finish = (value: unknown) => {
      clearTimeout(timer);
      tunnel.off(successEvent, onSuccess);
      tunnel.off("exit", onEnd);
      tunnel.off("error", onEnd);
      resolve(value);
    };
    const onSuccess = (value: unknown) => finish(value);
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    tunnel.once(successEvent, onSuccess);
    tunnel.once("exit", onEnd);
    tunnel.once("error", onEnd);
  });
}

/**
 * Start a Cloudflare tunnel to the local forwarder.
 *
 * - No token  → quick/guest tunnel (ephemeral `*.trycloudflare.com` URL).
 * - With token → authenticated named tunnel; its public hostname → origin mapping
 *   is configured in the Cloudflare Zero Trust dashboard (point it at
 *   `http://localhost:<port>`). `--url` cannot be combined with `--token`.
 */
export async function startTunnel({
  port,
  cfToken,
}: {
  port: number;
  cfToken?: string;
}): Promise<TunnelHandle> {
  const { Tunnel, bin, install } = await import("cloudflared");

  // The npm package downloads the binary in a postinstall, but that can be
  // skipped (e.g. `npm install --ignore-scripts`). Fetch it on demand.
  if (!existsSync(bin)) {
    console.error(
      "pm2-forwarder: downloading the cloudflared binary (first run)…",
    );
    await install(bin);
  }

  const mode: "quick" | "named" = cfToken ? "named" : "quick";
  const tunnel = cfToken
    ? Tunnel.withToken(cfToken, { "--no-autoupdate": true })
    : Tunnel.quick(`http://127.0.0.1:${port}`, { "--no-autoupdate": true });

  tunnel.on("error", (err) => {
    console.error(`pm2-forwarder: cloudflared error — ${err.message}`);
  });
  tunnel.on("exit", (code, signal) => {
    if (code) {
      console.error(
        `pm2-forwarder: cloudflared exited (code ${code}${signal ? `, ${signal}` : ""}).`,
      );
    }
  });

  // Guest tunnels advertise a public URL; named tunnels do not (the hostname
  // lives in the dashboard), so only wait on the URL for quick mode.
  const url =
    mode === "quick"
      ? ((await waitFor(tunnel, "url", 30_000)) as string | null)
      : null;
  const connection = await waitFor(tunnel, "connected", 30_000);

  return {
    url,
    mode,
    connected: Boolean(connection),
    stop: () => {
      try {
        tunnel.stop();
      } catch {
        // already stopped
      }
    },
  };
}
