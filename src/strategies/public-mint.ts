import { parseEther, type Address, type Abi } from 'viem'
import { getPublicClient, getWallets, loadBalances, filterSolventWallets, getNonce } from '../wallets/manager.js'
import { executeParallelMint, COMMON_MINT_ABIS } from '../core/tx-builder.js'
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
  logger.divider()

  const publicClient = getPublicClient()
  const settings = getSettings()

  // Load and filter wallets by balance
  const wallets = await loadBalances()
  const totalCostEth = (parseFloat(opts.priceEth) * opts.quantity).toString()
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

  // Fetch nonces for all wallets
  const nonces = await Promise.all(solvent.map((w) => getNonce(w.address)))

  logger.fire(`Minting from ${solvent.length} wallet(s)...`)

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
