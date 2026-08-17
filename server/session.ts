import { broadcastSession } from './ws-emitter.js'

export type SessionMode = 'public' | 'snipe' | 'whitelist' | 'scheduled'
export type SessionStatus = 'idle' | 'running' | 'success' | 'error'

export interface SessionState {
  status: SessionStatus
  mode?: SessionMode
  target?: string
  contractAddress?: string
  startedAt?: Date
  endedAt?: Date
  error?: string
  blocksChecked: number
  saleActive: boolean | null
  /** AbortController for stopping a running session */
  abortController?: AbortController
  quantity?: number
  priceEth?: string
  gasStrategy?: string
  mintTime?: string
  selectedWallets?: number[]
  autoTransferVault?: string
}

const state: SessionState = {
  status: 'idle',
  blocksChecked: 0,
  saleActive: null,
}

export function getSession(): SessionState {
  return state
}

export function setSession(patch: Partial<SessionState>): void {
  Object.assign(state, patch)
  broadcastSession({
    status: state.status,
    mode: state.mode,
    target: state.target,
    contractAddress: state.contractAddress,
    blockCount: state.blocksChecked,
    saleActive: state.saleActive,
    quantity: state.quantity,
    priceEth: state.priceEth,
    gasStrategy: state.gasStrategy,
    mintTime: state.mintTime,
    selectedWallets: state.selectedWallets,
    autoTransferVault: state.autoTransferVault,
    error: state.error,
  })
}

export function resetSession(): void {
  state.status = 'idle'
  state.mode = undefined
  state.target = undefined
  state.contractAddress = undefined
  state.startedAt = undefined
  state.endedAt = undefined
  state.error = undefined
  state.blocksChecked = 0
  state.saleActive = null
  state.abortController = undefined
  state.quantity = undefined
  state.priceEth = undefined
  state.gasStrategy = undefined
  state.mintTime = undefined
  state.selectedWallets = undefined
  state.autoTransferVault = undefined
  broadcastSession({ status: 'idle' })
}

export function incrementBlock(saleActive: boolean | null): void {
  state.blocksChecked++
  state.saleActive = saleActive
}
