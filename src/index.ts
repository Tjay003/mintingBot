#!/usr/bin/env node
import 'dotenv/config'
import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { resolveTarget } from './utils/opensea-resolver.js'
import { analyzeContract, printAnalysis } from './utils/contract-analyzer.js'
import { getPublicClient, loadBalances } from './wallets/manager.js'
import { printGasSummary } from './core/gas-manager.js'
import { runPublicMint } from './strategies/public-mint.js'
import { runWhitelistMint, type WlMode } from './strategies/whitelist-mint.js'
import { runSnipeMint } from './strategies/snipe-mint.js'
import { runScheduledMint } from './strategies/scheduled-mint.js'
import { logger } from './utils/logger.js'
import type { GasStrategy } from './core/gas-manager.js'

const program = new Command()

program
  .name('mintbot')
  .description(chalk.bold('🤖 MintBot') + chalk.dim(' — High-performance NFT minting bot for Robinhood Chain'))
  .version('1.0.0')

// ─── ui ───────────────────────────────────────────────────────────────────────

program
  .command('ui')
  .description('Launch the Web Dashboard control panel in your browser (http://localhost:3000)')
  .action(async () => {
    try {
      const { startServer } = await import('../server/index.js')
      await startServer()
    } catch (err) {
      logger.error(String(err))
      process.exit(1)
    }
  })

// ─── analyze ─────────────────────────────────────────────────────────────────

program
  .command('analyze <target>')
  .description('Analyze an NFT contract — detects mint function, price, WL type, and sale status')
  .action(async (target: string) => {
    const spinner = ora('Resolving target...').start()
    try {
      const { contractAddress, collectionName } = await resolveTarget(target)
      spinner.succeed(`Resolved: ${contractAddress}${collectionName ? ` (${collectionName})` : ''}`)

      const client = getPublicClient()
      const analysis = await analyzeContract(client, contractAddress)
      printAnalysis(analysis)
    } catch (err) {
      spinner.fail()
      logger.error(String(err))
      process.exit(1)
    }
  })

// ─── status ──────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show all wallet addresses and ETH balances')
  .action(async () => {
    try {
      await loadBalances(true)
    } catch (err) {
      logger.error(String(err))
      process.exit(1)
    }
  })

// ─── gas ─────────────────────────────────────────────────────────────────────

program
  .command('gas')
  .description('Check current gas prices on Robinhood Chain')
  .action(async () => {
    try {
      const client = getPublicClient()
      await printGasSummary(client)
    } catch (err) {
      logger.error(String(err))
      process.exit(1)
    }
  })

// ─── mint ─────────────────────────────────────────────────────────────────────

program
  .command('mint <target>')
  .description('Public mint — fires all wallets immediately (paste OpenSea URL or contract address)')
  .option('-q, --quantity <n>', 'NFTs to mint per wallet', '1')
  .option('-p, --price <eth>', 'Mint price in ETH per token (e.g. 0.05)', '0')
  .option('-f, --function <name>', 'Mint function name override', 'mint')
  .option(
    '-g, --gas-strategy <mode>',
    'Gas strategy: safe | fast | turbo | custom',
    'fast',
  )
  .option('--gas-price <gwei>', 'Custom gas price in Gwei (only for --gas-strategy custom)')
  .option('-v, --vault <address>', 'Auto-transfer / sweep minted NFTs to cold vault address')
  .action(async (target: string, opts: { quantity: string; price: string; function: string; gasStrategy: string; gasPrice?: string; vault?: string }) => {
    const spinner = ora('Resolving target...').start()
    try {
      const { contractAddress, collectionName } = await resolveTarget(target)
      spinner.succeed(`Target: ${contractAddress}${collectionName ? ` (${collectionName})` : ''}`)

      await runPublicMint({
        contractAddress,
        functionName: opts.function,
        quantity: parseInt(opts.quantity, 10),
        priceEth: opts.price,
        gasStrategy: opts.gasStrategy as GasStrategy,
        customGasPriceGwei: opts.gasPrice ? parseFloat(opts.gasPrice) : undefined,
        autoTransferVault: opts.vault as `0x${string}` | undefined,
      })
    } catch (err) {
      spinner.fail()
      logger.error(String(err))
      process.exit(1)
    }
  })

