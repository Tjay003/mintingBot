import { EventEmitter } from 'events'

/**
 * In-process event bridge between the minting engine (logger)
 * and the WebSocket server. Avoids circular imports.
 *
 * logger.ts  →  emits to wsBridge
 * server/ws-emitter.ts  →  subscribes to wsBridge and broadcasts to clients
 */

export interface WsLogEvent {
  type: 'log'
  level: 'info' | 'success' | 'warn' | 'error' | 'fire' | 'block'
  message: string
  timestamp: string
}

export interface WsSessionEvent {
  type: 'session'
  status: 'idle' | 'running' | 'success' | 'error'
  mode?: string
  target?: string
  contractAddress?: string
  blockCount?: number
  saleActive?: boolean | null
  quantity?: number
  priceEth?: string
  gasStrategy?: string
  mintTime?: string
  selectedWallets?: number[]
  autoTransferVault?: string
  error?: string
}

export interface WsBlockEvent {
  type: 'block'
  number: string
  saleActive: boolean | null
  checked: number
}

export type WsEvent = WsLogEvent | WsSessionEvent | WsBlockEvent

class WsBridge extends EventEmitter {
  emit(event: 'ws', payload: WsEvent): boolean {
    return super.emit('ws', payload)
  }
  on(event: 'ws', listener: (payload: WsEvent) => void): this {
    return super.on('ws', listener)
  }
}

export const wsBridge = new WsBridge()
