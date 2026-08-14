import {
  encodeFunctionData,
  parseEther,
  formatEther,
  type Abi,
  type AbiFunction,
  type Address,
  type PublicClient,
} from 'viem'
import type { ManagedWallet } from '../wallets/manager.js'
import { estimateGasParams, type GasStrategy } from './gas-manager.js'
import { getSettings } from '../config/settings.js'
import { logger } from '../utils/logger.js'

export interface MintParams {
  /** The NFT contract address to call */
  contractAddress: Address
  /** ABI of the contract's mint function */
  abi: Abi
  /** Name of the function to call, e.g. "mint" or "publicMint" */
  functionName: string
  /** Arguments to pass to the function */
  args: unknown[]
  /** ETH value to attach (mint price * quantity) */
  valueEth: string
  /** Gas pricing strategy */
  gasStrategy: GasStrategy
  /** For 'custom' strategy only — target gas price in Gwei */
  customGasPriceGwei?: number
}

export interface BuiltTransaction {
  wallet: ManagedWallet
  contractAddress: Address
  data: `0x${string}`
  value: bigint
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  nonce: number
}

/**
 * Build a ready-to-send mint transaction for a single wallet.
 * Estimates gas, applies the gas strategy, enforces safety limits.
 */
export async function buildMintTransaction(
  publicClient: PublicClient,
  wallet: ManagedWallet,
  params: MintParams,
  nonce: number,
): Promise<BuiltTransaction> {
  const settings = getSettings()
  const valueWei = parseEther(params.valueEth)

  // Safety: check per-mint ETH limit
  const maxPerMintWei = parseEther(settings.safety.maxEthPerMint.toString())
  if (valueWei > maxPerMintWei) {
    throw new Error(
      `Mint value ${params.valueEth} ETH exceeds MAX_ETH_PER_MINT (${settings.safety.maxEthPerMint} ETH)`,
    )
  }

  // Encode the function call
  const data = encodeFunctionData({
    abi: params.abi,
    functionName: params.functionName,
    args: params.args,
  })

  // Estimate gas for this transaction
  let estimatedGas: bigint
  try {
    estimatedGas = await publicClient.estimateGas({
      account: wallet.address,
      to: params.contractAddress,
      data,
      value: valueWei,
    })
  } catch {
    // If estimation fails (e.g. sale not open yet), use a conservative default
    logger.warn(`Gas estimation failed for wallet ${wallet.index} — using 300k fallback`)
    estimatedGas = 300_000n
  }

  const gasParams = await estimateGasParams(
    publicClient,
    estimatedGas,
    params.gasStrategy,
    params.customGasPriceGwei,
  )

  return {
    wallet,
    contractAddress: params.contractAddress,
    data,
    value: valueWei,
    nonce,
    ...gasParams,
  }
}

/**
 * Send a pre-built transaction and wait for confirmation.
 * Returns the transaction hash.
 */
export async function sendTransaction(
  publicClient: PublicClient,
  tx: BuiltTransaction,
): Promise<{ hash: `0x${string}`; submitDurationMs: number; confirmDurationMs: number; totalDurationMs: number; blockNumber?: bigint }> {
  const { wallet } = tx
  const ethValue = parseFloat(formatEther(tx.value)).toFixed(4)
  const startTime = performance.now()

  logger.info(`Wallet ${wallet.index} → sending tx  (${ethValue} ETH, nonce ${tx.nonce})`)

  const sendStartTime = performance.now()
  const hash = await wallet.client.sendTransaction({
    account: wallet.client.account!,
    to: tx.contractAddress,
    data: tx.data,
    value: tx.value,
    gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    nonce: tx.nonce,
    chain: wallet.client.chain,
  })
  const submitDurationMs = Math.round(performance.now() - sendStartTime)

  logger.info(`Wallet ${wallet.index} → tx submitted  ${hash}  (${submitDurationMs}ms)`)

  // Wait for 1 confirmation
  const confirmStartTime = performance.now()
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })
  const confirmDurationMs = Math.round(performance.now() - confirmStartTime)
  const totalDurationMs = Math.round(performance.now() - startTime)

  if (receipt.status === 'success') {
    logger.success(
      `Wallet ${wallet.index} → confirmed ✓  block #${receipt.blockNumber}  (${confirmDurationMs}ms | total: ${(totalDurationMs / 1000).toFixed(2)}s)`,
    )
  } else {
    logger.error(`Wallet ${wallet.index} → tx REVERTED  ${hash}  (total: ${(totalDurationMs / 1000).toFixed(2)}s)`)
    throw new Error(`Transaction reverted: ${hash}`)
  }

  return {
    hash,
    submitDurationMs,
    confirmDurationMs,
    totalDurationMs,
    blockNumber: receipt.blockNumber,
  }
}

