import {
  type Address,
  type PublicClient,
  formatEther,
  isAddress,
} from 'viem'
import { logger } from './logger.js'

/** ABI fragments used for analysis probing */
const PROBE_ABI = [
  // Sale state
  { name: 'saleIsActive', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'publicSaleActive', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'mintEnabled', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'paused', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  // Mint price
  { name: 'mintPrice', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'price', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'cost', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'PRICE', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'publicMintPrice', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  // Max per wallet
  { name: 'maxPerWallet', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'maxMintPerWallet', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'MAX_PER_WALLET', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  // Total supply / max supply
  { name: 'totalSupply', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'maxSupply', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'MAX_SUPPLY', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const

/** Known mint function signatures to probe */
const MINT_SIGNATURES = [
  'mint(uint256)',
  'publicMint(uint256)',
  'mint(uint256,bytes32[])',
  'whitelistMint(uint256,bytes32[])',
  'presaleMint(uint256,bytes32[])',
  'mint(uint256,bytes)',
  'claim(uint256)',
  'freeMint()',
  'mint()',
] as const

type MintSig = (typeof MINT_SIGNATURES)[number]

export type WlType = 'merkle-proof' | 'signature' | 'none' | 'unknown'

export interface ContractAnalysis {
  contractAddress: Address
  mintFunctions: MintSig[]
  detectedMintFn?: MintSig
  wlType: WlType
  saleActive?: boolean
  saleStateFn?: string
  mintPriceWei?: bigint
  mintPriceEth?: string
  maxPerWallet?: bigint
  totalSupply?: bigint
  maxSupply?: bigint
  isVerified: boolean
}

/**
 * Probe a single read-only function on the contract.
 * Returns the result or undefined if the call fails (function doesn't exist).
 */
async function probe<T>(
  client: PublicClient,
  address: Address,
  fn: { name: string; type: string; inputs: readonly unknown[]; outputs: readonly unknown[]; stateMutability: string },
): Promise<T | undefined> {
  try {
    return await client.readContract({
      address,
      abi: [fn],
      functionName: fn.name,
    }) as T
  } catch {
    return undefined
  }
}

/**
 * Try to fetch a verified ABI from Blockscout.
 * Returns the parsed ABI or null if unverified.
 */
async function fetchAbiFromBlockscout(
  contractAddress: Address,
): Promise<unknown[] | null> {
  try {
    const url = `https://robinhoodchain.blockscout.com/api?module=contract&action=getabi&address=${contractAddress}`
    const res = await fetch(url)
    const data = await res.json() as { status: string; result: string }
    if (data.status === '1') {
      return JSON.parse(data.result) as unknown[]
    }
  } catch {
    // Blockscout unavailable or contract not verified
  }
  return null
}

/**
 * Detect which mint function signatures exist on the contract
 * by probing function selectors.
 */
function detectMintFunctionsFromAbi(abi: unknown[]): MintSig[] {
  const found: MintSig[] = []
  const abiArr = abi as Array<{ type: string; name: string; inputs: Array<{ type: string }> }>

  for (const item of abiArr) {
    if (item.type !== 'function') continue
    const inputs = item.inputs ?? []
    const sig = `${item.name}(${inputs.map((i) => i.type).join(',')})` as MintSig
    if ((MINT_SIGNATURES as readonly string[]).includes(sig)) {
      found.push(sig)
    }
  }
  return found
}

/**
 * Determine the WL type from a mint function signature.
 */
function detectWlType(mintFns: MintSig[]): WlType {
  for (const fn of mintFns) {
    if (fn.includes('bytes32[]')) return 'merkle-proof'
    if (fn.includes('bytes)')) return 'signature'
  }
  return 'none'
}

/**
 * Full contract analysis — fetches ABI if verified, probes state functions,
 * detects mint price, WL type, and whether sale is active.
 */
export async function analyzeContract(
  publicClient: PublicClient,
  contractAddress: Address,
): Promise<ContractAnalysis> {
  if (!isAddress(contractAddress)) {
    throw new Error(`Invalid contract address: ${contractAddress}`)
  }

  logger.info(`Analyzing contract ${contractAddress}`)

  // 1. Try to get verified ABI from Blockscout
  const verifiedAbi = await fetchAbiFromBlockscout(contractAddress)
  const isVerified = verifiedAbi !== null

  if (isVerified) {
    logger.success('Contract is verified on Blockscout — using full ABI')
  } else {
    logger.warn('Contract is NOT verified — probing common function signatures')
  }

  // 2. Detect mint functions
  let mintFunctions: MintSig[] = []
  if (isVerified) {
    mintFunctions = detectMintFunctionsFromAbi(verifiedAbi!)
  } else {
    // For unverified contracts, all common signatures are candidates
    mintFunctions = [...MINT_SIGNATURES]
  }

  // 3. Determine WL type
  const wlType = detectWlType(mintFunctions)

  // 4. Probe state variables (works regardless of verification)
  const [
    saleIsActive,
    publicSaleActive,
    mintEnabled,
    paused,
    mintPriceRaw,
    priceRaw,
    costRaw,
    PRICE_raw,
    publicMintPriceRaw,
    maxPerWallet,
    maxMintPerWallet,
    MAX_PER_WALLET,
    totalSupply,
    maxSupply,
    MAX_SUPPLY,
  ] = await Promise.all([
    probe<boolean>(publicClient, contractAddress, PROBE_ABI[0]),
    probe<boolean>(publicClient, contractAddress, PROBE_ABI[1]),
    probe<boolean>(publicClient, contractAddress, PROBE_ABI[2]),
    probe<boolean>(publicClient, contractAddress, PROBE_ABI[3]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[4]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[5]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[6]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[7]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[8]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[9]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[10]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[11]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[12]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[13]),
    probe<bigint>(publicClient, contractAddress, PROBE_ABI[14]),
  ])

  // Resolve sale state
  let saleActive: boolean | undefined
  let saleStateFn: string | undefined
  if (saleIsActive !== undefined) { saleActive = saleIsActive; saleStateFn = 'saleIsActive' }
  else if (publicSaleActive !== undefined) { saleActive = publicSaleActive; saleStateFn = 'publicSaleActive' }
  else if (mintEnabled !== undefined) { saleActive = mintEnabled; saleStateFn = 'mintEnabled' }
  else if (paused !== undefined) { saleActive = !paused; saleStateFn = 'paused (inverted)' }

  // Resolve mint price
  const mintPriceWei = mintPriceRaw ?? priceRaw ?? costRaw ?? PRICE_raw ?? publicMintPriceRaw

  // Resolve max per wallet
  const resolvedMaxPerWallet = maxPerWallet ?? maxMintPerWallet ?? MAX_PER_WALLET

  // Resolve supply
  const resolvedMaxSupply = maxSupply ?? MAX_SUPPLY

  // Pick best mint function (prefer public if available, fall back to generic)
  const mintPriorityOrder: MintSig[] = [
    'publicMint(uint256)',
    'mint(uint256)',
    'claim(uint256)',
    'freeMint()',
    'mint()',
    'mint(uint256,bytes32[])',
    'whitelistMint(uint256,bytes32[])',
    'presaleMint(uint256,bytes32[])',
    'mint(uint256,bytes)',
  ]
  const detectedMintFn = mintPriorityOrder.find((sig) =>
    (mintFunctions as readonly string[]).includes(sig),
  )

  return {
    contractAddress,
    mintFunctions,
    detectedMintFn,
    wlType,
    saleActive,
    saleStateFn,
    mintPriceWei,
    mintPriceEth: mintPriceWei != null ? formatEther(mintPriceWei) : undefined,
    maxPerWallet: resolvedMaxPerWallet,
    totalSupply,
    maxSupply: resolvedMaxSupply,
    isVerified,
  }
}

/**
 * Pretty-print a contract analysis to the terminal.
 */
export function printAnalysis(a: ContractAnalysis): void {
  logger.divider()
  logger.info(`Contract: ${a.contractAddress}`)
  logger.info(`Verified: ${a.isVerified ? '✓ Yes (Blockscout)' : '✗ No (probing signatures)'}`)
  logger.info(`WL Type:  ${a.wlType}`)

  if (a.saleActive !== undefined) {
    const status = a.saleActive
      ? '🟢 ACTIVE'
      : '🔴 NOT ACTIVE'
    logger.info(`Sale:     ${status}  (via ${a.saleStateFn})`)
  } else {
    logger.warn(`Sale:     ❓ Could not detect sale state function`)
  }

  if (a.mintPriceEth != null) {
    logger.info(`Price:    ${a.mintPriceEth} ETH per mint`)
  } else {
    logger.warn(`Price:    ❓ Could not detect mint price (check contract)`)
  }

  if (a.maxPerWallet != null) {
    logger.info(`Max/wallet: ${a.maxPerWallet}`)
  }

  if (a.totalSupply != null) {
    logger.info(`Minted:   ${a.totalSupply}${a.maxSupply != null ? ` / ${a.maxSupply}` : ''}`)
  }

  logger.info(`Mint fns: ${a.mintFunctions.join(', ') || 'none detected'}`)
  if (a.detectedMintFn) {
    logger.success(`Recommended: ${a.detectedMintFn}`)
  }
  logger.divider()
}
