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
import { analyzeContract } from '../utils/contract-analyzer.js'
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
 * Public mint: fires all configured wallets simultaneously.
 * This is the baseline mint — no whitelist, no scheduling.
 */
export async function runPublicMint(opts: PublicMintOptions): Promise<void> {
  logger.banner()
  logger.info(`Mode: Public Mint`)
  logger.info(`Contract: ${opts.contractAddress}`)
  logger.info(`Function: ${opts.functionName}(${opts.quantity})`)
  logger.info(`Price: ${opts.priceEth} ETH × ${opts.quantity} = ${parseFloat(opts.priceEth) * opts.quantity} ETH per wallet`)
  logger.info(`Gas strategy: ${opts.gasStrategy}`)
  if (opts.walletIndices && opts.walletIndices.length > 0) {
    logger.info(`Selected wallets: Wallet ${opts.walletIndices.join(', Wallet ')}`)
  }
  logger.divider()

  const publicClient = getPublicClient()
  const settings = getSettings()

  // Concurrently analyze contract & load wallet balances in parallel (0ms Blockscout bypass)
  const [analysis, wallets] = await Promise.all([
    analyzeContract(publicClient, opts.contractAddress, false, false, true),
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
  if (solvent.length === 0) {
    throw new Error('No wallets have sufficient balance to mint.')
  }

  // Safety: total spend check
  const grandTotalEth = parseFloat(totalCostEth) * solvent.length
  if (grandTotalEth > settings.safety.maxTotalEth) {
    throw new Error(
      `Total spend (${grandTotalEth} ETH across ${solvent.length} wallets) exceeds MAX_TOTAL_ETH (${settings.safety.maxTotalEth} ETH)`,
    )
  }

  // Resolve ABI
  const sigKey = `${opts.functionName}(uint256)`
  const resolvedAbi: Abi = opts.abi ?? [COMMON_MINT_ABIS[sigKey] ?? COMMON_MINT_ABIS['mint(uint256)']]

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

  // Fetch nonces for all wallets
  const nonces = await Promise.all(solvent.map((w) => getNonce(w.address)))

  logger.fire(`Minting from ${solvent.length} wallet(s)...`)

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