/**
 * Build and send mint transactions for ALL wallets in parallel.
 * Returns results for each wallet (success or failure) with timing metrics.
 */
export async function executeParallelMint(
  publicClient: PublicClient,
  wallets: ManagedWallet[],
  params: MintParams,
  nonces: number[],
): Promise<Array<{
  wallet: ManagedWallet
  hash?: string
  error?: string
  submitDurationMs?: number
  confirmDurationMs?: number
  totalDurationMs?: number
}>> {
  const overallStart = performance.now()

  // Build all transactions first (in parallel)
  const buildResults = await Promise.allSettled(
    wallets.map((w, i) => buildMintTransaction(publicClient, w, params, nonces[i])),
  )

  const txs: BuiltTransaction[] = []
  for (let i = 0; i < buildResults.length; i++) {
    const result = buildResults[i]
    if (result.status === 'rejected') {
      logger.error(`Wallet ${wallets[i].index} build failed: ${result.reason}`)
    } else {
      txs.push(result.value)
    }
  }

  if (txs.length === 0) {
    throw new Error('All transaction builds failed — aborting mint')
  }

  logger.fire(`Firing ${txs.length} wallet(s) simultaneously!`)

  // Send all transactions simultaneously
  const sendResults = await Promise.allSettled(
    txs.map((tx) => sendTransaction(publicClient, tx)),
  )

  const overallTotalMs = Math.round(performance.now() - overallStart)

  return sendResults.map((result, i) => ({
    wallet: txs[i].wallet,
    hash: result.status === 'fulfilled' ? result.value.hash : undefined,
    error: result.status === 'rejected' ? String(result.reason) : undefined,
    submitDurationMs: result.status === 'fulfilled' ? result.value.submitDurationMs : undefined,
    confirmDurationMs: result.status === 'fulfilled' ? result.value.confirmDurationMs : undefined,
    totalDurationMs: result.status === 'fulfilled' ? result.value.totalDurationMs : undefined,
  }))
}

/**
 * Common ERC-721/ERC-1155 mint ABIs.
 * Used when a contract's ABI cannot be fetched (unverified contracts).
 */
export const COMMON_MINT_ABIS: Record<string, AbiFunction> = {
  'mint(uint256)': {
    name: 'mint',
    type: 'function',
    inputs: [{ name: 'quantity', type: 'uint256' }],
    outputs: [],
    stateMutability: 'payable',
  },
  'publicMint(uint256)': {
    name: 'publicMint',
    type: 'function',
    inputs: [{ name: 'quantity', type: 'uint256' }],
    outputs: [],
    stateMutability: 'payable',
  },
  'mintSeaDrop(address,uint256)': {
    name: 'mintSeaDrop',
    type: 'function',
    inputs: [
      { name: 'minter', type: 'address' },
      { name: 'quantity', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  'mint(uint256,bytes32[])': {
    name: 'mint',
    type: 'function',
    inputs: [
      { name: 'quantity', type: 'uint256' },
      { name: 'proof', type: 'bytes32[]' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  'whitelistMint(uint256,bytes32[])': {
    name: 'whitelistMint',
    type: 'function',
    inputs: [
      { name: 'quantity', type: 'uint256' },
      { name: 'proof', type: 'bytes32[]' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  'presaleMint(uint256,bytes32[])': {
    name: 'presaleMint',
    type: 'function',
    inputs: [
      { name: 'quantity', type: 'uint256' },
      { name: 'proof', type: 'bytes32[]' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  'mint(uint256,bytes)': {
    name: 'mint',
    type: 'function',
    inputs: [
      { name: 'quantity', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
}

/** Canonical SeaDrop router on Robinhood Chain / EVM */
export const SEADROP_ROUTER_ADDRESS: Address = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
/** OpenSea platform fee recipient on Robinhood Chain */
export const OPENSEA_FEE_RECIPIENT: Address = '0x0000a26b00c1f0df003000390027140000faa719'
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

export const SEADROP_MINT_PUBLIC_ABI: Abi = [
  {
    name: 'mintPublic',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'minterIfNotPayer', type: 'address' },
      { name: 'quantity', type: 'uint256' },
    ],
    outputs: [],
  },
]

