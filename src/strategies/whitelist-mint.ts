import { parseEther, type Address, type Abi } from 'viem'
import { getPublicClient, getWallets, loadBalances, filterSolventWallets, getNonce } from '../wallets/manager.js'
import { executeParallelMint, COMMON_MINT_ABIS } from '../core/tx-builder.js'
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
}

/**
 * Whitelist mint strategy.
 * Supports three modes:
 *  - merkle-proof: calls mint(quantity, proof[])
 *  - signature:    calls mint(quantity, sig)
 *  - on-chain:     calls mint(quantity) — wallet is already registered on-chain
 */
export async function runWhitelistMint(opts: WhitelistMintOptions): Promise<void> {
  logger.banner()
  logger.info(`Mode: Whitelist Mint (${opts.wlMode})`)
  logger.info(`Contract: ${opts.contractAddress}`)
  logger.info(`Price: ${opts.priceEth} ETH × ${opts.quantity} per wallet`)
  logger.info(`Gas strategy: ${opts.gasStrategy}`)
  logger.divider()

  const publicClient = getPublicClient()
  const settings = getSettings()

  // Resolve mint function + ABI based on WL mode
  let functionName: string
  let resolvedAbi: Abi
  let args: unknown[]

  if (opts.wlMode === 'merkle-proof') {
    if (!opts.merkleProof || opts.merkleProof.length === 0) {
      throw new Error('Merkle proof is required for merkle-proof WL mode. Use --proof <json>.')
    }
    functionName = opts.functionName ?? 'mint'
    const sigKey = `${functionName}(uint256,bytes32[])`
    resolvedAbi = opts.abi ?? [COMMON_MINT_ABIS[sigKey] ?? COMMON_MINT_ABIS['mint(uint256,bytes32[])']]
    args = [BigInt(opts.quantity), opts.merkleProof]

  } else if (opts.wlMode === 'signature') {
    if (!opts.signature) {
      throw new Error('Signature is required for signature-based WL mode. Use --signature <hex>.')
    }
    functionName = opts.functionName ?? 'mint'
    resolvedAbi = opts.abi ?? [COMMON_MINT_ABIS['mint(uint256,bytes)']]
    args = [BigInt(opts.quantity), opts.signature]

  } else {
    // on-chain: wallet is already registered, just call mint(quantity)
    functionName = opts.functionName ?? 'mint'
    const sigKey = `${functionName}(uint256)`
    resolvedAbi = opts.abi ?? [COMMON_MINT_ABIS[sigKey] ?? COMMON_MINT_ABIS['mint(uint256)']]
    args = [BigInt(opts.quantity)]
  }

  const totalCostEth = (parseFloat(opts.priceEth) * opts.quantity).toString()
  const totalCostWei = parseEther(totalCostEth)

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

  const nonces = await Promise.all(solvent.map((w) => getNonce(w.address)))

  logger.fire(`WL minting from ${solvent.length} wallet(s)...`)

  const results = await executeParallelMint(publicClient, solvent, {
    contractAddress: opts.contractAddress,
    abi: resolvedAbi,
    functionName,
    args,
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
