import { parseEther, type Address, type Abi } from 'viem'
import { getPublicClient, getWsPublicClient, loadBalances, filterSolventWallets, getNonce } from '../wallets/manager.js'
import { executeParallelMint, COMMON_MINT_ABIS } from '../core/tx-builder.js'
import { watchForSaleActive } from '../core/block-monitor.js'
import { getSettings } from '../config/settings.js'
import { logger } from '../utils/logger.js'
import type { GasStrategy } from '../core/gas-manager.js'

export interface SnipeMintOptions {
  contractAddress: Address
  functionName: string
  abi?: Abi
  quantity: number
  priceEth: string
  gasStrategy: GasStrategy
  customGasPriceGwei?: number
  /** Optional signal to abort the snipe (used by dashboard server) */
  signal?: AbortSignal
}

/**
 * Snipe strategy — the fastest mode.
 * Monitors the contract every block via WebSocket.
 * The moment the sale goes live, fires all wallets simultaneously.
 *
 * Supports an optional AbortSignal for programmatic cancellation
 * from the dashboard server without killing the process.
 */
export async function runSnipeMint(opts: SnipeMintOptions): Promise<void> {
  logger.banner()
  logger.info(`Mode: FCFS Snipe`)
  logger.info(`Contract: ${opts.contractAddress}`)
  logger.info(`Function: ${opts.functionName}(${opts.quantity})`)
  logger.info(`Price: ${opts.priceEth} ETH × ${opts.quantity} per wallet`)
  logger.info(`Gas strategy: ${opts.gasStrategy} (tip: use "turbo" for hot mints)`)
  logger.divider()

  const publicClient = getPublicClient()
  const wsClient = getWsPublicClient()
  const settings = getSettings()

  const totalCostEth = (parseFloat(opts.priceEth) * opts.quantity).toString()
  const totalCostWei = parseEther(totalCostEth)

  const wallets = await loadBalances()
  const solvent = filterSolventWallets(wallets, totalCostWei)

  if (solvent.length === 0) {
    throw new Error('No wallets have sufficient balance to mint.')
  }

  const grandTotalEth = parseFloat(totalCostEth) * solvent.length
  if (grandTotalEth > settings.safety.maxTotalEth) {
    throw new Error(
      `Total spend (${grandTotalEth} ETH) exceeds MAX_TOTAL_ETH (${settings.safety.maxTotalEth} ETH)`,
    )
  }

  const sigKey = `${opts.functionName}(uint256)`
  const resolvedAbi: Abi = opts.abi ?? [COMMON_MINT_ABIS[sigKey] ?? COMMON_MINT_ABIS['mint(uint256)']]

  return new Promise<void>((resolve, reject) => {
    let unwatch: (() => void) | undefined
    let settled = false

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (unwatch) unwatch()
      if (err) reject(err)
      else resolve()
    }

    // Handle abort signal (from dashboard "Stop" button)
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        logger.warn('Snipe stopped by user.')
        finish()
      })
      if (opts.signal.aborted) {
        finish()
        return
      }
    }

    // Handle Ctrl+C in CLI mode
    if (!opts.signal) {
      process.once('SIGINT', () => {
        logger.warn('\nInterrupted — stopping snipe.')
        finish()
        process.exit(0)
      })
    }

    const onLive = async (): Promise<void> => {
      try {
        const nonces = await Promise.all(solvent.map((w) => getNonce(w.address)))

        const results = await executeParallelMint(publicClient, solvent, {
          contractAddress: opts.contractAddress,
          abi: resolvedAbi,
          functionName: opts.functionName,
          args: [BigInt(opts.quantity)],
          valueEth: totalCostEth,
          gasStrategy: opts.gasStrategy,
          customGasPriceGwei: opts.customGasPriceGwei,
        }, nonces)

        logger.divider()
        let successCount = 0
        for (const r of results) {
          if (r.hash) {
            logger.success(`Wallet ${r.wallet.index} ✓  ${r.hash}`)
            successCount++
          } else {
            logger.error(`Wallet ${r.wallet.index} ✗  ${r.error}`)
          }
        }
        logger.divider()
        logger.info(`Done: ${successCount}/${results.length} wallets succeeded`)
        finish()
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    }

    unwatch = watchForSaleActive(wsClient, publicClient, opts.contractAddress, onLive)
  })
}
