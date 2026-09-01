import { parseEther, type Address, type Abi } from 'viem'
import { getPublicClient, getWallets, loadBalances, filterSolventWallets, getNonce } from '../wallets/manager.js'
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
import { getSettings } from '../config/settings.js'
import { logger } from '../utils/logger.js'
import type { GasStrategy } from '../core/gas-manager.js'

export type WlMode = 'merkle-proof' | 'signature' | 'on-chain'

export interface WhitelistMintOptions {
  contractAddress: Address
  /** Which WL type to use */
  wlMode: WlMode
  /** Merkle proof array — required for merkle-proof mode */
  merkleProof?: `0x${string}`[]
  /** Signature hex string — required for signature mode */
  signature?: `0x${string}`
  /** Function name override */
  functionName?: string
  /** ABI override */
  abi?: Abi
  quantity: number
  priceEth: string
  gasStrategy: GasStrategy
  customGasPriceGwei?: number
  walletIndices?: number[]
  /** Optional cold vault address to sweep minted NFTs to */
  autoTransferVault?: Address
}

/**
 * Whitelist mint strategy.
 * Supports three modes:
 *  - merkle-proof: calls mint(quantity, proof[]) or SeaDrop allowlist
 *  - signature:    calls mint(quantity, sig)
 *  - on-chain:     calls mint(quantity) or SeaDrop router for registered wallets
 */
export async function runWhitelistMint(opts: WhitelistMintOptions): Promise<void> {
  const publicClient = getPublicClient()
  const settings = getSettings()

  const preFlightStart = performance.now()
  logger.info(`⚡ [PRE-FLIGHT] Initializing whitelist mint pre-flight (Wallets, Balances, Route)...`)

  const rawWallets = getWallets(false)
  const targetWallets = opts.walletIndices && opts.walletIndices.length > 0
    ? rawWallets.filter((w) => opts.walletIndices!.includes(w.index))
    : rawWallets

  // Parallel pre-flight
  const [probeResult, balances] = await Promise.all([
    fastProbeContract(publicClient, opts.contractAddress),
    Promise.all(targetWallets.map((w) => publicClient.getBalance({ address: w.address }))),
  ])
  const preFlightDurationMs = Math.round(performance.now() - preFlightStart)

  targetWallets.forEach((w, i) => {
    w.balance = balances[i]
  })

  const isSeaDrop = Boolean(probeResult.isSeaDrop)

  let effectivePriceEth = opts.priceEth?.trim()
  if (!effectivePriceEth || effectivePriceEth.toLowerCase() === 'auto' || (parseFloat(effectivePriceEth) === 0 && probeResult.mintPriceEth && parseFloat(probeResult.mintPriceEth) > 0)) {
    if (probeResult.mintPriceEth) {
      effectivePriceEth = probeResult.mintPriceEth
      logger.info(`✓ [PRICE] Auto-detected on-chain price: ${effectivePriceEth} ETH`)
    }
  }

  logger.banner()
  logger.info(`Mode: Whitelist Mint (${opts.wlMode})`)
  logger.info(`Contract: ${opts.contractAddress}`)
  logger.info(`Price: ${effectivePriceEth} ETH × ${opts.quantity} per wallet`)
  logger.info(`Gas strategy: ${opts.gasStrategy.toUpperCase()}`)
  logger.divider()

  let targetAddress: Address = opts.contractAddress
  let targetAbi: Abi
  let targetFunctionName: string
  let targetArgs: unknown[]

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
  } else if (opts.wlMode === 'merkle-proof') {
    if (!opts.merkleProof || opts.merkleProof.length === 0) {
      throw new Error('Merkle proof is required for merkle-proof WL mode. Use --proof <json>.')
    }
    targetFunctionName = opts.functionName ?? 'mint'
    const sigKey = `${targetFunctionName}(uint256,bytes32[])`
    targetAbi = opts.abi ?? [COMMON_MINT_ABIS[sigKey] ?? COMMON_MINT_ABIS['mint(uint256,bytes32[])']]
    targetArgs = [BigInt(opts.quantity), opts.merkleProof]

  } else if (opts.wlMode === 'signature') {
    if (!opts.signature) {
      throw new Error('Signature is required for signature-based WL mode. Use --signature <hex>.')
    }
    targetFunctionName = opts.functionName ?? 'mint'
    targetAbi = opts.abi ?? [COMMON_MINT_ABIS['mint(uint256,bytes)']]
    targetArgs = [BigInt(opts.quantity), opts.signature]

  } else {
    // on-chain: wallet is already registered, just call mint(quantity)
    targetFunctionName = opts.functionName ?? 'mint'
    const sigKey = `${targetFunctionName}(uint256)`
    targetAbi = opts.abi ?? [COMMON_MINT_ABIS[sigKey] ?? COMMON_MINT_ABIS['mint(uint256)']]
    targetArgs = [BigInt(opts.quantity)]
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

  const nonces = await Promise.all(solvent.map((w) => getNonce(w.address)))

  logger.info(`✓ [PRE-FLIGHT] Completed in ${preFlightDurationMs}ms (${solvent.length} solvent wallet(s) armed)`)
  logger.info(`ℹ [ROUTING] ${isSeaDrop ? `OpenSea SeaDrop Router (${SEADROP_ROUTER_ADDRESS})` : `Direct Contract (${opts.contractAddress})`}`)
  logger.info(`ℹ [NONCES] Synchronized: ${solvent.map((w, idx) => `Wallet ${w.index} (#${nonces[idx]})`).join(', ')}`)
  logger.fire(`🚀 [DISPATCH] Firing WL mint for ${solvent.length} wallet(s)...`)

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
}
