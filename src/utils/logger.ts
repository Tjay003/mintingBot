import chalk from 'chalk'
import { createWriteStream, mkdirSync } from 'fs'
import { join } from 'path'
import { wsBridge } from './ws-bridge.js'

// Ensure logs directory exists
mkdirSync(join(process.cwd(), 'logs'), { recursive: true })

const logFile = createWriteStream(
  join(process.cwd(), 'logs', `mintbot-${new Date().toISOString().slice(0, 10)}.log`),
  { flags: 'a' },
)

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

function isoNow(): string {
  return new Date().toISOString()
}

function writeToFile(level: string, message: string): void {
  logFile.write(`[${isoNow()}] [${level}] ${stripAnsi(message)}\n`)
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '')
}

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'fire' | 'block'

function broadcast(level: LogLevel, message: string): void {
  wsBridge.emit('ws', { type: 'log', level, message, timestamp: isoNow() })
}

export const logger = {
  info(message: string): void {
    const line = `${chalk.dim(timestamp())}  ${chalk.cyan('ℹ')}  ${message}`
    console.log(line)
    writeToFile('INFO', message)
    broadcast('info', message)
  },

  success(message: string): void {
    const line = `${chalk.dim(timestamp())}  ${chalk.green('✓')}  ${chalk.green(message)}`
    console.log(line)
    writeToFile('SUCCESS', message)
    broadcast('success', message)
  },

  warn(message: string): void {
    const line = `${chalk.dim(timestamp())}  ${chalk.yellow('⚠')}  ${chalk.yellow(message)}`
    console.log(line)
    writeToFile('WARN', message)
    broadcast('warn', message)
  },

  error(message: string): void {
    const line = `${chalk.dim(timestamp())}  ${chalk.red('✗')}  ${chalk.red(message)}`
    console.error(line)
    writeToFile('ERROR', message)
    broadcast('error', message)
  },

  fire(message: string): void {
    const line = `${chalk.dim(timestamp())}  ${chalk.magenta('🚀')}  ${chalk.bold(chalk.magenta(message))}`
    console.log(line)
    writeToFile('FIRE', message)
    broadcast('fire', message)
  },

  block(blockNumber: bigint, extra = ''): void {
    const line = `${chalk.dim(timestamp())}  ${chalk.dim('▸')}  ${chalk.dim(`Block #${blockNumber.toLocaleString()}`)}  ${chalk.dim(extra)}`
    process.stdout.write(`\r${line}`)
    writeToFile('BLOCK', `Block #${blockNumber} ${extra}`)
    broadcast('block', `Block #${blockNumber.toLocaleString()}  ${extra}`)
  },

  divider(): void {
    console.log(chalk.dim('─'.repeat(60)))
  },

  banner(): void {
    console.log('')
    console.log(chalk.bold('  🤖  MintBot') + chalk.dim('  ·  Robinhood Chain'))
    console.log(chalk.dim('  High-performance NFT minting bot'))
    console.log('')
  },
}
