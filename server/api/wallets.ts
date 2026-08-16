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

function getNonWalletLines(lines: string[]): string[] {
  return lines.filter((l) => !l.trim().startsWith('WALLET_KEY_') && !l.trim().startsWith('WALLET_LABEL_'))
}

function parseEnvWallets(lines: string[]): { key: string; label?: string }[] {
  const keyMap: Record<number, string> = {}
  const labelMap: Record<number, string> = {}

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('WALLET_KEY_')) {
      const match = trimmed.match(/^WALLET_KEY_(\d+)=(.*)$/)
      if (match) {
        const slot = parseInt(match[1], 10)
        const key = match[2].trim()
        if (key.startsWith('0x') && key.length === 66) {
          keyMap[slot] = key
        }
      }
    } else if (trimmed.startsWith('WALLET_LABEL_')) {
      const match = trimmed.match(/^WALLET_LABEL_(\d+)=(.*)$/)
      if (match) {
        const slot = parseInt(match[1], 10)
        const label = match[2].trim()
        if (label) {
          labelMap[slot] = label
        }
      }
    }
  }

  const slots = Object.keys(keyMap).map(Number).sort((a, b) => a - b)
  return slots.map((slot) => ({ key: keyMap[slot], label: labelMap[slot] }))
}

function serializeEnvWithWallets(nonWalletLines: string[], wallets: { key: string; label?: string }[]): string {
  let content = nonWalletLines.join('\n').trim()
  content += '\n\n# Wallet Private Keys & Labels\n'
  wallets.forEach((w, i) => {
    content += `WALLET_KEY_${i + 1}=${w.key}\n`
    if (w.label) {
      content += `WALLET_LABEL_${i + 1}=${w.label}\n`
    }
  })
  return content
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
        label: w.label || `Wallet ${w.index}`,
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

/** PUT /api/wallets/:index/label — rename a wallet */
router.put('/:index/label', (req, res) => {
  const idx = parseInt(req.params.index, 10)
  const { label } = req.body as { label?: string }
  if (isNaN(idx) || idx < 1) {
    res.status(400).json({ error: 'Invalid wallet index.' })
    return
  }

  try {
    const envContent = readEnvFile()
    const lines = envContent.split('\n')
    const nonWalletLines = getNonWalletLines(lines)
    const wallets = parseEnvWallets(lines)

    if (idx > wallets.length) {
      res.status(404).json({ error: `Wallet ${idx} not found.` })
      return
    }

    wallets[idx - 1].label = (label || '').trim() || undefined

    writeEnvFile(serializeEnvWithWallets(nonWalletLines, wallets))
    resetSettings()
    resetWallets()

    res.json({ success: true, index: idx, label: wallets[idx - 1].label || `Wallet ${idx}` })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /api/wallets — add a new wallet by private key */
router.post('/', (req, res) => {
  const { privateKey, label } = req.body as { privateKey?: string; label?: string }

  if (!privateKey || !privateKey.startsWith('0x') || privateKey.length !== 66) {
    res.status(400).json({ error: 'Invalid private key. Must be 0x-prefixed 64-character hex.' })
    return
  }

  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`)
    const envContent = readEnvFile()
    const lines = envContent.split('\n')
    const nonWalletLines = getNonWalletLines(lines)
    const wallets = parseEnvWallets(lines)

    // Check if key already exists
    if (!wallets.some((w) => w.key.toLowerCase() === privateKey.toLowerCase())) {
      wallets.push({ key: privateKey, label: (label || '').trim() || undefined })
    }

    writeEnvFile(serializeEnvWithWallets(nonWalletLines, wallets))
    resetSettings()
    resetWallets()

    res.json({ success: true, address: account.address, slot: wallets.length })
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
    const nonWalletLines = getNonWalletLines(lines)
    const wallets = parseEnvWallets(lines)

    if (idx > wallets.length) {
      res.status(404).json({ error: `Wallet ${idx} not found.` })
      return
    }

    // Remove wallet at idx - 1
    wallets.splice(idx - 1, 1)

    writeEnvFile(serializeEnvWithWallets(nonWalletLines, wallets))
    resetSettings()
    resetWallets()

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export { router as walletsRouter }
