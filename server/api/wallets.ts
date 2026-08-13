import { Router } from 'express'
import { getWallets, loadBalances, resetWallets, type ManagedWallet } from '../../src/wallets/manager.js'
import { formatEther } from 'viem'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { privateKeyToAccount } from 'viem/accounts'
import { resetSettings } from '../../src/config/settings.js'
import { getEthUsdtPrice, calcEthToUsdt } from '../utils/price.js'

const router = Router()
const ENV_PATH = join(process.cwd(), '.env')

function readEnvFile(): string {
  if (!existsSync(ENV_PATH)) return ''
  return readFileSync(ENV_PATH, 'utf-8')
}

function writeEnvFile(content: string): void {
  writeFileSync(ENV_PATH, content, 'utf-8')
}

/** GET /api/wallets — list all wallets with balances & USDT value */
router.get('/', async (_req, res) => {
  try {
    const wallets = await loadBalances(false, true)
    const ethPriceUsdt = await getEthUsdtPrice()

    const data = wallets.map((w: ManagedWallet) => {
      const ethNum = parseFloat(formatEther(w.balance ?? 0n))
      return {
        index: w.index,
        address: w.address,
        balanceWei: w.balance?.toString() ?? '0',
        balanceEth: ethNum.toFixed(4),
        balanceUsdt: calcEthToUsdt(ethNum, ethPriceUsdt),
      }
    })
    res.json({ ethPriceUsdt, wallets: data })
  } catch (err) {
    res.json({ wallets: [] })
  }
})

/** POST /api/wallets — add a new wallet by private key */
router.post('/', (req, res) => {
  const { privateKey } = req.body as { privateKey?: string }

  if (!privateKey || !privateKey.startsWith('0x') || privateKey.length !== 66) {
    res.status(400).json({ error: 'Invalid private key. Must be 0x-prefixed 64-character hex.' })
    return
  }

  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`)
    let envContent = readEnvFile()

    // Collect existing valid keys
    const lines = envContent.split('\n')
    const nonWalletLines = lines.filter((l) => !l.trim().startsWith('WALLET_KEY_'))
    const existingKeys = lines
      .filter((l) => l.trim().startsWith('WALLET_KEY_'))
      .map((l) => l.split('=')[1]?.trim())
      .filter((k): k is string => Boolean(k) && k.startsWith('0x') && k.length === 66 && k !== privateKey)

    // Add new key
    existingKeys.push(privateKey)

    // Rebuild env content
    let newEnv = nonWalletLines.join('\n').trim()
    newEnv += '\n\n# Wallet Private Keys\n'
    existingKeys.forEach((key, i) => {
      newEnv += `WALLET_KEY_${i + 1}=${key}\n`
    })

    writeEnvFile(newEnv)
    resetSettings()
    resetWallets()

    res.json({ success: true, address: account.address, slot: existingKeys.length })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** DELETE /api/wallets/:index — remove a wallet by its slot index */
router.delete('/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10)
  if (isNaN(idx) || idx < 1) {
    res.status(400).json({ error: 'Invalid wallet index.' })
    return
  }

  try {
    const envContent = readEnvFile()
    const lines = envContent.split('\n')
    const nonWalletLines = lines.filter((l) => !l.trim().startsWith('WALLET_KEY_'))
    const walletKeys = lines
      .filter((l) => l.trim().startsWith('WALLET_KEY_'))
      .map((l) => l.split('=')[1]?.trim())
      .filter((k): k is string => Boolean(k) && k.startsWith('0x') && k.length === 66)

    if (idx > walletKeys.length) {
      res.status(404).json({ error: `Wallet ${idx} not found.` })
      return
    }

    // Remove key at idx - 1
    walletKeys.splice(idx - 1, 1)

    // Rebuild env content
    let newEnv = nonWalletLines.join('\n').trim()
    newEnv += '\n\n# Wallet Private Keys\n'
    walletKeys.forEach((key, i) => {
      newEnv += `WALLET_KEY_${i + 1}=${key}\n`
    })

    writeEnvFile(newEnv)
    resetSettings()
    resetWallets()

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export { router as walletsRouter }
