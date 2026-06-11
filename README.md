# pm2-forwarder

A tiny, zero-config REST API that forwards [PM2](https://pm2.keymetrics.io/) process control over HTTP. Point it at your local PM2 daemon and list, inspect, restart, stop, reload, or delete processes with plain HTTP requests.

```bash
npx pm2-forwarder
# pm2-forwarder v0.1.0 → http://127.0.0.1:9616  (auth: disabled)
```

## Quick start

### PM2 plugin (recommended)

Run it as a managed PM2 module — it starts in the background and on boot:

```bash
pm2 install pm2-forwarder
```

### NPX

Run it directly with no install, or install globally for a persistent command:

```bash
npx pm2-forwarder
# or: npm install -g pm2-forwarder && pm2-forwarder
```

### Library

```js
import { createApp, startServer } from "pm2-forwarder";

// Start a server (connects to PM2, installs signal handlers):
await startServer({ port: 9616, host: "127.0.0.1", token: "secret" });

// Or get just the Hono app to mount/test yourself:
const app = createApp({ token: "secret" });
const res = await app.fetch(new Request("http://localhost/health"));
```

## Requirements

- Node.js >= 18
- PM2 installed and running. The forwarder talks to your local PM2 daemon; if the daemon isn't up yet, PM2 starts it automatically on first connect.

## Configuration

Every option has a flag and an environment variable. Precedence is **flag > `PM2_FORWARDER_*` env > generic `PORT` > default**.

| Setting | Flag | Env | Default |
| --- | --- | --- | --- |
| Port | `-p`, `--port` | `PM2_FORWARDER_PORT`, then `PORT` | `9616` |
| Host | `-H`, `--host` | `PM2_FORWARDER_HOST` | `127.0.0.1` |
| Token | `-t`, `--token` | `PM2_FORWARDER_TOKEN` | _(unset → no auth)_ |
| Tunnel | `--tunnel` | `PM2_FORWARDER_TUNNEL` | _(off)_ |
| CF token | `--cf-token` | `CLOUDFLARED_TOKEN`, then `PM2_FORWARDER_CF_TOKEN` | _(unset)_ |

```bash
pm2-forwarder --port 8080
PM2_FORWARDER_PORT=8080 pm2-forwarder
```

When installed as a PM2 module, configure it with `pm2 set` (then restart it):

```bash
pm2 set pm2-forwarder:PM2_FORWARDER_PORT 8080
pm2 set pm2-forwarder:PM2_FORWARDER_TOKEN "$(openssl rand -hex 16)"
pm2 restart pm2-forwarder
```

## Security

The API can **stop and delete** processes and has no auth by default, so:

- It binds to `127.0.0.1` (localhost only) by default. Use `--host 0.0.0.0` to expose it on your network — but only together with `--token`.
- Set a bearer token to require `Authorization: Bearer <token>` on every route:

  ```bash
  pm2-forwarder --token "$(openssl rand -hex 16)"
  ```

- There is no built-in TLS. To reach it over an untrusted network, put it behind a reverse proxy that terminates HTTPS.

## Hosting at home or don't want to expose your ports?

Running PM2 on a box behind your home router, a NAT, or CGNAT — or just don't want to open a port on your firewall? `pm2-forwarder` can reach the public internet for you through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/): an outbound-only connection, so there's **no port forwarding, no inbound firewall rule, and no public IP required**. The `cloudflared` binary is fetched automatically on first use.

> Because a tunnel makes the process-control API reachable publicly, **if you enable a tunnel without `--token`, a random bearer token is generated, required, and printed** — so the public URL is never left open. Pass your own `--token` to choose it.

**Guest tunnel** — no Cloudflare account, gives an ephemeral `https://<random>.trycloudflare.com` URL:

```bash
pm2-forwarder --tunnel
# Cloudflare tunnel (guest) → https://abc-def-ghi.trycloudflare.com
# Auth token (required on every request — auto-generated):
#   <printed token>
```

**Authenticated named tunnel** — pass a Cloudflare tunnel token (same one you'd use with `cloudflared tunnel run --token`):

```bash
pm2-forwarder --cf-token "$CLOUDFLARED_TOKEN"
# or: CLOUDFLARED_TOKEN=... pm2-forwarder
```

For a named tunnel the public hostname → origin mapping lives in the Cloudflare Zero Trust dashboard; point its ingress at `http://localhost:9616` (or whatever `--port` you use). A CF token implies `--tunnel`, so you don't need both.

Live log streaming (`GET /processes/:id/logs/stream`, SSE) works locally and over **named** tunnels, but not over guest `trycloudflare.com` tunnels, which don't support Server-Sent Events.

## API

All responses are JSON: `{ "data": ... }` on success, `{ "error": "..." }` on failure. Examples assume the default `http://127.0.0.1:9616`.

```bash
# Liveness — does not touch PM2
curl http://127.0.0.1:9616/health

# Dashboard rollup — counts by status, total cpu/memory, pm2 version
curl http://127.0.0.1:9616/summary

# List all processes
curl http://127.0.0.1:9616/processes

# Describe one process (by name or pm_id)
curl http://127.0.0.1:9616/processes/api
curl http://127.0.0.1:9616/processes/0

# Tail logs (last 200 lines of stdout+stderr by default)
curl "http://127.0.0.1:9616/processes/api/logs?lines=100&type=err"

# Stream logs live as Server-Sent Events (Ctrl-C to stop)
curl -N "http://127.0.0.1:9616/processes/api/logs/stream"

# Control a process
curl -X POST   http://127.0.0.1:9616/processes/api/restart
curl -X POST   http://127.0.0.1:9616/processes/api/stop
curl -X POST   http://127.0.0.1:9616/processes/api/reload
curl -X DELETE http://127.0.0.1:9616/processes/api

# Restart re-reading environment variables
curl -X POST http://127.0.0.1:9616/processes/api/restart \
  -H 'content-type: application/json' -d '{"updateEnv":true}'

# Scale a cluster app, send a signal, flush logs, reset counters
curl -X POST http://127.0.0.1:9616/processes/api/scale  -H 'content-type: application/json' -d '{"instances":4}'
curl -X POST http://127.0.0.1:9616/processes/api/signal -H 'content-type: application/json' -d '{"signal":"SIGUSR2"}'
curl -X POST http://127.0.0.1:9616/processes/api/flush
curl -X POST http://127.0.0.1:9616/processes/api/reset

# Save the current process list / restore it later (survives reboot)
curl -X POST http://127.0.0.1:9616/dump
curl -X POST http://127.0.0.1:9616/resurrect

# Apply any action to every process with the "all" target
curl -X POST http://127.0.0.1:9616/processes/all/restart

# With auth enabled (--token secret123)
curl -H "Authorization: Bearer secret123" http://127.0.0.1:9616/processes
```

| Method | Path | Description | Codes |
| --- | --- | --- | --- |
| GET | `/` and `/health` | Service info / liveness | 200 |
| GET | `/summary` | Counts by status, total cpu/memory, pm2 version | 200, 500 |
| GET | `/processes` | List processes with status, cpu, memory, uptime, restarts | 200, 500 |
| GET | `/processes/:id` | Describe one process by name or `pm_id` | 200, 404, 500 |
| GET | `/processes/:id/logs` | Tail stdout/stderr — `?lines=` (1–5000), `?type=out\|err\|all` | 200, 404, 500 |
| GET | `/processes/:id/logs/stream` | Live logs via SSE — `?type=out\|err\|all`; events `out`/`err`/`ping` | 200, 404, 500 |
| POST | `/processes/:name/restart` | Restart — optional body `{"updateEnv":true}` | 200, 404, 500 |
| POST | `/processes/:name/stop` | Stop | 200, 404, 500 |
| POST | `/processes/:name/reload` | Reload (zero-downtime) — optional `{"updateEnv":true}` | 200, 404, 500 |
| POST | `/processes/:name/scale` | Scale a cluster app — body `{"instances":<int>}` | 200, 400, 404, 500 |
| POST | `/processes/:name/signal` | Send a signal — body `{"signal":"SIGUSR2"}` | 200, 400, 404, 500 |
| POST | `/processes/:name/flush` | Clear the process's log files | 200, 404, 500 |
| POST | `/processes/:name/reset` | Reset restart counters/metadata | 200, 404, 500 |
| DELETE | `/processes/:name` | Delete from PM2 | 200, 404, 500 |
| POST | `/dump` | Save the process list (persists across reboot) | 200, 500 |
| POST | `/resurrect` | Restore the process list saved by `/dump` | 200, 500 |

The `:name` control routes also accept `all` to target every process (e.g. `POST /processes/all/restart`). When a token is configured, any request without a valid `Authorization: Bearer <token>` header gets `401`.

## License

MIT
