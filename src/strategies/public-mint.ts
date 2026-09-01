import { parseEther, formatGwei, type Address, type Abi } from 'viem'
import { getPublicClient, getWallets, filterSolventWallets, getNonce } from '../wallets/manager.js'
import {
  executeParallelMint,
  COMMON_MINT_ABIS,
  SEADROP_ROUTER_ADDRESS,
  OPENSEA_FEE_RECIPIENT,
  ZERO_ADDRESS,
  SEADROP_MINT_PUBLIC_ABI,
} from '../core/tx-builder.js'
import { fastProbeContract } from '../utils/contract-analyzer.js'
import { estimateGasParams } from '../core/gas-manager.js'
import { processAutoTransfer } from '../utils/nft-sweeper.js'
import { getSettings } from '../config/settings.js'
import { logger } from '../utils/logger.js'
import type { GasStrategy } from '../core/gas-manager.js'

export interface PublicMintOptions {
  contractAddress: Address
  /** mint function name, e.g. "mint" or "publicMint" */
  functionName: string
  /** ABI — provide full ABI or leave undefined to use common signatures */
  abi?: Abi
  /** How many to mint per wallet */
  quantity: number
  /** Mint price in ETH per token (e.g. "0.05") */
  priceEth: string
  /** Gas strategy */
  gasStrategy: GasStrategy
  customGasPriceGwei?: number
  /** Which wallet indices to use (e.g. [1, 3]). Defaults to all wallets if omitted. */
  walletIndices?: number[]
  /** Optional cold vault address to sweep minted NFTs to */
  autoTransferVault?: Address
}

/**
 * High-speed Public Mint Strategy — ultra-low latency execution (<100ms pre-flight).
 */
export async function runPublicMint(opts: PublicMintOptions): Promise<void> {
  const publicClient = getPublicClient()
  const settings = getSettings()

  logger.banner()
  logger.info(`Mode: Public Mint`)
  logger.info(`Contract: ${opts.contractAddress}`)
  logger.info(`Function: ${opts.functionName}(${opts.quantity})`)
  logger.info(`Price: ${opts.priceEth} ETH × ${opts.quantity} = ${parseFloat(opts.priceEth || '0') * opts.quantity} ETH per wallet`)
  logger.info(`Gas strategy: ${opts.gasStrategy.toUpperCase()}`)
  if (opts.walletIndices && opts.walletIndices.length > 0) {
    logger.info(`Selected wallets: Wallet ${opts.walletIndices.join(', Wallet ')}`)
  }
  logger.divider()

  const preFlightStart = performance.now()
  logger.info(`⚡ [PRE-FLIGHT] Running instant parallel pre-flight (Route, Balances, Nonces, Gas)...`)

  const rawWallets = getWallets(false)
  const targetWallets = opts.walletIndices && opts.walletIndices.length > 0
    ? rawWallets.filter((w) => opts.walletIndices!.includes(w.index))
    : rawWallets

  // 1-SHOT ULTRA-FAST PARALLEL PRE-FLIGHT (Route Probe + Balances + Nonces + Gas in single network batch)
  const [probeResult, balances, nonces, feeData] = await Promise.all([
    fastProbeContract(publicClient, opts.contractAddress),
    Promise.all(targetWallets.map((w) => publicClient.getBalance({ address: w.address }))),
    Promise.all(targetWallets.map((w) => getNonce(w.address))),
    publicClient.estimateFeesPerGas().catch(() => ({ maxFeePerGas: null, maxPriorityFeePerGas: null })),
  ])

  const preFlightDurationMs = Math.round(performance.now() - preFlightStart)

  // Attach balances
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

  // Filter matched nonces for solvent wallets
  const solventNonces = solvent.map((w) => {
    const origIdx = targetWallets.findIndex((tw) => tw.index === w.index)
    return nonces[origIdx]
  })

  // Safety: total spend check
  const grandTotalEth = parseFloat(totalCostEth) * solvent.length
  if (grandTotalEth > settings.safety.maxTotalEth) {
    throw new Error(
      `Total spend (${grandTotalEth} ETH across ${solvent.length} wallets) exceeds MAX_TOTAL_ETH (${settings.safety.maxTotalEth} ETH)`,
    )
  }

  // Pre-calculate gas parameters synchronously in 0.00ms
  const estimatedGas = isSeaDrop ? 250_000n : 180_000n
  const gasParams = await estimateGasParams(
    publicClient,
    estimatedGas,
    opts.gasStrategy,
    opts.customGasPriceGwei,
    feeData,
  )

  // Resolve ABI and Routing
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

  logger.info(`✓ [PRE-FLIGHT] Ready in ${preFlightDurationMs}ms`)
  logger.info(`ℹ [ROUTING] ${isSeaDrop ? `OpenSea SeaDrop Router (${SEADROP_ROUTER_ADDRESS})` : `Direct Contract (${opts.contractAddress})`}`)
  logger.info(`ℹ [NONCES] Synchronized: ${solvent.map((w, idx) => `Wallet ${w.index} (#${solventNonces[idx]})`).join(', ')}`)
  logger.info(`ℹ [GAS] ${opts.gasStrategy.toUpperCase()} | MaxFee: ${formatGwei(gasParams.maxFeePerGas)} Gwei | PriorityFee: ${formatGwei(gasParams.maxPriorityFeePerGas)} Gwei`)
  logger.fire(`🚀 [DISPATCH] Firing ${solvent.length} wallet(s) simultaneously!`)

  const results = await executeParallelMint(publicClient, solvent, {
    contractAddress: targetAddress,
    abi: targetAbi,
    functionName: targetFunctionName,
    args: targetArgs,
    valueEth: totalCostEth,
    gasStrategy: opts.gasStrategy,
    customGasPriceGwei: opts.customGasPriceGwei,
  }, solventNonces, gasParams)

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
