import { Router } from 'express'
import { getSession, setSession, resetSession, type SessionMode } from '../session.js'
import { resolveTarget } from '../../src/utils/opensea-resolver.js'
import { runPublicMint } from '../../src/strategies/public-mint.js'
import { runSnipeMint } from '../../src/strategies/snipe-mint.js'
import { runWhitelistMint, type WlMode } from '../../src/strategies/whitelist-mint.js'
import { runScheduledMint } from '../../src/strategies/scheduled-mint.js'
import type { GasStrategy } from '../../src/core/gas-manager.js'
import { logger } from '../../src/utils/logger.js'

const router = Router()

/** GET /api/session — current session status */
router.get('/', (_req, res) => {
  const session = getSession()
  res.json({
    status: session.status,
    mode: session.mode,
    target: session.target,
    contractAddress: session.contractAddress,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    blocksChecked: session.blocksChecked,
    saleActive: session.saleActive,
    error: session.error,
    quantity: session.quantity,
    priceEth: session.priceEth,
    gasStrategy: session.gasStrategy,
    mintTime: session.mintTime,
    selectedWallets: session.selectedWallets,
  })
})

/** POST /api/session/start — start a mint/snipe session */
router.post('/start', async (req, res) => {
  const current = getSession()
  if (current.status === 'running') {
    res.status(400).json({ error: 'A session is already running. Stop it first.' })
    return
  }

  const {
    mode,
    target,
    quantity = 1,
    priceEth = '0',
    functionName = 'mint',
    gasStrategy = 'fast',
    customGasPriceGwei,
    wlMode,
    proof,
    signature,
    mintTime,
    selectedWallets,
    autoTransferVault,
  } = req.body as {
    mode: SessionMode
    target: string
    quantity?: number
    priceEth?: string
    functionName?: string
    gasStrategy?: GasStrategy
    customGasPriceGwei?: number
    wlMode?: WlMode
    proof?: string
    signature?: string
    mintTime?: string
    selectedWallets?: number[]
    autoTransferVault?: string
  }

  if (!mode || !target) {
    res.status(400).json({ error: 'Missing required parameters: mode, target.' })
    return
  }

  try {
    const resolved = await resolveTarget(target)
    const abortController = new AbortController()

    setSession({
      status: 'running',
      mode,
      target,
      contractAddress: resolved.contractAddress,
      startedAt: new Date(),
      blocksChecked: 0,
      saleActive: null,
      error: undefined,
      abortController,
      quantity: Number(quantity),
      priceEth,
      gasStrategy,
      mintTime,
      selectedWallets,
      autoTransferVault,
    })

    res.json({ success: true, message: `Session started (${mode})`, target: resolved.contractAddress })

    // Execute session in background asynchronously
    ;(async () => {
      try {
        const vault = autoTransferVault && autoTransferVault.startsWith('0x') && autoTransferVault.length === 42
          ? (autoTransferVault as `0x${string}`)
          : undefined

        if (mode === 'public') {
          await runPublicMint({
            contractAddress: resolved.contractAddress,
            functionName,
            quantity: Number(quantity),
            priceEth,
            gasStrategy,
            customGasPriceGwei,
            walletIndices: selectedWallets,
            autoTransferVault: vault,
          })
        } else if (mode === 'snipe') {
          await runSnipeMint({
            contractAddress: resolved.contractAddress,
            functionName,
            quantity: Number(quantity),
            priceEth,
            gasStrategy,
            customGasPriceGwei,
            signal: abortController.signal,
            walletIndices: selectedWallets,
            autoTransferVault: vault,
          })
        } else if (mode === 'whitelist') {
          let parsedProof: `0x${string}`[] | undefined
          if (proof) {
            try {
              parsedProof = typeof proof === 'string' ? JSON.parse(proof) : proof
            } catch {
              throw new Error('Invalid JSON proof array')
            }
          }
          await runWhitelistMint({
            contractAddress: resolved.contractAddress,
            wlMode: wlMode || (proof ? 'merkle-proof' : signature ? 'signature' : 'on-chain'),
            merkleProof: parsedProof,
            signature: signature as `0x${string}` | undefined,
            functionName,
            quantity: Number(quantity),
            priceEth,
            gasStrategy,
            customGasPriceGwei,
            walletIndices: selectedWallets,
            autoTransferVault: vault,
          })
        } else if (mode === 'scheduled') {
          if (!mintTime) throw new Error('Missing mintTime for scheduled mint')
          await runScheduledMint({
            contractAddress: resolved.contractAddress,
            functionName,
            quantity: Number(quantity),
            priceEth,
            mintTime,
            gasStrategy,
            customGasPriceGwei,
            walletIndices: selectedWallets,
            signal: abortController.signal,
            autoTransferVault: vault,
          })
        }

        setSession({ status: 'success', endedAt: new Date() })
      } catch (err) {
        const errorMsg = String(err)
        logger.error(`Session failed: ${errorMsg}`)
        setSession({ status: 'error', error: errorMsg, endedAt: new Date() })
      }
    })()

  } catch (err) {
    resetSession()
    res.status(400).json({ error: String(err) })
  }
})

/** POST /api/session/stop — stop active running session */
router.post('/stop', (_req, res) => {
  const session = getSession()
  if (session.status !== 'running') {
    res.status(400).json({ error: 'No running session to stop.' })
    return
  }

  if (session.abortController) {
    session.abortController.abort()
  }

  setSession({ status: 'idle', endedAt: new Date() })
  res.json({ success: true, message: 'Session stopped.' })
})

export { router as sessionRouter }