// ─── snipe ────────────────────────────────────────────────────────────────────

program
  .command('snipe <target>')
  .description('FCFS Snipe — watches the contract and mints the instant sale goes live')
  .option('-q, --quantity <n>', 'NFTs to mint per wallet', '1')
  .option('-p, --price <eth>', 'Expected mint price in ETH per token', '0')
  .option('-f, --function <name>', 'Mint function name override', 'mint')
  .option(
    '-g, --gas-strategy <mode>',
    'Gas strategy: safe | fast | turbo | custom (recommend: turbo for FCFS)',
    'turbo',
  )
  .option('--gas-price <gwei>', 'Custom gas price in Gwei (only for --gas-strategy custom)')
  .option('-v, --vault <address>', 'Auto-transfer / sweep minted NFTs to cold vault address')
  .action(async (target: string, opts: { quantity: string; price: string; function: string; gasStrategy: string; gasPrice?: string; vault?: string }) => {
    const spinner = ora('Resolving target...').start()
    try {
      const { contractAddress, collectionName } = await resolveTarget(target)
      spinner.succeed(`Target: ${contractAddress}${collectionName ? ` (${collectionName})` : ''}`)

      await runSnipeMint({
        contractAddress,
        functionName: opts.function,
        quantity: parseInt(opts.quantity, 10),
        priceEth: opts.price,
        gasStrategy: opts.gasStrategy as GasStrategy,
        customGasPriceGwei: opts.gasPrice ? parseFloat(opts.gasPrice) : undefined,
        autoTransferVault: opts.vault as `0x${string}` | undefined,
      })
    } catch (err) {
      spinner.fail()
      logger.error(String(err))
      process.exit(1)
    }
  })

// ─── wl-mint ──────────────────────────────────────────────────────────────────

program
  .command('wl-mint <target>')
  .description('Whitelist mint — auto-detects WL type (merkle-proof, signature, or on-chain)')
  .option('-q, --quantity <n>', 'NFTs to mint per wallet', '1')
  .option('-p, --price <eth>', 'Mint price in ETH per token', '0')
  .option(
    '--wl-mode <mode>',
    'WL type: merkle-proof | signature | on-chain (auto-detected if not set)',
  )
  .option(
    '--proof <json>',
    'Merkle proof JSON array, e.g. \'["0xabc...","0xdef..."]\' (for merkle-proof mode)',
  )
  .option(
    '--signature <hex>',
    'Signed WL message from the project (for signature mode)',
  )
  .option('-f, --function <name>', 'Mint function name override')
  .option(
    '-g, --gas-strategy <mode>',
    'Gas strategy: safe | fast | turbo | custom',
    'fast',
  )
  .option('--gas-price <gwei>', 'Custom gas price in Gwei (only for --gas-strategy custom)')
  .option('-v, --vault <address>', 'Auto-transfer / sweep minted NFTs to cold vault address')
  .action(
    async (
      target: string,
      opts: {
        quantity: string
        price: string
        wlMode?: string
        proof?: string
        signature?: string
        function?: string
        gasStrategy: string
        gasPrice?: string
        vault?: string
      },
    ) => {
      const spinner = ora('Resolving target...').start()
      try {
        const { contractAddress, collectionName } = await resolveTarget(target)
        spinner.succeed(`Target: ${contractAddress}${collectionName ? ` (${collectionName})` : ''}`)

        // Auto-detect WL mode if not specified
        let wlMode: WlMode
        if (opts.wlMode) {
          wlMode = opts.wlMode as WlMode
        } else if (opts.proof) {
          wlMode = 'merkle-proof'
        } else if (opts.signature) {
          wlMode = 'signature'
        } else {
          wlMode = 'on-chain'
        }

        // Parse merkle proof if provided
        let merkleProof: `0x${string}`[] | undefined
        if (opts.proof) {
          try {
            merkleProof = JSON.parse(opts.proof) as `0x${string}`[]
          } catch {
            throw new Error('Could not parse --proof. Provide a JSON array, e.g. \'["0xabc...","0xdef..."]\'')
          }
        }

        logger.info(`WL mode: ${wlMode}`)

        await runWhitelistMint({
          contractAddress,
          wlMode,
          merkleProof,
          signature: opts.signature as `0x${string}` | undefined,
          functionName: opts.function,
          quantity: parseInt(opts.quantity, 10),
          priceEth: opts.price,
          gasStrategy: opts.gasStrategy as GasStrategy,
          customGasPriceGwei: opts.gasPrice ? parseFloat(opts.gasPrice) : undefined,
          autoTransferVault: opts.vault as `0x${string}` | undefined,
        })
      } catch (err) {
        spinner.fail()
        logger.error(String(err))
        process.exit(1)
      }
    },
  )

