import type { PublicClient, Address } from 'viem'
import { SEADROP_ROUTER_ADDRESS } from './tx-builder.js'
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

const SEADROP_CHECK_ABI = [
  {
    name: 'getPublicDrop',
    type: 'function',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'mintPrice', type: 'uint80' },
          { name: 'startTime', type: 'uint48' },
          { name: 'endTime', type: 'uint48' },
          { name: 'maxTotalMintableByWallet', type: 'uint16' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'restrictFeeRecipients', type: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const

/**
 * Try to detect whether a contract's sale is currently active.
 * Probes common boolean state functions and SeaDrop router start times.
 * Returns { active: boolean, functionName: string } or null if unknown.
 */
export async function detectSaleState(
  publicClient: PublicClient,
  contractAddress: Address,
): Promise<{ active: boolean; functionName: string } | null> {
  // 1. Probe SeaDrop router public drop start time
  try {
    const drop = await publicClient.readContract({
      address: SEADROP_ROUTER_ADDRESS,
      abi: SEADROP_CHECK_ABI,
      functionName: 'getPublicDrop',
      args: [contractAddress],
    }) as { startTime: number; endTime: number }

    if (drop && drop.startTime > 0) {
      const nowSec = Math.floor(Date.now() / 1000)
      const isLive = nowSec >= Number(drop.startTime) && nowSec <= Number(drop.endTime)
      return { active: isLive, functionName: `SeaDrop:startTime(${drop.startTime})` }
    }
  } catch {
    // Not a SeaDrop drop or getPublicDrop reverted
  }

  // 2. Probe standard ERC-721/1155 sale state functions
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
 * Monitor a contract every new block (via WebSocket or resilient HTTP polling)
 * and call onLive() the moment the sale state flips to active.
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
  let httpPollInterval: NodeJS.Timeout | null = null
  let stopped = false

  logger.info(`Block monitor started  →  watching ${contractAddress}`)
  logger.info(`Waiting for sale to go live... (checks every block ~250ms)`)

  const checkState = async (blockNum?: bigint | number) => {
    if (fired || stopped) return
    blocksChecked++

    if (blockNum) {
      logger.block(BigInt(blockNum), `checking sale state...`)
    }

    const state = await detectSaleState(httpClient, contractAddress)

    if (state === null) {
      if (blocksChecked === 1) {
        logger.warn(`Could not auto-detect sale state function. Will keep watching.`)
      }
      return
    }

    if (state.active) {
      if (fired || stopped) return
      fired = true
      logger.success(`Sale is LIVE! (${state.functionName} = true) — FIRING NOW`)
      await onLive()
    } else if (blockNum) {
      logger.block(BigInt(blockNum), `${state.functionName} = false`)
    }
  }

  const startHttpPollingFallback = () => {
    if (httpPollInterval || stopped) return
    logger.info(`Switching to high-frequency HTTP block polling (~250ms fallback)...`)
    httpPollInterval = setInterval(async () => {
      try {
        const blockNum = await httpClient.getBlockNumber()
        await checkState(blockNum)
      } catch {}
    }, 250)
  }

  let unwatchWs: (() => void) | null = null

  try {
    unwatchWs = wsClient.watchBlocks({
      onBlock: async (block) => {
        await checkState(block.number)
      },
      onError: (error) => {
        logger.warn(`WSS subscription warning: ${error.message} — falling back to HTTP block polling`)
        startHttpPollingFallback()
      },
    })
  } catch (err: any) {
    logger.warn(`WSS connection failed: ${err.message} — using HTTP block polling`)
    startHttpPollingFallback()
  }

  return () => {
    stopped = true
    if (unwatchWs) unwatchWs()
    if (httpPollInterval) clearInterval(httpPollInterval)
  }
}

/**
 * Sleep until a specific future timestamp, logging a countdown.
 * Used for scheduled mints where we know the exact start time.
 */
export async function sleepUntil(targetTime: Date, signal?: AbortSignal): Promise<void> {
  const now = Date.now()
  const target = targetTime.getTime()
  const diff = target - now

  if (signal?.aborted) {
    throw new Error('Scheduled mint aborted before start')
  }

  if (diff <= 0) {
    logger.warn('Target time is in the past — firing immediately')
    return
  }

  logger.info(`Scheduled mint in ${Math.ceil(diff / 1000)}s  (at ${targetTime.toLocaleTimeString()})`)

  // Sleep in intervals with periodic progress logs until 10 seconds before
  if (diff > 10_000) {
    const endSleep = target - 10_000
    let lastLogSec = Math.ceil((target - Date.now()) / 1000)

    while (Date.now() < endSleep) {
      if (signal?.aborted) {
        throw new Error('Scheduled mint stopped by user.')
      }
      const remainingSec = Math.ceil((target - Date.now()) / 1000)
      if (remainingSec <= lastLogSec - 60 || (remainingSec <= 30 && remainingSec !== lastLogSec)) {
        logger.info(`⏳ Countdown: ${remainingSec}s remaining until scheduled mint...`)
        lastLogSec = remainingSec
      }
      const step = Math.min(1000, endSleep - Date.now())
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, step)
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timeout)
            reject(new Error('Scheduled mint stopped by user.'))
          }, { once: true })
        }
      })
    }
    logger.info(`10 seconds to mint time — standby...`)
  }

  // Rapid poll the last 10 seconds
  while (Date.now() < target - 500) {
    if (signal?.aborted) {
      throw new Error('Scheduled mint stopped by user.')
    }
    const remaining = ((target - Date.now()) / 1000).toFixed(1)
    process.stdout.write(`\r  ⏳  ${remaining}s remaining...`)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, 100)
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timeout)
          reject(new Error('Scheduled mint stopped by user.'))
        }, { once: true })
      }
    })
  }

  process.stdout.write('\n')
  logger.fire('Time is NOW — launching transactions!')
}
