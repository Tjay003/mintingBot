import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { attachWebSocket } from './ws-emitter.js'
import { walletsRouter } from './api/wallets.js'
import { analyzeRouter } from './api/analyze.js'
import { gasRouter } from './api/gas.js'
import { sessionRouter } from './api/session.js'
import { logger } from '../src/utils/logger.js'

const app = express()
const server = createServer(app)

app.use(cors())
app.use(express.json())

// Serve static frontend files
app.use(express.static(join(process.cwd(), 'public')))

// Mount API routes
app.use('/api/wallets', walletsRouter)
app.use('/api/analyze', analyzeRouter)
app.use('/api/gas', gasRouter)
app.use('/api/session', sessionRouter)

// Attach WebSocket server for live updates
attachWebSocket(server)

const PORT = process.env.PORT || 3000

export function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      logger.banner()
      logger.success(`Web Dashboard running at http://localhost:${PORT}`)
      logger.info(`Open your browser to access the control panel.`)
      resolve()
    })
  })
}

// Check if run directly
const currentFilePath = fileURLToPath(import.meta.url)
const entryFilePath = process.argv[1] ? join(process.argv[1]) : ''

if (currentFilePath.toLowerCase() === entryFilePath.toLowerCase() || process.argv.slice(2).includes('--standalone')) {
  startServer()
}
