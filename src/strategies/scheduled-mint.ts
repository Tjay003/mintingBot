import { parseEther, type Address, type Abi } from 'viem'
import { getPublicClient, loadBalances, filterSolventWallets, getNonce } from '../wallets/manager.js'
import {
  executeParallelMint,
  COMMON_MINT_ABIS,
  SEADROP_ROUTER_ADDRESS,
  OPENSEA_FEE_RECIPIENT,
  ZERO_ADDRESS,
  SEADROP_MINT_PUBLIC_ABI,
} from '../core/tx-builder.js'
import { analyzeContract } from '../utils/contract-analyzer.js'
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
  walletIndices?: number[]
  /** Optional signal to abort the scheduled mint */
  signal?: AbortSignal
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

  const totalCostEth = (parseFloat(opts.priceEth || '0') * opts.quantity).toString()
  const totalCostWei = parseEther(totalCostEth)

  logger.banner()
  logger.info(`Mode: Scheduled Mint`)
  logger.info(`Contract: ${opts.contractAddress}`)
  logger.info(`Function: ${opts.functionName}(${opts.quantity})`)
  logger.info(`Price per NFT: ${opts.priceEth || '0'} ETH`)
  logger.info(`Quantity per wallet: ${opts.quantity}`)
  logger.info(`Total cost per wallet: ${totalCostEth} ETH`)
  logger.info(`Gas strategy: ${opts.gasStrategy}`)
  logger.info(`Target time: ${targetTime.toISOString()} (local: ${targetTime.toLocaleString()})`)
  if (opts.walletIndices && opts.walletIndices.length > 0) {
    logger.info(`Selected wallets: Wallet ${opts.walletIndices.join(', Wallet ')}`)
  }
  logger.divider()

  const publicClient = getPublicClient()
  const settings = getSettings()

  // Pre-load balances now — don't wait until mint time
  const wallets = await loadBalances(true, false, opts.walletIndices)
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

  logger.info(`Ready wallets (${solvent.length}): ${solvent.map((w) => `Wallet ${w.index} (${w.address.slice(0, 6)}...${w.address.slice(-4)})`).join(', ')}`)
  logger.info(`Total estimated spend: ${grandTotalEth.toFixed(4)} ETH across ${solvent.length} wallet(s) (${solvent.length * opts.quantity} NFTs total)`)
  logger.divider()

  const sigKey = `${opts.functionName}(uint256)`
  const resolvedAbi: Abi = opts.abi ?? [COMMON_MINT_ABIS[sigKey] ?? COMMON_MINT_ABIS['mint(uint256)']]

  // Handle Ctrl+C in CLI mode
  if (!opts.signal) {
    process.once('SIGINT', () => {
      logger.warn('\nInterrupted — stopping scheduled mint.')
      process.exit(0)
    })
  }

  // Wait until mint time with countdown & abort handling
  await sleepUntil(targetTime, opts.signal)

  if (opts.signal?.aborted) {
    logger.warn('Scheduled mint cancelled before firing.')
    return
  }

  logger.divider()
  logger.fire(`Launching scheduled mint for ${solvent.length} wallet(s) [${solvent.length * opts.quantity} NFTs total]`)
  for (const w of solvent) {
    logger.info(`Firing Wallet ${w.index} (${w.address}) | Qty: ${opts.quantity} | Value: ${totalCostEth} ETH | Gas: ${opts.gasStrategy.toUpperCase()}`)
  }

  // Fetch nonces right at fire time (most accurate)
  const nonces = await Promise.all(solvent.map((w) => getNonce(w.address)))

  const analysis = await analyzeContract(publicClient, opts.contractAddress)
  const isSeaDrop = analysis.isSeaDrop || opts.functionName === 'mintSeaDrop' || opts.functionName === 'mintSeaDrop(address,uint256)'

  let targetAddress = opts.contractAddress
  let targetAbi = resolvedAbi
  let targetFunctionName = opts.functionName
  let targetArgs: unknown[] = [BigInt(opts.quantity)]

  if (isSeaDrop) {
    logger.info(`Detected OpenSea SeaDrop launchpad — routing mint via SeaDrop Router`)
    targetAddress = SEADROP_ROUTER_ADDRESS
    targetAbi = SEADROP_MINT_PUBLIC_ABI
    targetFunctionName = 'mintPublic'
    targetArgs = [
      opts.contractAddress,
      OPENSEA_FEE_RECIPIENT,
      ZERO_ADDRESS,
      BigInt(opts.quantity),
    ]
  }

  const results = await executeParallelMint(publicClient, solvent, {
    contractAddress: targetAddress,
    abi: targetAbi,
    functionName: targetFunctionName,
    args: targetArgs,
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
