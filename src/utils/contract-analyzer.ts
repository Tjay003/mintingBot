import {
  type Address,
  type PublicClient,
  formatEther,
  isAddress,
  zeroAddress,
} from 'viem'
import { logger } from './logger.js'

/** Canonical SeaDrop router addresses across EVM chains */
export const SEADROP_ROUTERS: Address[] = [
  '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  '0x0000000005B502c4748b1576532828042b220000',
  '0x0000000000000068F116a894984e2DB1123eB395',
]

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
  // SeaDrop getMintStats
  {
    name: 'getMintStats',
    type: 'function',
    inputs: [{ name: 'minter', type: 'address' }],
    outputs: [
      { name: 'minterNumMinted', type: 'uint256' },
      { name: 'currentTotalSupply', type: 'uint256' },
      { name: 'maxSupply', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  // SeaDrop getPublicDrop
  {
    name: 'getPublicDrop',
    type: 'function',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [
      {
        components: [
          { name: 'mintPrice', type: 'uint80' },
          { name: 'startTime', type: 'uint48' },
          { name: 'endTime', type: 'uint48' },
          { name: 'maxTotalMintableByWallet', type: 'uint16' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'restrictFeeRecipients', type: 'bool' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
  },
] as const

/** Known mint function signatures to probe */
const MINT_SIGNATURES = [
  'mint(uint256)',
  'publicMint(uint256)',
  'mintSeaDrop(address,uint256)',
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

import { fetchOpenSeaDropStages, type OpenSeaDropStage } from './opensea-resolver.js'

export interface SeaDropPublicDropInfo {
  mintPrice: bigint
  mintPriceEth: string
  startTime: number
  endTime: number
  maxTotalMintableByWallet: number
  startTimeIso: string
  endTimeIso: string
  isLive: boolean
}

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
  isSeaDrop?: boolean
  seaDropInfo?: SeaDropPublicDropInfo
  dropStages?: OpenSeaDropStage[]
}

/**
 * Probe a single read-only function on the contract.
 * Returns the result or undefined if the call fails.
 */
async function probe<T>(
  client: PublicClient,
  address: Address,
  fn: unknown,
  args: readonly unknown[] = [],
): Promise<T | undefined> {
  try {
    const fnDef = fn as { name: string }
    return await client.readContract({
      address,
      abi: [fnDef as any],
      functionName: fnDef.name,
      args: args as any,
    }) as T
  } catch {
    return undefined
  }
}

// Fast in-memory cache for Blockscout ABIs
const blockscoutAbiCache = new Map<string, unknown[] | null>()

/**
 * Try to fetch a verified ABI from Blockscout with a strict 600ms timeout.
 * Returns the parsed ABI or null if unverified/timed out.
 */
async function fetchAbiFromBlockscout(
  contractAddress: Address,
): Promise<unknown[] | null> {
  const normalized = contractAddress.toLowerCase()
  if (blockscoutAbiCache.has(normalized)) {
    return blockscoutAbiCache.get(normalized)!
  }

  try {
    const url = `https://robinhoodchain.blockscout.com/api?module=contract&action=getabi&address=${contractAddress}`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 600)

    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeoutId)

    const data = await res.json() as { status: string; result: string }
    if (data.status === '1') {
      const parsed = JSON.parse(data.result) as unknown[]
      blockscoutAbiCache.set(normalized, parsed)
      return parsed
    }
  } catch {
    // Blockscout timed out, unavailable, or contract unverified
  }

  blockscoutAbiCache.set(normalized, null)
  return null
}

/**
 * Detect which mint function signatures exist on the contract.
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

// In-memory analysis cache (5 min TTL) for zero-latency execution
const analysisCache = new Map<string, { data: ContractAnalysis; timestamp: number }>()
const ANALYSIS_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Full contract analysis — fetches ABI if verified, probes state functions,
 * detects SeaDrop structs (price, schedule, wallet limits), WL type, and sale state.
 */
export async function analyzeContract(
  publicClient: PublicClient,
  contractAddress: Address,
  forceRefresh = false,
  includeDropStages = false,
): Promise<ContractAnalysis> {
  if (!isAddress(contractAddress)) {
    throw new Error(`Invalid contract address: ${contractAddress}`)
  }

  const normalized = contractAddress.toLowerCase()
  const cached = analysisCache.get(normalized)
  if (!forceRefresh && cached && Date.now() - cached.timestamp < ANALYSIS_CACHE_TTL_MS) {
    return cached.data
  }

  logger.info(`Analyzing contract ${contractAddress}`)

  // 1. Concurrently fetch verified ABI and probe states in parallel
  const [
    verifiedAbi,
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
    seaDropStats,
  ] = await Promise.all([
    fetchAbiFromBlockscout(contractAddress),
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
    probe<[bigint, bigint, bigint]>(publicClient, contractAddress, PROBE_ABI[15], [zeroAddress]),
  ])

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
    mintFunctions = [...MINT_SIGNATURES]
  }

  const isSeaDrop = mintFunctions.includes('mintSeaDrop(address,uint256)') ||
    (verifiedAbi?.some((item: any) => item.name === 'mintSeaDrop') ?? false)

  // 3. Parallel SeaDrop router probe (queried on the router address)
  let seaDropInfo: SeaDropPublicDropInfo | undefined
  if (isSeaDrop) {
    const routerProbes = await Promise.all(
      SEADROP_ROUTERS.map((router) =>
        probe<{
          mintPrice: bigint
          startTime: number
          endTime: number
          maxTotalMintableByWallet: number
        }>(publicClient, router, PROBE_ABI[16], [contractAddress]),
      ),
    )

    for (const pd of routerProbes) {
      if (pd && pd.maxTotalMintableByWallet > 0) {
        const now = Math.floor(Date.now() / 1000)
        const start = Number(pd.startTime)
        const end = Number(pd.endTime)
        seaDropInfo = {
          mintPrice: BigInt(pd.mintPrice),
          mintPriceEth: formatEther(BigInt(pd.mintPrice)),
          startTime: start,
          endTime: end,
          maxTotalMintableByWallet: Number(pd.maxTotalMintableByWallet),
          startTimeIso: new Date(start * 1000).toLocaleString(),
          endTimeIso: new Date(end * 1000).toLocaleString(),
          isLive: now >= start && now <= end,
        }
        break
      }
    }
  }

  // Determine WL type
  const wlType = detectWlType(mintFunctions)

  // Resolve sale state
  let saleActive: boolean | undefined
  let saleStateFn: string | undefined
  if (seaDropInfo) {
    saleActive = seaDropInfo.isLive
    saleStateFn = `SeaDrop Public Stage (${seaDropInfo.isLive ? 'LIVE' : 'SCHEDULED'})`
  } else if (saleIsActive !== undefined) { saleActive = saleIsActive; saleStateFn = 'saleIsActive' }
  else if (publicSaleActive !== undefined) { saleActive = publicSaleActive; saleStateFn = 'publicSaleActive' }
  else if (mintEnabled !== undefined) { saleActive = mintEnabled; saleStateFn = 'mintEnabled' }
  else if (paused !== undefined) { saleActive = !paused; saleStateFn = 'paused (inverted)' }
  else if (isSeaDrop) { saleActive = false; saleStateFn = 'SeaDrop (Check launchpad stage)' }

  // Resolve mint price
  const mintPriceWei = seaDropInfo ? seaDropInfo.mintPrice : (mintPriceRaw ?? priceRaw ?? costRaw ?? PRICE_raw ?? publicMintPriceRaw)
  const mintPriceEth = seaDropInfo ? seaDropInfo.mintPriceEth : (mintPriceWei != null ? formatEther(mintPriceWei) : undefined)

  // Resolve max per wallet
  const resolvedMaxPerWallet = seaDropInfo ? BigInt(seaDropInfo.maxTotalMintableByWallet) : (maxPerWallet ?? maxMintPerWallet ?? MAX_PER_WALLET)

  // Resolve supply
  let resolvedTotalSupply = totalSupply
  let resolvedMaxSupply = maxSupply ?? MAX_SUPPLY

  if (seaDropStats) {
    resolvedTotalSupply = seaDropStats[1]
    resolvedMaxSupply = seaDropStats[2]
  }

  // Pick best mint function
  const mintPriorityOrder: MintSig[] = [
    'publicMint(uint256)',
    'mint(uint256)',
    'mintSeaDrop(address,uint256)',
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

  // Fetch OpenSea drop stages only if requested
  let dropStages: OpenSeaDropStage[] | undefined
  if (isSeaDrop && includeDropStages) {
    try {
      dropStages = await fetchOpenSeaDropStages(contractAddress)
    } catch {}
  }

  const result: ContractAnalysis = {
    contractAddress,
    mintFunctions,
    detectedMintFn,
    wlType,
    saleActive,
    saleStateFn,
    mintPriceWei,
    mintPriceEth,
    maxPerWallet: resolvedMaxPerWallet,
    totalSupply: resolvedTotalSupply,
    maxSupply: resolvedMaxSupply,
    isVerified,
    isSeaDrop,
    seaDropInfo,
    dropStages,
  }

  analysisCache.set(normalized, { data: result, timestamp: Date.now() })
  return result
}

/**
 * Pretty-print a contract analysis to the terminal.
 */
export function printAnalysis(a: ContractAnalysis): void {
  logger.divider()
  logger.info(`Contract: ${a.contractAddress}`)
  logger.info(`Type:     ${a.isSeaDrop ? 'OpenSea SeaDrop / Launchpad' : 'Standard ERC-721'}`)
  logger.info(`Verified: ${a.isVerified ? '✓ Yes (Blockscout)' : '✗ No (probing signatures)'}`)
  logger.info(`WL Type:  ${a.wlType}`)

  if (a.dropStages && a.dropStages.length > 0) {
    logger.info(`[OpenSea Drop Stages Detected: ${a.dropStages.length} stage(s)]`)
    for (const s of a.dropStages) {
      const liveTag = s.isLive ? '🟢 LIVE NOW' : '🔴 UPCOMING'
      logger.info(`  • Stage ${s.stageIndex}: ${s.label} (${s.stageType})`)
      logger.info(`    Price: ${s.priceEth} ETH | Limit: ${s.maxTotalMintableByWallet} | Time: ${s.startTimeLocal} - ${s.endTimeLocal} [${liveTag}]`)
    }
  } else if (a.seaDropInfo) {
    logger.info(`[SeaDrop Stage Details]`)
    logger.info(`  Public Price:  ${a.seaDropInfo.mintPriceEth} ETH`)
    logger.info(`  Limit/Wallet:  ${a.seaDropInfo.maxTotalMintableByWallet}`)
    logger.info(`  Start Time:    ${a.seaDropInfo.startTimeIso}`)
    logger.info(`  End Time:      ${a.seaDropInfo.endTimeIso}`)
    logger.info(`  Stage Status:  ${a.seaDropInfo.isLive ? '🟢 LIVE NOW' : '🔴 SCHEDULED'}`)
  } else if (a.saleActive !== undefined) {
    const status = a.saleActive ? '🟢 ACTIVE' : '🔴 NOT ACTIVE'
    logger.info(`Sale:     ${status}  (via ${a.saleStateFn})`)
  }

  if (a.mintPriceEth != null && !a.seaDropInfo) {
    logger.info(`Price:    ${a.mintPriceEth} ETH per mint`)
  }

  if (a.maxPerWallet != null && !a.seaDropInfo) {
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
