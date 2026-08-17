import { Router } from 'express'
import { getPublicClient } from '../../src/wallets/manager.js'
import { formatGwei } from 'viem'
import { getEthUsdtPrice, calcGasCostUsdt } from '../utils/price.js'

const router = Router()

/** GET /api/gas and /api/gas/current — current gas prices on Robinhood Chain with USDT conversions */
const handleGas = async (_req: any, res: any) => {
  try {
    const client = getPublicClient()
    const feeData = await client.estimateFeesPerGas()
    const base = feeData.maxFeePerGas ?? 0n
    const priority = feeData.maxPriorityFeePerGas ?? 0n

    const ethPriceUsdt = await getEthUsdtPrice()

    const safeGwei = parseFloat(formatGwei(base))
    const fastGwei = parseFloat(formatGwei((base * 150n) / 100n))
    const turboGwei = parseFloat(formatGwei((base * 250n) / 100n))

    res.json({
      ethPriceUsdt,
      baseFeeGwei: safeGwei.toFixed(6),
      priorityFeeGwei: parseFloat(formatGwei(priority)).toFixed(6),
      strategies: {
        safe: {
          gwei: safeGwei.toFixed(4),
          usdtEst: calcGasCostUsdt(safeGwei, ethPriceUsdt),
        },
        fast: {
          gwei: fastGwei.toFixed(4),
          usdtEst: calcGasCostUsdt(fastGwei, ethPriceUsdt),
        },
        turbo: {
          gwei: turboGwei.toFixed(4),
          usdtEst: calcGasCostUsdt(turboGwei, ethPriceUsdt),
        },
      },
      rates: {
        safe: { maxFeeGwei: safeGwei.toFixed(4) },
        fast: { maxFeeGwei: fastGwei.toFixed(4) },
        turbo: { maxFeeGwei: turboGwei.toFixed(4) },
      },
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

router.get('/', handleGas)
router.get('/current', handleGas)

export { router as gasRouter }
