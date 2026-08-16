import { config, parse } from 'dotenv'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// Initial load
config()

function optionalEnv(key: string, fallback = ''): string {
  return (process.env[key] ?? fallback).trim()
}

/**
 * Reload .env from disk and update process.env
 */
export function reloadEnvFromDisk(): void {
  const envPath = join(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  try {
    const envConfig = parse(readFileSync(envPath))

    // Clear old WALLET_KEY_ and WALLET_LABEL_ entries from process.env first
    for (let i = 1; i <= 20; i++) {
      delete process.env[`WALLET_KEY_${i}`]
      delete process.env[`WALLET_LABEL_${i}`]
    }

    // Apply fresh values to process.env
    for (const [k, v] of Object.entries(envConfig)) {
      process.env[k] = v
    }
  } catch (err) {
    console.error('Failed to reload .env from disk:', err)
  }
}

/**
 * Resolve the best available RPC URLs.
 * Prefers private RPC if configured, falls back to public.
 */
function resolveRpc() {
  const privateHttp = optionalEnv('PRIVATE_RPC_HTTP_URL')
  const privateWss = optionalEnv('PRIVATE_RPC_WSS_URL')
  const publicHttp = optionalEnv('RPC_HTTP_URL', 'https://rpc.mainnet.chain.robinhood.com')
  const publicWss = optionalEnv('RPC_WSS_URL', 'wss://rpc.mainnet.chain.robinhood.com')

  return {
    http: privateHttp || publicHttp,
    wss: privateWss || publicWss,
    isPrivate: Boolean(privateHttp),
  }
}

/**
 * Load all wallet private keys from WALLET_KEY_1 … WALLET_KEY_N
 */
function loadWalletKeys(): `0x${string}`[] {
  const keys: `0x${string}`[] = []
  for (let i = 1; i <= 20; i++) {
    const key = optionalEnv(`WALLET_KEY_${i}`)
    if (!key || key === '0x_your_private_key_here') continue
    if (!key.startsWith('0x') || key.length !== 66) {
      continue
    }
    keys.push(key as `0x${string}`)
  }
  return keys
}

function loadWalletLabels(): Record<number, string> {
  const labels: Record<number, string> = {}
  for (let i = 1; i <= 20; i++) {
    const label = optionalEnv(`WALLET_LABEL_${i}`)
    if (label) {
      labels[i] = label
    }
  }
  return labels
}

function parseGwei(key: string, fallback: number): number {
  const raw = optionalEnv(key)
  const parsed = parseFloat(raw)
  return isNaN(parsed) ? fallback : parsed
}

function parseEth(key: string, fallback: number): number {
  const raw = optionalEnv(key)
  const parsed = parseFloat(raw)
  return isNaN(parsed) ? fallback : parsed
}

export interface Settings {
  rpc: { http: string; wss: string; isPrivate: boolean }
  walletKeys: `0x${string}`[]
  walletLabels: Record<number, string>
  safety: {
    maxGasPriceGwei: number
    maxEthPerMint: number
    maxTotalEth: number
  }
  opensea: {
    apiKey: string
  }
}

let _settings: Settings | null = null

export function getSettings(): Settings {
  if (_settings) return _settings

  const walletKeys = loadWalletKeys()
  const walletLabels = loadWalletLabels()

  _settings = {
    rpc: resolveRpc(),
    walletKeys,
    walletLabels,
    safety: {
      maxGasPriceGwei: parseGwei('MAX_GAS_PRICE_GWEI', 50),
      maxEthPerMint: parseEth('MAX_ETH_PER_MINT', 0.5),
      maxTotalEth: parseEth('MAX_TOTAL_ETH', 2.0),
    },
    opensea: {
      apiKey: optionalEnv('OPENSEA_API_KEY'),
    },
  }

  return _settings
}

/** Reset cached settings & force reload .env from disk */
export function resetSettings(): void {
  reloadEnvFromDisk()
  _settings = null
}
