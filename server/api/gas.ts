import { Router } from 'express'
import { getPublicClient } from '../../src/wallets/manager.js'
import { printGasSummary } from '../../src/core/gas-manager.js'
import { formatGwei } from 'viem'

const router = Router()

/** GET /api/gas — current gas prices on Robinhood Chain */
router.get('/', async (_req, res) => {
  try {
    const client = getPublicClient()
    const feeData = await client.estimateFeesPerGas()
    const base = feeData.maxFeePerGas ?? 0n
    const priority = feeData.maxPriorityFeePerGas ?? 0n

    res.json({
      baseFeeGwei: parseFloat(formatGwei(base)).toFixed(6),
      priorityFeeGwei: parseFloat(formatGwei(priority)).toFixed(6),
      strategies: {
        safe: parseFloat(formatGwei(base)).toFixed(6),
        fast: parseFloat(formatGwei((base * 150n) / 100n)).toFixed(6),
        turbo: parseFloat(formatGwei((base * 250n) / 100n)).toFixed(6),
      },
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export { router as gasRouter }
