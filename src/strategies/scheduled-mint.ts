import { parseEther, type Address, type Abi } from 'viem'
import { getPublicClient, loadBalances, filterSolventWallets, getNonce } from '../wallets/manager.js'
import { executeParallelMint, COMMON_MINT_ABIS } from '../core/tx-builder.js'
import { sleepUntil } from '../core/block-monitor.js'
import { getSettings } from '../config/settings.js'
import { logger } from '../utils/logger.js'
import type { GasStrategy } from '../core/gas-manager.js'

export interface ScheduledMintOptions {
  contractAddress: Address
  functionName: string
  abi?: Abi
  quantity: number
  priceEth: string
  /** ISO 8601 datetime string, e.g. "2026-08-15T14:00:00Z" */
  mintTime: string
  gasStrategy: GasStrategy
  customGasPriceGwei?: number
}

/**
 * Scheduled mint — fires at a specific wall-clock time.
 * Ideal for announced mint times (e.g. "drops at 2pm UTC").
 *
 * Pre-builds wallet context beforehand, sleeps until mint time,
 * then fires immediately at the target moment.
 */
export async function runScheduledMint(opts: ScheduledMintOptions): Promise<void> {
  const targetTime = new Date(opts.mintTime)
  if (isNaN(targetTime.getTime())) {
    throw new Error(`Invalid mint time: "${opts.mintTime}"\nUse ISO 8601 format, e.g. "2026-08-15T14:00:00Z"`)
  }

  logger.banner()
  logger.info(`Mode: Scheduled Mint`)
  logger.info(`Contract: ${opts.contractAddress}`)
  logger.info(`Function: ${opts.functionName}(${opts.quantity})`)
  logger.info(`Price: ${opts.priceEth} ETH × ${opts.quantity} per wallet`)
  logger.info(`Target time: ${targetTime.toISOString()} (local: ${targetTime.toLocaleString()})`)
  logger.info(`Gas strategy: ${opts.gasStrategy}`)
  logger.divider()

  const publicClient = getPublicClient()
  const settings = getSettings()

  const totalCostEth = (parseFloat(opts.priceEth) * opts.quantity).toString()
  const totalCostWei = parseEther(totalCostEth)

  // Pre-load balances now — don't wait until mint time
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

  // Wait until mint time with countdown
  await sleepUntil(targetTime)

  // Fetch nonces right at fire time (most accurate)
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
}
