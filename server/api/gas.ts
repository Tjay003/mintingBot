import { Router } from 'express'
import { getPublicClient } from '../../src/wallets/manager.js'
import { formatGwei } from 'viem'
import { getEthUsdtPrice, calcGasCostUsdt } from '../utils/price.js'

const router = Router()

/** GET /api/gas — current gas prices on Robinhood Chain with USDT conversions */
router.get('/', async (_req, res) => {
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
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export { router as gasRouter }
