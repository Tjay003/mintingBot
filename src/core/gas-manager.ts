import { parseGwei, formatGwei, type PublicClient } from 'viem'
import { getSettings } from '../config/settings.js'
import { logger } from '../utils/logger.js'

export type GasStrategy = 'safe' | 'fast' | 'turbo' | 'custom'

const STRATEGY_MULTIPLIERS: Record<GasStrategy, number> = {
  safe: 1.0,    // Baseline — cheapest but might be slow
  fast: 1.5,    // 50% higher — good balance for most mints
  turbo: 2.5,   // 2.5x — for hot FCFS races where speed is everything
  custom: 1.0,  // Override via customGasPrice
}

export interface GasParams {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  gas: bigint
}

/**
 * Estimate optimal gas parameters based on current network conditions.
 * Applies strategy multiplier and enforces MAX_GAS_PRICE_GWEI safety limit.
 */
export async function estimateGasParams(
  publicClient: PublicClient,
  estimatedGas: bigint,
  strategy: GasStrategy = 'fast',
  customGasPriceGwei?: number,
): Promise<GasParams> {
  const settings = getSettings()
  const maxAllowedWei = parseGwei(settings.safety.maxGasPriceGwei.toString())

  // Fetch current fee data from chain
  const feeData = await publicClient.estimateFeesPerGas()
  const baseFee = feeData.maxFeePerGas ?? parseGwei('1')
  const priorityFee = feeData.maxPriorityFeePerGas ?? parseGwei('0.001')

  let targetGasPrice: bigint
  if (strategy === 'custom' && customGasPriceGwei != null) {
    targetGasPrice = parseGwei(customGasPriceGwei.toString())
  } else {
    const multiplier = BigInt(Math.round(STRATEGY_MULTIPLIERS[strategy] * 100))
    targetGasPrice = (baseFee * multiplier) / 100n
  }

  // Safety cap
  if (targetGasPrice > maxAllowedWei) {
    const targetGwei = parseFloat(formatGwei(targetGasPrice)).toFixed(2)
    const maxGwei = settings.safety.maxGasPriceGwei
    logger.warn(`Gas price ${targetGwei} Gwei exceeds limit ${maxGwei} Gwei — capping`)
    targetGasPrice = maxAllowedWei
  }

  // Add 20% buffer to estimated gas to avoid out-of-gas failures
  const gasWithBuffer = (estimatedGas * 120n) / 100n

  return {
    maxFeePerGas: targetGasPrice,
    maxPriorityFeePerGas: priorityFee < targetGasPrice ? priorityFee : targetGasPrice,
    gas: gasWithBuffer,
  }
}

/**
 * Log current gas prices on the network.
 */
export async function printGasSummary(publicClient: PublicClient): Promise<void> {
  const feeData = await publicClient.estimateFeesPerGas()
  const base = feeData.maxFeePerGas ?? 0n
  const priority = feeData.maxPriorityFeePerGas ?? 0n

  logger.info(`Current gas prices on Robinhood Chain:`)
  logger.info(`  Base fee:      ${parseFloat(formatGwei(base)).toFixed(4)} Gwei`)
  logger.info(`  Priority fee:  ${parseFloat(formatGwei(priority)).toFixed(4)} Gwei`)
  logger.info(`  Safe  (1.0x):  ${parseFloat(formatGwei(base)).toFixed(4)} Gwei`)
  logger.info(`  Fast  (1.5x):  ${parseFloat(formatGwei((base * 150n) / 100n)).toFixed(4)} Gwei`)
  logger.info(`  Turbo (2.5x):  ${parseFloat(formatGwei((base * 250n) / 100n)).toFixed(4)} Gwei`)
}
