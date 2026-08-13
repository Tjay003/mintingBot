import 'dotenv/config'

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}\nCopy .env.example to .env and fill in your values.`)
  }
  return value.trim()
}

function optionalEnv(key: string, fallback = ''): string {
  return (process.env[key] ?? fallback).trim()
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
  for (let i = 1; i <= 10; i++) {
    const key = optionalEnv(`WALLET_KEY_${i}`)
    if (!key || key === '0x_your_private_key_here') continue
    if (!key.startsWith('0x') || key.length !== 66) {
      throw new Error(`WALLET_KEY_${i} is invalid. It must be a 0x-prefixed 64-character hex string.`)
    }
    keys.push(key as `0x${string}`)
  }
  return keys
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
  if (walletKeys.length === 0) {
    throw new Error(
      'No wallet keys found.\nAdd WALLET_KEY_1 (and optionally WALLET_KEY_2, etc.) to your .env file.',
    )
  }

  _settings = {
    rpc: resolveRpc(),
    walletKeys,
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

/** Reset cached settings (useful in tests) */
export function resetSettings(): void {
  _settings = null
}
