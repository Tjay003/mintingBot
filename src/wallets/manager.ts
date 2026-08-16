import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  formatEther,
  type PublicClient,
  type WalletClient,
  type Address,
  type Transport,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { robinhoodChain } from '../config/chain.js'
import { getSettings } from '../config/settings.js'
import { logger } from '../utils/logger.js'

export interface ManagedWallet {
  index: number
  label?: string
  address: Address
  client: WalletClient<Transport, typeof robinhoodChain>
  balance?: bigint
}

let _publicClient: PublicClient | null = null
let _wsPublicClient: PublicClient | null = null
let _wallets: ManagedWallet[] = []

/**
 * Get the shared HTTP public client (for reads + gas estimation)
 */
export function getPublicClient(): PublicClient {
  if (_publicClient) return _publicClient
  const { rpc } = getSettings()
  _publicClient = createPublicClient({
    chain: robinhoodChain,
    transport: http(rpc.http),
  })
  return _publicClient
}

/**
 * Get the shared WebSocket public client (for block watching / sniping)
 */
export function getWsPublicClient(): PublicClient {
  if (_wsPublicClient) return _wsPublicClient
  const { rpc } = getSettings()
  _wsPublicClient = createPublicClient({
    chain: robinhoodChain,
    transport: webSocket(rpc.wss),
  })
  return _wsPublicClient
}

/**
 * Reset cached wallets array (used when settings/keys are updated)
 */
export function resetWallets(): void {
  _wallets = []
}

/**
 * Load all wallets from settings. Cached after first call.
 */
export function getWallets(forceReload = false): ManagedWallet[] {
  if (forceReload) resetWallets()
  if (_wallets.length > 0) return _wallets
  const { walletKeys, walletLabels, rpc } = getSettings()

  _wallets = walletKeys.map((key, i) => {
    const account = privateKeyToAccount(key)
    const client = createWalletClient({
      account,
      chain: robinhoodChain,
      transport: http(rpc.http),
    })
    const index = i + 1
    return {
      index,
      label: walletLabels[index] || `Wallet ${index}`,
      address: account.address,
      client,
    }
  })

  return _wallets
}

/**
 * Fetch and cache ETH balances for all wallets (or specific indices). Prints a table.
 */
export async function loadBalances(print = true, forceReload = false, walletIndices?: number[]): Promise<ManagedWallet[]> {
  let wallets = getWallets(forceReload)
  if (walletIndices && walletIndices.length > 0) {
    wallets = wallets.filter((w) => walletIndices.includes(w.index))
  }
  const publicClient = getPublicClient()

  const balances = await Promise.all(
    wallets.map((w) => publicClient.getBalance({ address: w.address })),
  )

  wallets.forEach((w, i) => {
    w.balance = balances[i]
  })

  if (print) {
    logger.divider()
    logger.info(`Wallets loaded  (${wallets.length} total)`)
    wallets.forEach((w) => {
      const eth = parseFloat(formatEther(w.balance ?? 0n)).toFixed(4)
      const name = w.label && w.label !== `Wallet ${w.index}` ? `Wallet ${w.index} (${w.label})` : `Wallet ${w.index}`
      logger.info(`  ${name}  ${w.address}  →  ${eth} ETH`)
    })
    logger.divider()
  }

  return wallets
}

/**
 * Return only wallets that have enough ETH for a given mint cost.
 */
export function filterSolventWallets(
  wallets: ManagedWallet[],
  requiredEth: bigint,
): ManagedWallet[] {
  return wallets.filter((w) => {
    if ((w.balance ?? 0n) < requiredEth) {
      logger.warn(`Wallet ${w.index} (${w.address}) skipped — insufficient balance`)
      return false
    }
    return true
  })
}

/**
 * Get the current nonce for a wallet address.
 * Always fetches fresh from chain to avoid conflicts after restarts.
 */
export async function getNonce(address: Address): Promise<number> {
  const client = getPublicClient()
  return client.getTransactionCount({ address, blockTag: 'pending' })
}
