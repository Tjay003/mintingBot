import { wsBridge, type WsEvent } from '../src/utils/ws-bridge.js'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'

let wss: WebSocketServer | null = null
const clients = new Set<WebSocket>()

/**
 * Attach a WebSocket server to an existing HTTP server.
 * All minting engine events (via wsBridge) are broadcast to every connected client.
 */
export function attachWebSocket(httpServer: Server): void {
  wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws) => {
    clients.add(ws)

    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))

    // Send a welcome event so the client knows WS is connected
    send(ws, { type: 'log', level: 'info', message: 'WebSocket connected', timestamp: new Date().toISOString() })
  })

  // Subscribe to the minting engine bridge and forward all events
  wsBridge.on('ws', (payload: WsEvent) => {
    broadcast(payload)
  })
}

function send(ws: WebSocket, payload: WsEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function broadcast(payload: WsEvent): void {
  const msg = JSON.stringify(payload)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  }
}

/** Broadcast a session state update to all connected clients */
export function broadcastSession(payload: Omit<WsEvent & { type: 'session' }, 'type'>): void {
  broadcast({ type: 'session', ...payload })
}
