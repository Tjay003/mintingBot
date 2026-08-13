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
  /** AbortController for stopping a running snipe */
  abortController?: AbortController
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
    blockCount: state.blocksChecked,
    saleActive: state.saleActive,
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
  broadcastSession({ status: 'idle' })
}

export function incrementBlock(saleActive: boolean | null): void {
  state.blocksChecked++
  state.saleActive = saleActive
}
