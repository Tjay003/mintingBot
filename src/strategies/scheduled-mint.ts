import { parseEther, type Address, type Abi, type TransactionReceipt } from 'viem'
import { getPublicClient, loadBalances, filterSolventWallets, getNonce, type ManagedWallet } from '../wallets/manager.js'
import {
  executeParallelMint,
  preSignMintTransaction,
  executeParallelRawBlast,
  type PreSignedTransaction,
  COMMON_MINT_ABIS,
  SEADROP_ROUTER_ADDRESS,
  OPENSEA_FEE_RECIPIENT,
  ZERO_ADDRESS,
  SEADROP_MINT_PUBLIC_ABI,
} from '../core/tx-builder.js'
import { analyzeContract } from '../utils/contract-analyzer.js'
import { processAutoTransfer } from '../utils/nft-sweeper.js'
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
  /** Optional cold vault address to sweep minted NFTs to */
  autoTransferVault?: Address
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

  const publicClient = getPublicClient()
  const settings = getSettings()

  // Concurrently analyze contract & load wallet balances in parallel
  const [analysis, wallets] = await Promise.all([
    analyzeContract(publicClient, opts.contractAddress, false, false),
    loadBalances(true, false, opts.walletIndices),
  ])

  const isSeaDrop = analysis.isSeaDrop || opts.functionName === 'mintSeaDrop' || opts.functionName === 'mintSeaDrop(address,uint256)'

  // Auto-detect price if not explicitly provided or if on-chain price is detected
  let effectivePriceEth = opts.priceEth?.trim()
  if (!effectivePriceEth || effectivePriceEth.toLowerCase() === 'auto' || (parseFloat(effectivePriceEth) === 0 && analysis.mintPriceEth && parseFloat(analysis.mintPriceEth) > 0)) {
    if (analysis.mintPriceEth) {
      effectivePriceEth = analysis.mintPriceEth
      logger.info(`Auto-detected on-chain price: ${effectivePriceEth} ETH`)
    } else {
      effectivePriceEth = '0'
    }
  }

  const totalCostEth = (parseFloat(effectivePriceEth) * opts.quantity).toString()
  const totalCostWei = parseEther(totalCostEth)
  const solvent = filterSolventWallets(wallets, totalCostWei)

  logger.banner()
  logger.info(`Mode: Scheduled Mint`)
  logger.info(`Contract: ${opts.contractAddress}`)
  logger.info(`Function: ${opts.functionName}(${opts.quantity})`)
  logger.info(`Price per NFT: ${effectivePriceEth} ETH`)
  logger.info(`Quantity per wallet: ${opts.quantity}`)
  logger.info(`Total cost per wallet: ${totalCostEth} ETH`)
  logger.info(`Gas strategy: ${opts.gasStrategy}`)
  logger.info(`Target time: ${targetTime.toISOString()} (local: ${targetTime.toLocaleString()})`)
  if (opts.walletIndices && opts.walletIndices.length > 0) {
    logger.info(`Selected wallets: Wallet ${opts.walletIndices.join(', Wallet ')}`)
  }
  logger.divider()

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

  // Setup parameters & SeaDrop routing
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

  const mintParams = {
    contractAddress: targetAddress,
    abi: targetAbi,
    functionName: targetFunctionName,
    args: targetArgs,
    valueEth: totalCostEth,
    gasStrategy: opts.gasStrategy,
    customGasPriceGwei: opts.customGasPriceGwei,
  }

  // Handle Ctrl+C in CLI mode
  if (!opts.signal) {
    process.once('SIGINT', () => {
      logger.warn('\nInterrupted — stopping scheduled mint.')
      process.exit(0)
    })
  }

  // Two-stage execution: Pre-sign at T - 5s, Blast at T - 0s
  const PRE_SIGN_LEAD_MS = 5000
  const nowMs = Date.now()
  const targetMs = targetTime.getTime()
  const timeUntilTarget = targetMs - nowMs

  let preSignedTxs: PreSignedTransaction[] = []

  if (timeUntilTarget > PRE_SIGN_LEAD_MS) {
    // Stage 1: Sleep until T - 5 seconds
    const preSignTime = new Date(targetMs - PRE_SIGN_LEAD_MS)
    await sleepUntil(preSignTime, opts.signal)

    if (opts.signal?.aborted) {
      logger.warn('Scheduled mint cancelled before firing.')
      return
    }

    // At T - 5s: Fetch nonces and pre-sign all transactions into memory
    logger.info(`⚡ T-5s Reached: Pre-signing transactions in parallel across ${solvent.length} wallet(s)...`)
    const nonces = await Promise.all(solvent.map((w) => getNonce(w.address)))
    const signResults = await Promise.allSettled(
      solvent.map((w, i) => preSignMintTransaction(publicClient, w, mintParams, nonces[i])),
    )

    for (let i = 0; i < signResults.length; i++) {
      const res = signResults[i]
      if (res.status === 'fulfilled') {
        preSignedTxs.push(res.value)
      } else {
        logger.error(`Wallet ${solvent[i].index} pre-sign failed: ${res.reason}`)
      }
    }

    if (preSignedTxs.length === 0) {
      throw new Error('All transaction pre-signs failed — aborting scheduled mint')
    }

    logger.success(`⚡ ${preSignedTxs.length} transaction(s) pre-signed into memory — armed and holding for T-0 blast!`)
  }

  // Stage 2: Sleep until exact target time T - 0s
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

  let results: Array<{
    wallet: ManagedWallet
    hash?: string
    error?: string
    submitDurationMs?: number
    confirmDurationMs?: number
    totalDurationMs?: number
    receipt?: TransactionReceipt
  }>

  if (preSignedTxs.length > 0) {
    // Instant raw byte blast with 0 signing latency!
    results = await executeParallelRawBlast(publicClient, preSignedTxs)
  } else {
    // Immediate fallback if scheduled with < 5s remaining
    const nonces = await Promise.all(solvent.map((w) => getNonce(w.address)))
    results = await executeParallelMint(publicClient, solvent, mintParams, nonces)
  }

  logger.divider()
  let successCount = 0
  const vaultRecipient = opts.autoTransferVault || settings.recipientAddress || settings.autoTransferVault

  for (const r of results) {
    if (r.hash) {
      const timingStr = r.totalDurationMs ? ` (took ${(r.totalDurationMs / 1000).toFixed(2)}s)` : ''
      logger.success(`Wallet ${r.wallet.index} ✓  ${r.hash}${timingStr}`)
      successCount++

      // Execute auto-transfer if recipient / cold vault address is specified
      if (vaultRecipient && r.receipt) {
        await processAutoTransfer(
          r.wallet,
          publicClient,
          opts.contractAddress,
          vaultRecipient,
          r.receipt,
        )
      }
    } else {
      logger.error(`Wallet ${r.wallet.index} ✗  ${r.error}`)
    }
  }
  logger.divider()
  logger.info(`Done: ${successCount}/${results.length} wallets succeeded`)
}
