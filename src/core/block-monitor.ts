import type { PublicClient, Address } from 'viem'
import { logger } from '../utils/logger.js'

export type SnipeCondition = 'sale-active' | 'not-paused' | 'function-callable'

/**
 * ABI fragments for common "is sale active?" style functions
 */
const SALE_STATE_ABI = [
  { name: 'saleIsActive', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'publicSaleActive', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'mintEnabled', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'isMintActive', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'revealed', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'paused', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
] as const

/**
 * Try to detect whether a contract's sale is currently active.
 * Probes common boolean state functions.
 * Returns { active: boolean, functionName: string } or null if unknown.
 */
export async function detectSaleState(
  publicClient: PublicClient,
  contractAddress: Address,
): Promise<{ active: boolean; functionName: string } | null> {
  for (const fn of SALE_STATE_ABI) {
    try {
      const result = await publicClient.readContract({
        address: contractAddress,
        abi: [fn],
        functionName: fn.name,
      })
      const isActive = fn.name === 'paused' ? !(result as boolean) : (result as boolean)
      return { active: isActive, functionName: fn.name }
    } catch {
      // Function doesn't exist on this contract — try next
    }
  }
  return null
}

/**
 * Monitor a contract every new block (via WebSocket) and call onLive()
 * the moment the sale state flips to active.
 *
 * Returns an unsubscribe function — call it to stop watching.
 */
export function watchForSaleActive(
  wsClient: PublicClient,
  httpClient: PublicClient,
  contractAddress: Address,
  onLive: () => Promise<void>,
): () => void {
  let fired = false
  let blocksChecked = 0

  logger.info(`Block monitor started  →  watching ${contractAddress}`)
  logger.info(`Waiting for sale to go live... (checks every block ~250ms)`)

  const unwatch = wsClient.watchBlocks({
    onBlock: async (block) => {
      if (fired) return
      blocksChecked++

      logger.block(block.number, `checking sale state...`)

      const state = await detectSaleState(httpClient, contractAddress)

      if (state === null) {
        // Can't auto-detect — log and keep watching
        if (blocksChecked === 1) {
          logger.warn(`Could not auto-detect sale state function. Will keep watching.`)
          logger.warn(`If this persists, use --condition with a custom function name.`)
        }
        return
      }

      // Print newline after the rolling block status
      process.stdout.write('\n')

      if (state.active) {
        if (fired) return
        fired = true
        logger.success(`Sale is LIVE! (${state.functionName} = true) — FIRING NOW`)
        await onLive()
      } else {
        logger.block(block.number, `${state.functionName} = false`)
      }
    },
    onError: (error) => {
      logger.error(`Block monitor error: ${error.message}`)
    },
  })

  return unwatch
}

/**
 * Sleep until a specific future timestamp, logging a countdown.
 * Used for scheduled mints where we know the exact start time.
 */
export async function sleepUntil(targetTime: Date): Promise<void> {
  const now = Date.now()
  const target = targetTime.getTime()
  const diff = target - now

  if (diff <= 0) {
    logger.warn('Target time is in the past — firing immediately')
    return
  }

  logger.info(`Scheduled mint in ${Math.ceil(diff / 1000)}s  (at ${targetTime.toLocaleTimeString()})`)

  // Countdown every second until 10 seconds before
  if (diff > 10_000) {
    await new Promise<void>((resolve) => setTimeout(resolve, diff - 10_000))
    logger.info(`10 seconds to mint time — standby...`)
  }

  // Rapid poll the last 10 seconds
  while (Date.now() < target - 500) {
    const remaining = ((target - Date.now()) / 1000).toFixed(1)
    process.stdout.write(`\r  ⏳  ${remaining}s remaining...`)
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }

  process.stdout.write('\n')
  logger.fire('Time is NOW — launching transactions!')
}
