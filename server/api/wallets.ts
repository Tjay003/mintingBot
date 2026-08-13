import { Router } from 'express'
import { getWallets, loadBalances, type ManagedWallet } from '../../src/wallets/manager.js'
import { formatEther } from 'viem'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { privateKeyToAccount } from 'viem/accounts'
import { resetSettings } from '../../src/config/settings.js'

const router = Router()

const ENV_PATH = join(process.cwd(), '.env')

function readEnvFile(): string {
  if (!existsSync(ENV_PATH)) return ''
  return readFileSync(ENV_PATH, 'utf-8')
}

function writeEnvFile(content: string): void {
  writeFileSync(ENV_PATH, content, 'utf-8')
}

/** GET /api/wallets — list all wallets with balances */
router.get('/', async (_req, res) => {
  try {
    const wallets = await loadBalances(false)
    const data = wallets.map((w: ManagedWallet) => ({
      index: w.index,
      address: w.address,
      balanceWei: w.balance?.toString() ?? '0',
      balanceEth: parseFloat(formatEther(w.balance ?? 0n)).toFixed(4),
    }))
    res.json({ wallets: data })
  } catch (err) {
    res.status(500).json({ error: String(err) })
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
    // Validate the key by deriving the address
    const account = privateKeyToAccount(privateKey as `0x${string}`)

    // Find next available slot
    let envContent = readEnvFile()
    let slot = 1
    while (envContent.includes(`WALLET_KEY_${slot}=`)) {
      const line = envContent.split('\n').find((l) => l.startsWith(`WALLET_KEY_${slot}=`))
      const val = line?.split('=')[1]?.trim()
      if (!val || val === '') break
      slot++
    }

    // Update or append the key
    const keyVar = `WALLET_KEY_${slot}`
    if (envContent.includes(`${keyVar}=`)) {
      envContent = envContent.replace(new RegExp(`${keyVar}=.*`), `${keyVar}=${privateKey}`)
    } else {
      envContent += `\n${keyVar}=${privateKey}`
    }

    writeEnvFile(envContent)
    resetSettings() // force reload

    res.json({ success: true, address: account.address, slot })
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
    let envContent = readEnvFile()
    const keyVar = `WALLET_KEY_${idx}`
    if (!envContent.includes(`${keyVar}=`)) {
      res.status(404).json({ error: `Wallet ${idx} not found.` })
      return
    }

    // Clear the key value (keep the line but blank it)
    envContent = envContent.replace(new RegExp(`${keyVar}=.*`), `${keyVar}=`)
    writeEnvFile(envContent)
    resetSettings()

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export { router as walletsRouter }
