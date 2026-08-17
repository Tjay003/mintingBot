import { Router } from 'express'
import { formatEther } from 'viem'
import { loadBalances } from '../../src/wallets/manager.js'
import { resolveTarget } from '../../src/utils/opensea-resolver.js'
import { runPublicMint } from '../../src/strategies/public-mint.js'
import { runWhitelistMint } from '../../src/strategies/whitelist-mint.js'
import { getSession, setSession, resetSession } from '../session.js'
import { getSettings } from '../../src/config/settings.js'
import type { GasStrategy } from '../../src/core/gas-manager.js'
import { logger } from '../../src/utils/logger.js'

const router = Router()

/** Cached ETH price in USDT */
let cachedEthPriceUsdt: number = 2200

async function fetchEthPriceUsdt(): Promise<number> {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', {
      headers: { Accept: 'application/json' },
    })
    if (res.ok) {
      const data = (await res.json()) as { price?: string }
      if (data.price) {
        cachedEthPriceUsdt = parseFloat(data.price)
      }
    }
  } catch {}
  return cachedEthPriceUsdt
}

/**
 * GET /api/extension/status — Status endpoint for Chrome Extension
 */
router.get('/status', async (_req, res) => {
  try {
    const settings = getSettings()
    const [wallets, ethPrice] = await Promise.all([
      loadBalances(false, true),
      fetchEthPriceUsdt(),
    ])

    const session = getSession()

    res.json({
      connected: true,
      version: '1.0.0',
      recipientAddress: settings.recipientAddress || settings.autoTransferVault || '',
      activeSession: session.status === 'running'
        ? {
            status: session.status,
            target: session.target,
            mode: session.mode,
            autoTransferVault: session.autoTransferVault,
          }
        : null,
      ethPriceUsdt: ethPrice,
      walletsCount: wallets.length,
      wallets: wallets.map((w) => {
        const ethValStr = w.balance ? parseFloat(formatEther(w.balance)).toFixed(4) : '0.0000'
        const ethVal = parseFloat(ethValStr)
        const usdtVal = (ethVal * ethPrice).toFixed(2)
        return {
          index: w.index,
          label: w.label || `Wallet ${w.index}`,
          address: w.address,
          balanceEth: ethValStr,
          balanceUsdt: `$${parseFloat(usdtVal).toLocaleString()}`,
        }
      }),
    })
  } catch (err: any) {
    res.status(500).json({ connected: false, error: err.message })
  }
})

/**
 * POST /api/extension/mint — 1-Click Mint Trigger from Chrome Extension
 */
router.post('/mint', async (req, res) => {
  const current = getSession()
  if (current.status === 'running') {
    res.status(400).json({ error: 'A minting session is already running in MintBot.' })
    return
  }

  const {
    target,
    quantity = 1,
    priceEth = '0',
    gasStrategy = 'turbo',
    walletIndices,
    mode = 'public',
    autoTransferVault,
  } = req.body as {
    target?: string
    quantity?: number
    priceEth?: string
    gasStrategy?: GasStrategy
    walletIndices?: number[]
    mode?: 'public' | 'whitelist'
    autoTransferVault?: string
  }

  if (!target) {
    res.status(400).json({ error: 'Target (OpenSea URL or contract address) is required.' })
    return
  }

  try {
    const resolved = await resolveTarget(target)
    const vault = autoTransferVault && autoTransferVault.startsWith('0x') && autoTransferVault.length === 42
      ? (autoTransferVault as `0x${string}`)
      : undefined

    setSession({
      status: 'running',
      mode: mode === 'whitelist' ? 'whitelist' : 'public',
      target,
      contractAddress: resolved.contractAddress,
      startedAt: new Date(),
      quantity: Number(quantity) || 1,
      priceEth: String(priceEth),
      gasStrategy: (gasStrategy as GasStrategy) || 'turbo',
      selectedWallets: walletIndices,
      autoTransferVault,
    })

    logger.banner()
    logger.info(`⚡ [Chrome Extension Bridge] Mint triggered`)
    logger.info(`Target: ${resolved.contractAddress} | Qty: ${quantity} | Gas: ${gasStrategy}`)
    if (vault) logger.info(`Auto-Transfer Cold Vault: ${vault}`)

    res.json({
      success: true,
      message: `Minting session started across ${walletIndices?.length || 'all'} wallet(s).`,
      contractAddress: resolved.contractAddress,
    })

    // Execute in background
    ;(async () => {
      try {
        if (mode === 'whitelist') {
          await runWhitelistMint({
            contractAddress: resolved.contractAddress,
            wlMode: 'on-chain',
            quantity: Number(quantity) || 1,
            priceEth: String(priceEth),
            gasStrategy: (gasStrategy as GasStrategy) || 'turbo',
            walletIndices,
            autoTransferVault: vault,
          })
        } else {
          await runPublicMint({
            contractAddress: resolved.contractAddress,
            functionName: 'mint',
            quantity: Number(quantity) || 1,
            priceEth: String(priceEth),
            gasStrategy: (gasStrategy as GasStrategy) || 'turbo',
            walletIndices,
            autoTransferVault: vault,
          })
        }
        setSession({ status: 'success', endedAt: new Date() })
      } catch (err: any) {
        logger.error(`[Extension Bridge] Execution error: ${err.message}`)
        setSession({ status: 'error', error: err.message, endedAt: new Date() })
      }
    })()
  } catch (err: any) {
    logger.error(`[Extension Bridge] Error: ${err.message}`)
    res.status(400).json({ error: err.message })
  }
})

export { router as extensionRouter }

