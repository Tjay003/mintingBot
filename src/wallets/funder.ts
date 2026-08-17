import {
  encodeFunctionData,
  parseEther,
  formatEther,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type Abi,
  type WalletClient,
  type Transport,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { robinhoodChain } from '../config/chain.js'
import { getPublicClient, getWallets, type ManagedWallet } from './manager.js'
import { getSettings } from '../config/settings.js'
import { logger } from '../utils/logger.js'

export const MULTICALL3_ADDRESS: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

export const MULTICALL3_ABI: Abi = [
  {
    name: 'aggregate3Value',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
]

export interface BatchFundOptions {
  /** Funder wallet (signer) */
  funderWallet?: ManagedWallet
  /** Or funder private key directly */
  funderPrivateKey?: `0x${string}`
  /** ETH amount to send to each target wallet (e.g. "0.005") */
  amountEthPerWallet: string
  /** Target wallet indices (default: all managed wallets) */
  targetWalletIndices?: number[]
}

export interface BatchFundResult {
  method: 'multicall3' | 'direct'
  transactionHash: `0x${string}`
  walletsFunded: number
  amountPerWalletEth: string
  totalEthDistributed: string
  blockNumber?: bigint
}

export interface SweepResult {
  wallet: ManagedWallet
  amountEth: string
  hash?: `0x${string}`
  error?: string
}

/**
 * Fund all burner wallets in 1 single atomic Multicall3 transaction.
 */
export async function batchFundWallets(opts: BatchFundOptions): Promise<BatchFundResult> {
  const publicClient = getPublicClient()
  const { rpc } = getSettings()

  let funderClient: WalletClient<Transport, typeof robinhoodChain>
  let funderAddress: Address

  if (opts.funderPrivateKey) {
    const account = privateKeyToAccount(opts.funderPrivateKey)
    funderAddress = account.address
    funderClient = createWalletClient({
      account,
      chain: robinhoodChain,
      transport: http(rpc.http),
    })
  } else if (opts.funderWallet) {
    funderAddress = opts.funderWallet.address
    funderClient = opts.funderWallet.client
  } else {
    // Default to first wallet if available
    const wallets = getWallets()
    if (wallets.length === 0) throw new Error('No funder wallet available.')
    funderAddress = wallets[0].address
    funderClient = wallets[0].client
  }

  const allWallets = getWallets()
  const targetWallets = opts.targetWalletIndices && opts.targetWalletIndices.length > 0
    ? allWallets.filter((w) => opts.targetWalletIndices!.includes(w.index))
    : allWallets.filter((w) => w.address.toLowerCase() !== funderAddress.toLowerCase())

  if (targetWallets.length === 0) {
    throw new Error('No recipient burner wallets found to fund.')
  }

  const amountWei = parseEther(opts.amountEthPerWallet)
  if (amountWei <= 0n) throw new Error('Funding amount must be greater than 0 ETH.')

  const totalDistributedWei = amountWei * BigInt(targetWallets.length)
  const totalEthStr = formatEther(totalDistributedWei)

  logger.banner()
  logger.fire(`⚡ Multicall3 1-Tx Batch Funder`)
  logger.info(`Funder Account: ${funderAddress}`)
  logger.info(`Target Wallets: ${targetWallets.length} wallet(s)`)
  logger.info(`Amount Each:    ${opts.amountEthPerWallet} ETH`)
  logger.info(`Total Sending:  ${totalEthStr} ETH`)
  logger.divider()

  // Check funder balance
  const funderBalance = await publicClient.getBalance({ address: funderAddress })
  if (funderBalance < totalDistributedWei) {
    throw new Error(
      `Funder balance (${formatEther(funderBalance)} ETH) is less than required total (${totalEthStr} ETH + gas).`,
    )
  }

  // Construct Multicall3 calls
  const calls = targetWallets.map((w) => ({
    target: w.address,
    allowFailure: false,
    value: amountWei,
    callData: '0x' as `0x${string}`,
  }))

  const data = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3Value',
    args: [calls],
  })

  let gas = 300_000n
  let useMulticall = true

  try {
    const est = await publicClient.estimateGas({
      account: funderAddress,
      to: MULTICALL3_ADDRESS,
      data,
      value: totalDistributedWei,
    })
    gas = (est * 12n) / 10n // +20% buffer
  } catch (estErr) {
    logger.warn(`Multicall3 gas estimation failed or contract unavailable. Falling back to direct transfers.`)
    useMulticall = false
  }

  if (useMulticall) {
    logger.info(`Broadcasting 1-Tx Multicall3 transaction to ${MULTICALL3_ADDRESS}...`)
    const hash = await funderClient.sendTransaction({
      account: funderClient.account!,
      to: MULTICALL3_ADDRESS,
      data,
      value: totalDistributedWei,
      gas,
      chain: funderClient.chain,
    })

    logger.info(`Multicall3 tx broadcasted: ${hash}`)
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })

    if (receipt.status === 'success') {
      logger.success(
        `✓ Multicall3 batch funded ${targetWallets.length} wallets in 1 tx! Block #${receipt.blockNumber}`,
      )
      return {
        method: 'multicall3',
        transactionHash: hash,
        walletsFunded: targetWallets.length,
        amountPerWalletEth: opts.amountEthPerWallet,
        totalEthDistributed: totalEthStr,
        blockNumber: receipt.blockNumber,
      }
    } else {
      throw new Error(`Multicall3 funding transaction reverted: ${hash}`)
    }
  } else {
    // Fallback direct sequential transfers
    logger.info(`Sending direct transfers to ${targetWallets.length} wallets...`)
    let lastHash: `0x${string}` = '0x'
    for (const tw of targetWallets) {
      lastHash = await funderClient.sendTransaction({
        account: funderClient.account!,
        to: tw.address,
        value: amountWei,
        chain: funderClient.chain,
      })
      logger.info(`Funded Wallet ${tw.index} (${tw.address}) → ${lastHash}`)
    }
    return {
      method: 'direct',
      transactionHash: lastHash,
      walletsFunded: targetWallets.length,
      amountPerWalletEth: opts.amountEthPerWallet,
      totalEthDistributed: totalEthStr,
    }
  }
}

