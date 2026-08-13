import { Router } from 'express'
import { resolveTarget } from '../../src/utils/opensea-resolver.js'
import { analyzeContract } from '../../src/utils/contract-analyzer.js'
import { getPublicClient } from '../../src/wallets/manager.js'

const router = Router()

/** POST /api/analyze — resolve a URL and analyze the contract */
router.post('/', async (req, res) => {
  const { target } = req.body as { target?: string }
  if (!target) {
    res.status(400).json({ error: 'Missing target (OpenSea URL or contract address).' })
    return
  }
  try {
    const resolved = await resolveTarget(target)
    const client = getPublicClient()
    const analysis = await analyzeContract(client, resolved.contractAddress)
    res.json({
      resolved,
      analysis: {
        contractAddress: analysis.contractAddress,
        isVerified: analysis.isVerified,
        isSeaDrop: analysis.isSeaDrop ?? false,
        wlType: analysis.wlType,
        saleActive: analysis.saleActive ?? null,
        saleStateFn: analysis.saleStateFn ?? null,
        mintPriceEth: analysis.mintPriceEth ?? null,
        maxPerWallet: analysis.maxPerWallet?.toString() ?? null,
        totalSupply: analysis.totalSupply?.toString() ?? null,
        maxSupply: analysis.maxSupply?.toString() ?? null,
        mintFunctions: analysis.mintFunctions,
        detectedMintFn: analysis.detectedMintFn ?? null,
        seaDropInfo: analysis.seaDropInfo ?? null,
      },
    })
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

export { router as analyzeRouter }
