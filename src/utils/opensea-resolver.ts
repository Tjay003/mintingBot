import { isAddress, type Address } from 'viem'
import { getSettings } from '../config/settings.js'
import { logger } from './logger.js'

/**
 * Robinhood Chain identifiers as used in OpenSea URLs.
 * OpenSea may use "robinhood-chain", "robinhood", or chain ID 4663.
 */
const ROBINHOOD_CHAIN_SLUGS = new Set(['robinhood-chain', 'robinhood', '4663'])

export interface ResolvedCollection {
  contractAddress: Address
  collectionName?: string
  chain: string
}

/**
 * Resolve an OpenSea URL or raw contract address to a contract address.
 *
 * Supported formats:
 *  - https://opensea.io/collection/<slug>
 *  - https://opensea.io/assets/robinhood-chain/<address>/<tokenId>
 *  - https://opensea.io/assets/robinhood/<address>/<tokenId>
 *  - 0x<address>   (raw address — passed through directly)
 */
export async function resolveTarget(input: string): Promise<ResolvedCollection> {
  const trimmed = input.trim()

  // Raw contract address
  if (isAddress(trimmed)) {
    return { contractAddress: trimmed, chain: 'robinhood-chain' }
  }

  // Must be a URL from here
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`Invalid input: "${trimmed}"\nProvide an OpenSea URL or a 0x contract address.`)
  }

  if (!url.hostname.includes('opensea.io')) {
    throw new Error('Only OpenSea URLs are supported. Pass a direct contract address for other platforms.')
  }

  const parts = url.pathname.split('/').filter(Boolean)
  // parts[0] = "collection" | "assets"

  if (parts[0] === 'assets') {
    // Format: /assets/<chain>/<address>/<tokenId>
    return resolveFromAssetUrl(parts)
  }

  if (parts[0] === 'collection') {
    // Format: /collection/<slug>
    return resolveFromCollectionSlug(parts[1])
  }

  throw new Error(`Unrecognised OpenSea URL format: ${trimmed}`)
}

/**
 * Extract contract address from an asset URL.
 * /assets/<chain>/<address>/<tokenId>
 */
function resolveFromAssetUrl(parts: string[]): ResolvedCollection {
  // parts: ['assets', 'robinhood-chain', '0x...', '1']
  if (parts.length < 3) {
    throw new Error('OpenSea asset URL is missing chain or address segment.')
  }

  const chain = parts[1].toLowerCase()
  const address = parts[2]

  if (!ROBINHOOD_CHAIN_SLUGS.has(chain)) {
    logger.warn(`Chain "${chain}" is not Robinhood Chain. Proceeding anyway — verify the contract.`)
  }

  if (!isAddress(address)) {
    throw new Error(`Address "${address}" in the OpenSea URL is not a valid contract address.`)
  }

  return { contractAddress: address, chain }
}

/**
 * Resolve a collection slug to a contract address via OpenSea API.
 * https://opensea.io/collection/<slug> → GET /api/v2/collections/<slug>
 */
async function resolveFromCollectionSlug(slug: string): Promise<ResolvedCollection> {
  if (!slug) throw new Error('Collection slug is empty in the OpenSea URL.')

  const settings = getSettings()
  const apiKey = settings.opensea.apiKey

  logger.info(`Resolving OpenSea collection: "${slug}"`)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['x-api-key'] = apiKey

  const res = await fetch(`https://api.opensea.io/api/v2/collections/${slug}`, { headers })

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `OpenSea API key missing or invalid.\n` +
        `Get a free key at https://docs.opensea.io/reference/api-keys and add it to your .env as OPENSEA_API_KEY.`,
      )
    }
    if (res.status === 404) {
      throw new Error(`Collection "${slug}" not found on OpenSea. Check the URL spelling.`)
    }
    throw new Error(`OpenSea API returned ${res.status}: ${await res.text()}`)
  }

  const data = await res.json() as {
    name?: string
    contracts?: Array<{ address: string; chain: string }>
  }

  if (!data.contracts || data.contracts.length === 0) {
    throw new Error(`No contracts found for collection "${slug}".`)
  }

  // Prefer Robinhood Chain contract if multiple exist
  const robinhoodContract = data.contracts.find((c) =>
    ROBINHOOD_CHAIN_SLUGS.has(c.chain.toLowerCase()),
  ) ?? data.contracts[0]

  if (!isAddress(robinhoodContract.address)) {
    throw new Error(`Contract address from OpenSea is invalid: ${robinhoodContract.address}`)
  }

  logger.success(`Resolved "${slug}" → ${robinhoodContract.address} (${robinhoodContract.chain})`)

  return {
    contractAddress: robinhoodContract.address,
    collectionName: data.name,
    chain: robinhoodContract.chain,
  }
}
