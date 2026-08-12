import { existsSync } from 'node:fs'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Express } from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { createAuthSession } from './authMiddleware.js'
import { createCodexBridgeMiddleware } from './codexAppServerBridge.js'
import { createLocalHttpRouteMiddleware } from './localHttpRoutes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '..', 'dist')
const spaEntryFile = join(distDir, 'index.html')

export type ServerOptions = {
  password?: string
}

export type ServerInstance = {
  app: Express
  dispose: () => void
  attachWebSocket: (server: HttpServer) => void
}

function renderFrontendMissingHtml(message: string, details?: string[]): string {
  const lines = details && details.length > 0 ? `<pre>${details.join('\n')}</pre>` : ''
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Codex Web UI Error</title></head>',
    '<body>',
    `<h1>${message}</h1>`,
    lines,
    '<p>Redirecting to chat in 3 seconds...</p>',
    '<p><a href="/">Back to chat</a></p>',
    '<script>',
    'setTimeout(() => { window.location.assign("/") }, 3000)',
    '</script>',
    '</body>',
    '</html>',
  ].join('')
}

export function createServer(options: ServerOptions = {}): ServerInstance {
  const app = express()
  const bridge = createCodexBridgeMiddleware()
  const authSession = options.password ? createAuthSession(options.password) : null

  if (authSession) app.use(authSession.middleware)
  app.use(bridge)
  app.use(createLocalHttpRouteMiddleware())

  const hasFrontendAssets = existsSync(spaEntryFile)
  if (hasFrontendAssets) app.use(express.static(distDir))

  app.use((_req, res) => {
    if (!hasFrontendAssets) {
      res
        .status(503)
        .type('text/html; charset=utf-8')
        .send(
          renderFrontendMissingHtml('Codex web UI assets are missing.', [
            `Expected: ${spaEntryFile}`,
            'If running from source, build frontend assets with: pnpm run build:frontend',
            'If running with npx, clear the npx cache and reinstall codexapp.',
          ]),
        )
      return
    }

    res.sendFile(spaEntryFile, (error) => {
      if (!error) return
      if (!res.headersSent) {
        res.status(404).type('text/html; charset=utf-8').send(renderFrontendMissingHtml('Frontend entry file not found.'))
      }
    })
  })

  return {
    app,
    dispose: () => bridge.dispose(),
    attachWebSocket: (server: HttpServer) => {
      const wss = new WebSocketServer({ noServer: true })

      server.on('upgrade', (req: IncomingMessage, socket, head) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        if (url.pathname !== '/codex-api/ws') return

        if (authSession && !authSession.isRequestAuthorized(req)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          wss.emit('connection', ws, req)
        })
      })

      wss.on('connection', (ws: WebSocket) => {
        ws.send(JSON.stringify({ method: 'ready', params: { ok: true }, atIso: new Date().toISOString() }))
        const unsubscribe = bridge.subscribeNotifications((notification) => {
          if (ws.readyState !== 1) return
          ws.send(JSON.stringify(notification))
        })

        ws.on('close', unsubscribe)
        ws.on('error', unsubscribe)
      })
    },
  }
}
