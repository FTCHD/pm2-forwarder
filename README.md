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

## API

All responses are JSON: `{ "data": ... }` on success, `{ "error": "..." }` on failure. Examples assume the default `http://127.0.0.1:9616`.

```bash
# Liveness — does not touch PM2
curl http://127.0.0.1:9616/health

# List all processes
curl http://127.0.0.1:9616/processes

# Describe one process (by name or pm_id)
curl http://127.0.0.1:9616/processes/api
curl http://127.0.0.1:9616/processes/0

# Control a process
curl -X POST   http://127.0.0.1:9616/processes/api/restart
curl -X POST   http://127.0.0.1:9616/processes/api/stop
curl -X POST   http://127.0.0.1:9616/processes/api/reload
curl -X DELETE http://127.0.0.1:9616/processes/api

# With auth enabled (--token secret123)
curl -H "Authorization: Bearer secret123" http://127.0.0.1:9616/processes
```

| Method | Path | Description | Codes |
| --- | --- | --- | --- |
| GET | `/` and `/health` | Service info / liveness | 200 |
| GET | `/processes` | List processes with status, cpu, memory, uptime, restarts | 200, 500 |
| GET | `/processes/:id` | Describe one process by name or `pm_id` | 200, 404, 500 |
| POST | `/processes/:name/restart` | Restart | 200, 404, 500 |
| POST | `/processes/:name/stop` | Stop | 200, 404, 500 |
| POST | `/processes/:name/reload` | Reload (zero-downtime) | 200, 404, 500 |
| DELETE | `/processes/:name` | Delete from PM2 | 200, 404, 500 |

When a token is configured, any request without a valid `Authorization: Bearer <token>` header gets `401`.

## License

MIT
