import { randomBytes } from 'node:crypto'
import { type ServerType, serve } from '@hono/node-server'
import pm2 from 'pm2'
import { createApp, type Pm2Call } from '@/app'
import { startTunnel, type TunnelHandle } from '@/tunnel'
import { name as pkgName, version } from '@/version'

export interface StartServerOptions {
    port?: number
    host?: string
    token?: string
    tunnel?: { enabled?: boolean; cfToken?: string }
}

function connectPm2(): Promise<void> {
    return new Promise((resolve, reject) => {
        pm2.connect((err) => (err ? reject(err) : resolve()))
    })
}

// Caller bound to the already-open connection from connectPm2(). No connect/
// disconnect per request, so concurrent requests can't tear down each other's
// connection mid-call. pm2 exposes named methods (no index signature), so the
// dynamic-by-name lookup is cast.
function makePm2Call(): Pm2Call {
    return (method, ...args) =>
        new Promise((resolve, reject) => {
            ;(pm2 as unknown as Record<string, (...a: any[]) => void>)[method](
                ...args,
                (err: Error | null, result: unknown) => (err ? reject(err) : resolve(result))
            )
        })
}

/**
 * Connect to the local PM2 daemon and start the HTTP forwarder.
 */
export async function startServer({
    port = 9616,
    host = '127.0.0.1',
    token,
    tunnel = {},
}: StartServerOptions = {}): Promise<ServerType> {
    await connectPm2()

    // A tunnel makes the API reachable from the internet, so never leave it open:
    // mint a bearer token when one wasn't supplied.
    let activeToken = token
    let generatedToken = false
    if (tunnel.enabled && !activeToken) {
        activeToken = randomBytes(24).toString('base64url')
        generatedToken = true
    }

    const app = createApp({ pm2Call: makePm2Call(), token: activeToken, version })

    const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
        const auth = activeToken ? 'enabled (bearer token)' : 'disabled'
        console.log(`${pkgName} v${version} → http://${info.address}:${info.port}  (auth: ${auth})`)
        if (host === '0.0.0.0' && !activeToken) {
            console.error(
                'WARNING: bound to all interfaces without a token — anyone on your ' +
                    'network can control PM2. Pass --token to require authentication.'
            )
        }
    })

    let tunnelHandle: TunnelHandle | null = null
    if (tunnel.enabled) {
        try {
            tunnelHandle = await startTunnel({ port, cfToken: tunnel.cfToken })
            if (tunnelHandle.mode === 'quick') {
                console.log(
                    tunnelHandle.url
                        ? `Cloudflare tunnel (guest) → ${tunnelHandle.url}`
                        : 'pm2-forwarder: tunnel started but no public URL was received yet.'
                )
            } else {
                console.log(
                    `Cloudflare tunnel (authenticated) ${tunnelHandle.connected ? 'connected' : 'starting'} ` +
                        `— served via your dashboard hostname (origin http://localhost:${port}).`
                )
            }
            if (generatedToken) {
                const base = tunnelHandle.url || `http://127.0.0.1:${port}`
                console.log(
                    `\nAuth token (required on every request — auto-generated):\n  ${activeToken}\n` +
                        `Example:\n  curl -H "Authorization: Bearer ${activeToken}" ${base}/processes\n`
                )
            }
        } catch (err) {
            console.error(
                `pm2-forwarder: failed to start tunnel — ${(err as Error).message}. Continuing to serve locally.`
            )
        }
    }

    let closing = false
    const shutdown = () => {
        if (closing) return
        closing = true
        tunnelHandle?.stop()
        server.close(() => {
            pm2.disconnect()
            process.exit(0)
        })
        // Force exit if the server doesn't close promptly (e.g. a hung socket).
        setTimeout(() => {
            pm2.disconnect()
            process.exit(0)
        }, 2000).unref()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    return server
}
