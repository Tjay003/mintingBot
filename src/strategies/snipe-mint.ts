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
}

/**
 * Snipe strategy — the fastest mode.
 * Monitors the contract every block via WebSocket.
 * The moment the sale goes live, fires all wallets simultaneously.
 *
 * This is how you beat manual minters: they're still loading the website
 * while the bot already submitted the transaction.
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

  // Pre-load balances before the snipe starts
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

  // Set up the snipe callback — called instantly when sale goes live
  let unwatch: (() => void) | undefined

  const onLive = async (): Promise<void> => {
    // Stop watching blocks — we don't need this anymore
    if (unwatch) unwatch()

    // Fetch fresh nonces at fire time
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

    // Exit cleanly after mint
    process.exit(0)
  }

  // Start watching — this blocks until the sale goes live
  unwatch = watchForSaleActive(wsClient, publicClient, opts.contractAddress, onLive)

  // Keep the process alive
  await new Promise<void>(() => {
    process.on('SIGINT', () => {
      logger.warn('\nInterrupted — stopping snipe.')
      if (unwatch) unwatch()
      process.exit(0)
    })
  })
}
