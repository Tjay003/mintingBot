import {
  encodeFunctionData,
  type Address,
  type PublicClient,
  type TransactionReceipt,
  type Abi,
  keccak256,
  toBytes,
} from 'viem'
import type { ManagedWallet } from '../wallets/manager.js'
import { logger } from './logger.js'

// Standard ERC-721 Transfer event signature: Transfer(address from, address to, uint256 tokenId)
const ERC721_TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'))
// Standard ERC-1155 TransferSingle: TransferSingle(address operator, address from, address to, uint256 id, uint256 value)
const ERC1155_SINGLE_TOPIC = keccak256(toBytes('TransferSingle(address,address,address,uint256,uint256)'))
// Standard ERC-1155 TransferBatch: TransferBatch(address operator, address from, address to, uint256[] ids, uint256[] values)
const ERC1155_BATCH_TOPIC = keccak256(toBytes('TransferBatch(address,address,address,uint256[],uint256[])'))

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

export const ERC721_TRANSFER_ABI: Abi = [
  {
    name: 'safeTransferFrom',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'transferFrom',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
]

export interface MintedAsset {
  contractAddress: Address
  tokenId: bigint
  isErc1155?: boolean
  amount?: bigint
}

/**
 * Inspect transaction receipt logs to find exact tokens minted from 0x0 to the minter wallet.
 */
export function extractMintedTokenIds(
  receipt: TransactionReceipt,
  nftContract: Address,
  minterAddress: Address,
): MintedAsset[] {
  const assets: MintedAsset[] = []
  const targetContractLower = nftContract.toLowerCase()
  const minterLower = minterAddress.toLowerCase()

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== targetContractLower) continue
    if (!log.topics || log.topics.length === 0) continue

    const topic0 = log.topics[0]

    // 1. ERC-721 Transfer(from, to, tokenId)
    if (topic0 === ERC721_TRANSFER_TOPIC && log.topics.length === 4) {
      const fromAddr = `0x${log.topics[1]?.slice(26)}`.toLowerCase()
      const toAddr = `0x${log.topics[2]?.slice(26)}`.toLowerCase()
      const tokenIdHex = log.topics[3]

      // Verify minted from zero address to minter
      if (fromAddr === ZERO_ADDRESS.toLowerCase() && toAddr === minterLower && tokenIdHex) {
        assets.push({
          contractAddress: log.address,
          tokenId: BigInt(tokenIdHex),
          isErc1155: false,
        })
      }
    }

    // 2. ERC-1155 TransferSingle(operator, from, to, id, value)
    if (topic0 === ERC1155_SINGLE_TOPIC && log.topics.length === 4) {
      const fromAddr = `0x${log.topics[2]?.slice(26)}`.toLowerCase()
      const toAddr = `0x${log.topics[3]?.slice(26)}`.toLowerCase()

      if (fromAddr === ZERO_ADDRESS.toLowerCase() && toAddr === minterLower && log.data) {
        try {
          const rawData = log.data.slice(2)
          if (rawData.length >= 64) {
            const tokenIdHex = `0x${rawData.slice(0, 64)}`
            const amountHex = `0x${rawData.slice(64, 128)}`
            assets.push({
              contractAddress: log.address,
              tokenId: BigInt(tokenIdHex),
              amount: BigInt(amountHex),
              isErc1155: true,
            })
          }
        } catch {
          // continue parsing
        }
      }
    }
  }

  return assets
}

/**
 * Sweep a single NFT from burner wallet to cold storage recipient address.
 */
export async function sweepNftToVault(
  wallet: ManagedWallet,
  publicClient: PublicClient,
  nftContract: Address,
  recipientAddress: Address,
  tokenId: bigint,
): Promise<{ hash: `0x${string}`; tokenId: bigint }> {
  logger.info(
    `[Auto-Transfer] Wallet ${wallet.index} → Sweeping Token ID #${tokenId} to cold vault ${recipientAddress}...`,
  )

  const data = encodeFunctionData({
    abi: ERC721_TRANSFER_ABI,
    functionName: 'safeTransferFrom',
    args: [wallet.address, recipientAddress, tokenId],
  })

  // Estimate gas
  let gas = 100_000n
  try {
    gas = await publicClient.estimateGas({
      account: wallet.address,
      to: nftContract,
      data,
    })
    gas = (gas * 12n) / 10n // +20% buffer
  } catch {
    logger.warn(`[Auto-Transfer] Gas estimation failed for safeTransferFrom, using 120k fallback`)
    gas = 120_000n
  }

  const hash = await wallet.client.sendTransaction({
    account: wallet.client.account!,
    to: nftContract,
    data,
    gas,
    chain: wallet.client.chain,
  })

  logger.info(`[Auto-Transfer] Wallet ${wallet.index} → Sweep tx submitted: ${hash}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })

  if (receipt.status === 'success') {
    logger.success(
      `[Auto-Transfer] ✓ Token #${tokenId} secured in cold vault (${recipientAddress}) in block #${receipt.blockNumber}`,
    )
  } else {
    throw new Error(`Auto-transfer reverted for Token #${tokenId}`)
  }

  return { hash, tokenId }
}

/**
 * Process auto-transfer / sweep of all newly minted tokens for a given wallet.
 */
export async function processAutoTransfer(
  wallet: ManagedWallet,
  publicClient: PublicClient,
  nftContract: Address,
  recipientAddress: Address,
  receipt: TransactionReceipt,
): Promise<Array<{ tokenId: bigint; hash: `0x${string}`; error?: string }>> {
  if (!recipientAddress || recipientAddress.toLowerCase() === wallet.address.toLowerCase()) {
    return []
  }

  const mintedAssets = extractMintedTokenIds(receipt, nftContract, wallet.address)
  if (mintedAssets.length === 0) {
    logger.warn(
      `[Auto-Transfer] Wallet ${wallet.index}: No standard Transfer(0x0 -> wallet) events detected in receipt`,
    )
    return []
  }

  logger.fire(
    `[Auto-Transfer] Detected ${mintedAssets.length} minted NFT(s) for Wallet ${wallet.index}. Sweeping to cold vault...`,
  )

  const sweepResults: Array<{ tokenId: bigint; hash: `0x${string}`; error?: string }> = []

  for (const asset of mintedAssets) {
    try {
      const res = await sweepNftToVault(
        wallet,
        publicClient,
        asset.contractAddress,
        recipientAddress,
        asset.tokenId,
      )
      sweepResults.push({ tokenId: asset.tokenId, hash: res.hash })
    } catch (err) {
      const errorMsg = String(err)
      logger.error(`[Auto-Transfer] Failed to sweep Token #${asset.tokenId}: ${errorMsg}`)
      sweepResults.push({ tokenId: asset.tokenId, hash: '0x', error: errorMsg })
    }
  }

  return sweepResults
}
