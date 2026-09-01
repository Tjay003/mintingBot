import { parseEther, type Address, type Abi, type TransactionReceipt } from 'viem'
import { getPublicClient, getWallets, loadBalances, filterSolventWallets, getNonce, type ManagedWallet } from '../wallets/manager.js'
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
import { fastProbeContract, analyzeContract } from '../utils/contract-analyzer.js'
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

  const preFlightStart = performance.now()
  logger.info(`⚡ [PRE-FLIGHT] Initializing scheduled mint pre-flight (Wallets, Balances, Route)...`)

  const rawWallets = getWallets(false)
  const targetWallets = opts.walletIndices && opts.walletIndices.length > 0
    ? rawWallets.filter((w) => opts.walletIndices!.includes(w.index))
    : rawWallets

  // Parallel pre-flight (Fast Probe + Balances in 1 roundtrip)
  const [probeResult, balances] = await Promise.all([
    fastProbeContract(publicClient, opts.contractAddress),
    Promise.all(targetWallets.map((w) => publicClient.getBalance({ address: w.address }))),
  ])
  const preFlightDurationMs = Math.round(performance.now() - preFlightStart)

  targetWallets.forEach((w, i) => {
    w.balance = balances[i]
  })

  const isSeaDrop = probeResult.isSeaDrop || opts.functionName === 'mintSeaDrop' || opts.functionName === 'mintSeaDrop(address,uint256)'

  // Check and enforce wallet limits from SeaDrop
  let effectiveQuantity = opts.quantity
  if (probeResult.maxTotalMintableByWallet && probeResult.maxTotalMintableByWallet > 0 && effectiveQuantity > probeResult.maxTotalMintableByWallet) {
    logger.warn(`⚠ [LIMIT] Requested quantity (${opts.quantity}) exceeds SeaDrop wallet limit (${probeResult.maxTotalMintableByWallet}) — auto-adjusted to ${probeResult.maxTotalMintableByWallet}`)
    effectiveQuantity = probeResult.maxTotalMintableByWallet
  }

  // Auto-detect price if not explicitly provided or if on-chain price is detected
  let effectivePriceEth = opts.priceEth?.trim()
  if (!effectivePriceEth || effectivePriceEth.toLowerCase() === 'auto' || (parseFloat(effectivePriceEth) === 0 && probeResult.mintPriceEth && parseFloat(probeResult.mintPriceEth) > 0)) {
    if (probeResult.mintPriceEth) {
      effectivePriceEth = probeResult.mintPriceEth
      logger.info(`✓ [PRICE] Auto-detected on-chain price: ${effectivePriceEth} ETH`)
    } else {
      effectivePriceEth = '0'
    }
  }

  const totalCostEth = (parseFloat(effectivePriceEth) * effectiveQuantity).toString()
  const totalCostWei = parseEther(totalCostEth)
  const solvent = filterSolventWallets(targetWallets, totalCostWei)

  logger.banner()
  logger.info(`Mode: Scheduled Mint`)
  logger.info(`Contract: ${opts.contractAddress}`)
  logger.info(`Function: ${opts.functionName}(${effectiveQuantity})`)
  logger.info(`Price per NFT: ${effectivePriceEth} ETH`)
  logger.info(`Quantity per wallet: ${effectiveQuantity}`)
  logger.info(`Total cost per wallet: ${totalCostEth} ETH`)
  logger.info(`Gas strategy: ${opts.gasStrategy.toUpperCase()}`)
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

  logger.info(`✓ [PRE-FLIGHT] Completed in ${preFlightDurationMs}ms (${solvent.length} solvent wallet(s) armed)`)
  logger.info(`Total estimated spend: ${grandTotalEth.toFixed(4)} ETH across ${solvent.length} wallet(s) (${solvent.length * effectiveQuantity} NFTs total)`)
  logger.divider()

  const sigKey = `${opts.functionName}(uint256)`
  const resolvedAbi: Abi = opts.abi ?? [COMMON_MINT_ABIS[sigKey] ?? COMMON_MINT_ABIS['mint(uint256)']]

  // Setup parameters & SeaDrop routing
  let targetAddress = opts.contractAddress
  let targetAbi = resolvedAbi
  let targetFunctionName = opts.functionName
  let targetArgs: unknown[] = [BigInt(effectiveQuantity)]

  if (isSeaDrop) {
    targetAddress = SEADROP_ROUTER_ADDRESS
    targetAbi = SEADROP_MINT_PUBLIC_ABI
    targetFunctionName = 'mintPublic'
    targetArgs = [
      opts.contractAddress,
      OPENSEA_FEE_RECIPIENT,
      ZERO_ADDRESS,
      BigInt(effectiveQuantity),
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

  logger.info(`ℹ [ROUTING] ${isSeaDrop ? `OpenSea SeaDrop Router (${SEADROP_ROUTER_ADDRESS})` : `Direct Contract (${opts.contractAddress})`}`)

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
    logger.info(`⚡ [STAGE 1: T-5s] Pre-signing transactions across ${solvent.length} wallet(s)...`)
    const signStart = performance.now()
    const nonces = await Promise.all(solvent.map((w) => getNonce(w.address)))
    const signResults = await Promise.allSettled(
      solvent.map((w, i) => preSignMintTransaction(publicClient, w, mintParams, nonces[i])),
    )
    const signDurationMs = Math.round(performance.now() - signStart)

    for (let i = 0; i < signResults.length; i++) {
      const res = signResults[i]
      if (res.status === 'fulfilled') {
        preSignedTxs.push(res.value)
      } else {
        logger.error(`✗ Wallet ${solvent[i].index} pre-sign failed: ${res.reason}`)
      }
    }

    if (preSignedTxs.length === 0) {
      throw new Error('All transaction pre-signs failed — aborting scheduled mint')
    }

    logger.success(`⚡ [STAGE 1] ${preSignedTxs.length} transaction(s) pre-signed in ${signDurationMs}ms — armed in RAM ready for T-0 blast!`)
  }

  // Stage 2: Sleep until exact target time T - 0s
  await sleepUntil(targetTime, opts.signal)

  if (opts.signal?.aborted) {
    logger.warn('Scheduled mint cancelled before firing.')
    return
  }

  logger.divider()
  logger.fire(`Launching scheduled mint for ${solvent.length} wallet(s) [${solvent.length * effectiveQuantity} NFTs total]`)
  for (const w of solvent) {
    logger.info(`Firing Wallet ${w.index} (${w.address}) | Qty: ${effectiveQuantity} | Value: ${totalCostEth} ETH | Gas: ${opts.gasStrategy.toUpperCase()}`)
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

  // Stage 3: Auto-Retry Safety Net (if any transaction reverted on early T-0 blast)
  const failedResults = results.filter((r) => !r.hash || r.receipt?.status !== 'success')
  if (failedResults.length > 0 && !opts.signal?.aborted) {
    logger.warn(`⚠ ${failedResults.length} wallet transaction(s) reverted / failed on T-0 blast. Retrying in 250ms with fresh on-chain nonces...`)
    await new Promise((res) => setTimeout(res, 250))
    const retryWallets = failedResults.map((r) => r.wallet)
    const retryNonces = await Promise.all(retryWallets.map((w) => getNonce(w.address)))
    const retryResults = await executeParallelMint(publicClient, retryWallets, mintParams, retryNonces)

    for (const rr of retryResults) {
      const idx = results.findIndex((orig) => orig.wallet.index === rr.wallet.index)
      if (idx !== -1) {
        results[idx] = rr
      }
    }
  }

  logger.divider()
  let successCount = 0
  const vaultRecipient = opts.autoTransferVault || settings.recipientAddress || settings.autoTransferVault

  for (const r of results) {
    if (r.hash && r.receipt?.status === 'success') {
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
      logger.error(`Wallet ${r.wallet.index} ✗  ${r.error || 'Transaction reverted'}`)
    }
  }
  logger.divider()
  logger.info(`Done: ${successCount}/${results.length} wallets succeeded`)
}
