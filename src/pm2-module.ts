// Entry point used when installed as a PM2 module (`pm2 install pm2-forwarder`),
// referenced by the package.json `apps` field.
//
// This is separate from index.ts on purpose: PM2 launches modules through a
// wrapper (ProcessContainerFork.js), so `process.argv[1]` is the wrapper, not
// this file. That makes the usual "is this the main module?" check (used in
// index.ts) false under PM2 — so a guarded start would never run and PM2 would
// restart-loop the process forever. This entry just always starts the server,
// reading config from the env vars PM2 injects (package.json `config` + `pm2 set`).
import { startServer } from '@/server'

const truthy = (v: string | undefined) =>
    v != null && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false'

const port = Number(process.env.PM2_FORWARDER_PORT ?? process.env.PORT ?? 9616)
const host = process.env.PM2_FORWARDER_HOST || '127.0.0.1'
const token = process.env.PM2_FORWARDER_TOKEN || undefined
const cfToken = process.env.CLOUDFLARED_TOKEN || process.env.PM2_FORWARDER_CF_TOKEN || undefined

startServer({
    port,
    host,
    token,
    tunnel: {
        enabled: truthy(process.env.PM2_FORWARDER_TUNNEL) || truthy(cfToken),
        cfToken,
    },
}).catch((err: unknown) => {
    console.error((err && (err as Error).stack) || err)
    process.exit(1)
})