// ─── schedule ─────────────────────────────────────────────────────────────────

program
  .command('schedule <target>')
  .description('Scheduled mint — fires at a specific time (use for announced mint times)')
  .requiredOption('-t, --time <datetime>', 'Mint time in ISO 8601 format, e.g. "2026-08-15T14:00:00Z"')
  .option('-q, --quantity <n>', 'NFTs to mint per wallet', '1')
  .option('-p, --price <eth>', 'Mint price in ETH per token', '0')
  .option('-f, --function <name>', 'Mint function name override', 'mint')
  .option(
    '-g, --gas-strategy <mode>',
    'Gas strategy: safe | fast | turbo | custom',
    'turbo',
  )
  .option('--gas-price <gwei>', 'Custom gas price in Gwei (only for --gas-strategy custom)')
  .option('-v, --vault <address>', 'Auto-transfer / sweep minted NFTs to cold vault address')
  .action(
    async (
      target: string,
      opts: {
        time: string
        quantity: string
        price: string
        function: string
        gasStrategy: string
        gasPrice?: string
        vault?: string
      },
    ) => {
      const spinner = ora('Resolving target...').start()
      try {
        const { contractAddress, collectionName } = await resolveTarget(target)
        spinner.succeed(`Target: ${contractAddress}${collectionName ? ` (${collectionName})` : ''}`)

        await runScheduledMint({
          contractAddress,
          functionName: opts.function,
          quantity: parseInt(opts.quantity, 10),
          priceEth: opts.price,
          mintTime: opts.time,
          gasStrategy: opts.gasStrategy as GasStrategy,
          customGasPriceGwei: opts.gasPrice ? parseFloat(opts.gasPrice) : undefined,
          autoTransferVault: opts.vault as `0x${string}` | undefined,
        })
      } catch (err) {
        spinner.fail()
        logger.error(String(err))
        process.exit(1)
      }
    },
  )

// ─── fund (Multicall3) ─────────────────────────────────────────────────────────

program
  .command('fund <amountEth>')
  .description('Fund all burner wallets in 1 transaction using Multicall3 (e.g. mintbot fund 0.005)')
  .option('-p, --private-key <key>', 'Funder master private key (defaults to WALLET_KEY_1 or SPONSOR_KEY)')
  .action(async (amountEth: string, opts: { privateKey?: string }) => {
    try {
      const { batchFundWallets } = await import('./wallets/funder.js')
      const { getSettings } = await import('./config/settings.js')
      const settings = getSettings()

      const funderKey = opts.privateKey || settings.sponsorKey || settings.walletKeys[0]
      if (!funderKey) {
        throw new Error('No funder private key available in .env or --private-key argument')
      }

      await batchFundWallets({
        funderPrivateKey: funderKey as `0x${string}`,
        amountEthPerWallet: amountEth,
      })
    } catch (err) {
      logger.error(String(err))
      process.exit(1)
    }
  })

// ─── sweep (Dust & Vault) ──────────────────────────────────────────────────────

program
  .command('sweep [recipient]')
  .description('Sweep all remaining native ETH dust from burner wallets back to cold vault')
  .action(async (recipient?: string) => {
    try {
      const { sweepNativeEthBalances } = await import('./wallets/funder.js')
      const { getSettings } = await import('./config/settings.js')
      const settings = getSettings()

      const target = recipient || settings.recipientAddress || settings.autoTransferVault
      if (!target || !target.startsWith('0x') || target.length !== 42) {
        throw new Error('Please specify a valid 0x recipient address, or set RECIPIENT_ADDRESS in .env')
      }

      await sweepNativeEthBalances(target as `0x${string}`)
    } catch (err) {
      logger.error(String(err))
      process.exit(1)
    }
  })

// ─── Parse & run ──────────────────────────────────────────────────────────────

program.parse(process.argv)
