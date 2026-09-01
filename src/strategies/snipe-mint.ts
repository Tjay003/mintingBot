import { parseEther, type Address, type Abi } from 'viem'
import { getPublicClient, getWsPublicClient, getWallets, loadBalances, filterSolventWallets, getNonce } from '../wallets/manager.js'
import {
  executeParallelMint,
  COMMON_MINT_ABIS,
  SEADROP_ROUTER_ADDRESS,
  OPENSEA_FEE_RECIPIENT,
  ZERO_ADDRESS,
  SEADROP_MINT_PUBLIC_ABI,
} from '../core/tx-builder.js'
import { fastProbeContract, analyzeContract } from '../utils/contract-analyzer.js'
import { processAutoTransfer } from '../utils/nft-sweeper.js'
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
  /** Which wallet indices to use (e.g. [1, 3]). Defaults to all wallets if omitted. */
  walletIndices?: number[]
  /** Optional cold vault address to sweep minted NFTs to */
  autoTransferVault?: Address
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
  if (opts.walletIndices && opts.walletIndices.length > 0) {
    logger.info(`Selected wallets: Wallet ${opts.walletIndices.join(', Wallet ')}`)
  }
  logger.divider()

  const publicClient = getPublicClient()
  const wsClient = getWsPublicClient()
  const settings = getSettings()

  const preFlightStart = performance.now()
  logger.info(`⚡ [PRE-FLIGHT] Initializing snipe pre-flight (Wallets, Balances, Route)...`)

  const rawWallets = getWallets(false)
  const targetWallets = opts.walletIndices && opts.walletIndices.length > 0
    ? rawWallets.filter((w) => opts.walletIndices!.includes(w.index))
    : rawWallets

  // Concurrently probe contract & load balances
  const [probeResult, balances] = await Promise.all([
    fastProbeContract(publicClient, opts.contractAddress),
    Promise.all(targetWallets.map((w) => publicClient.getBalance({ address: w.address }))),
  ])
  const preFlightDurationMs = Math.round(performance.now() - preFlightStart)

  targetWallets.forEach((w, i) => {
    w.balance = balances[i]
  })

  const isSeaDrop = probeResult.isSeaDrop || opts.functionName === 'mintSeaDrop' || opts.functionName === 'mintSeaDrop(address,uint256)'

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

  const totalCostEth = (parseFloat(effectivePriceEth) * opts.quantity).toString()
  const totalCostWei = parseEther(totalCostEth)
  const solvent = filterSolventWallets(targetWallets, totalCostWei)

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

  let targetAddress = opts.contractAddress
  let targetAbi = resolvedAbi
  let targetFunctionName = opts.functionName
  let targetArgs: unknown[] = [BigInt(opts.quantity)]

  if (isSeaDrop) {
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

  logger.info(`✓ [PRE-FLIGHT] Completed in ${preFlightDurationMs}ms (${solvent.length} solvent wallet(s) armed)`)
  logger.info(`ℹ [ROUTING] ${isSeaDrop ? `OpenSea SeaDrop Router (${SEADROP_ROUTER_ADDRESS})` : `Direct Contract (${opts.contractAddress})`}`)

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
        const triggerStart = performance.now()
        logger.fire(`🚀 [SNIPE TRIGGER] Gate is OPEN — launching parallel mint!`)

        const nonces = await Promise.all(solvent.map((w) => getNonce(w.address)))
        const nonceDurationMs = Math.round(performance.now() - triggerStart)

        logger.info(`ℹ [NONCES] Nonces fetched in ${nonceDurationMs}ms`)

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
        finish()
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    }

    unwatch = watchForSaleActive(wsClient, publicClient, opts.contractAddress, onLive)
  })
}