/**
 * Sweep all native ETH dust from burner wallets back to a master vault/recipient address.
 */
export async function sweepNativeEthBalances(
  recipientAddress: Address,
  walletIndices?: number[],
): Promise<SweepResult[]> {
  const publicClient = getPublicClient()
  let wallets = getWallets()

  if (walletIndices && walletIndices.length > 0) {
    wallets = wallets.filter((w) => walletIndices.includes(w.index))
  }

  const results: SweepResult[] = []
  logger.banner()
  logger.fire(`💸 Sweeping Native ETH Balances to ${recipientAddress}`)
  logger.divider()

  for (const w of wallets) {
    if (w.address.toLowerCase() === recipientAddress.toLowerCase()) {
      continue
    }

    try {
      const balance = await publicClient.getBalance({ address: w.address })
      if (balance <= 0n) {
        results.push({ wallet: w, amountEth: '0.0000', error: 'Zero balance' })
        continue
      }

      // Reserve gas for transfer (21,000 standard transfer gas * gasPrice)
      const gasPrice = await publicClient.getGasPrice()
      const gasCost = 21_000n * gasPrice * 2n // 2x gas price buffer

      if (balance <= gasCost) {
        results.push({
          wallet: w,
          amountEth: formatEther(balance),
          error: 'Balance too small to cover transfer gas',
        })
        continue
      }

      const sweepAmount = balance - gasCost
      const sweepEth = formatEther(sweepAmount)

      logger.info(`Wallet ${w.index} (${w.address}) → Sweeping ${parseFloat(sweepEth).toFixed(5)} ETH...`)

      const hash = await w.client.sendTransaction({
        account: w.client.account!,
        to: recipientAddress,
        value: sweepAmount,
        gas: 25_000n,
        chain: w.client.chain,
      })

      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })
      if (receipt.status === 'success') {
        logger.success(`Wallet ${w.index} ✓ Swept ${parseFloat(sweepEth).toFixed(5)} ETH → ${hash}`)
        results.push({ wallet: w, amountEth: sweepEth, hash })
      } else {
        throw new Error('Sweep transaction reverted')
      }
    } catch (err) {
      const errorMsg = String(err)
      logger.error(`Wallet ${w.index} sweep failed: ${errorMsg}`)
      results.push({ wallet: w, amountEth: '0', error: errorMsg })
    }
  }

  return results
}
