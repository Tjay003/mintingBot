# MintBot — Project Context & Architecture Memory

> **Canonical System State & Knowledge Base**
> *Last Updated:* August 17, 2026

---

## 1. Overview & Architecture

MintBot is a high-performance, multi-wallet NFT sniping and minting engine built specifically for **Robinhood Chain** (Arbitrum Orbit L2) and standard EVM networks. It features a standalone Web Dashboard (Neobrutalist Emerald Green theme) and a background node execution engine.

### Tech Stack
- **Language / Runtime:** TypeScript, Node.js (v18+)
- **Web3 / Blockchain Client:** `viem` (Type-safe, high-speed RPC/WSS client)
- **Web Server:** Express + `ws` (WebSocket live terminal log streamer)
- **Frontend:** Vanilla HTML5 / CSS3 / ES6 (Zero-framework, zero build step, Neobrutalist design with Lucide icons)
- **Process Manager:** Background Node tasks via `tsx`

---

## 2. Robinhood Chain Specification

- **Chain ID:** `4663`
- **Network Name:** Robinhood Chain (Arbitrum Orbit L2)
- **RPC Endpoint:** `https://rpc.mainnet.chain.robinhood.com`
- **WebSocket Endpoint:** `wss://rpc.mainnet.chain.robinhood.com`
- **Block Explorer:** `https://explorer.mainnet.chain.robinhood.com`
- **Blockscout API:** `https://robinhoodchain.blockscout.com/api`
- **Block Time:** ~250ms with centralized sequencer

---

## 3. Supported Mint Protocols & Contract Routing

MintBot supports 4 distinct minting archetypes with automatic detection:

### A. OpenSea SeaDrop Protocol (Robinhood Chain Launchpad)
- **SeaDrop Router Address:** `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`
- **OpenSea Fee Recipient:** `0x0000a26b00c1f0df003000390027140000faa719`
- **Function:** `mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)`
- **Auto-Routing:** When a target contract implements `mintSeaDrop(address,uint256)`, the bot automatically routes the transaction to the SeaDrop router with the target contract as parameter.
- **Stage Parser:** Extracts all OpenSea drop stages (`SIGNED_PRESALE`, `PUBLIC_SALE`, `ALLOW_LIST`) directly from collection metadata with interactive stage buttons in Schedule and Analyzer tabs.

### B. Standard Direct Mints (ERC-721 / ERC-1155)
- Standard signatures probed: `mint(uint256)`, `publicMint(uint256)`, `claim(uint256)`, `freeMint()`, `mint()`.

### C. Whitelist & Merkle Proof Drops
- Supports `mint(uint256,bytes32[])`, `whitelistMint(uint256,bytes32[])`, and signature-based `mint(uint256,bytes)` with local tree generation (`keccak256(walletAddress)`).
- For OpenSea SeaDrop collections, whitelist/on-chain registered mints are automatically routed to the SeaDrop Router (`0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`).

### D. Unverified Contract Bytecode Probing
- When a contract is not verified on Blockscout, the bot probes common 4-byte function selectors and SeaDrop router state directly on-chain.

---

## 4. Key Engine Features & Performance

### ⚡ Pre-Signed T-0 Byte Blast (Scheduled Drops)
- **Phase 1 (T - 5s):** Pre-fetches nonces across all selected wallets, builds calldata, and pre-signs raw EIP-1559 transaction hex (`wallet.client.signTransaction(...)`). Holds raw bytes in memory.
- **Phase 2 (T - 0s):** Blasts pre-signed raw bytes directly to RPC via `publicClient.sendRawTransaction(...)` in parallel using `Promise.allSettled`.
- **Latency:** < 50ms dispatch overhead at launch time.

### 🔍 Auto Price & Limit Detection
- Queries `getPublicDrop(nftContract)` on the SeaDrop router or contract view methods to automatically resolve:
  - Mint price in ETH & wei
  - Wallet limit (`maxTotalMintableByWallet`)
  - Live status (`isLive: now >= startTime && now <= endTime`)
- Frontend input fields auto-populate and update cost summaries dynamically on paste.

### 👛 Multi-Wallet Selection & Wallet Manager
- Clean, full-width row-by-row card layout for Active Sessions, Scheduled Drops, and Live Armed Countdown cards.
- Custom wallet renaming/labels (`WALLET_LABEL_N` in `.env`, editable via UI pencil button in Wallets tab).
- Interactive checkbox selection with hover transitions, address pills, and live ETH + USD balance values.
- Real-time ETH/USDT live ticker from Binance / CoinGecko.

### ⏱️ Telemetry & Timing
- Logs exact milliseconds for:
  - `submitDurationMs` (RPC Sequencer dispatch latency)
  - `confirmDurationMs` (On-chain block inclusion time)
  - `totalDurationMs` (End-to-end execution duration)

---

## 5. Chrome Extension Companion (`extension/`)
- **Manifest V3 Extension**: Packaged in [`extension/`](file:///C:/Users/Tyrone%20James%20Bacolod/orca/projects/mintingBot/extension).
- **Injected Drop HUD (`content.js` / `content.css`)**: Injects an interactive overlay on `opensea.io/collection/*/drop` showing active stages, live countdowns, wallet status, and 1-click **"⚡ BLAST ALL WALLETS"** button.
- **Popup Control Panel (`popup.html` / `popup.js`)**: Quick toolbar menu with live wallet balances, gas toggles (Turbo / Fast / Safe), and tab detection.
- **Local Bridge Router (`server/api/extension.ts`)**:
  - `GET /api/extension/status`: Fetches core status and wallet balances.
  - `POST /api/extension/mint`: Triggers multi-wallet parallel mint session.
- **Hotkey**: `Ctrl + Shift + M` / `Cmd + Shift + M` triggers an instant snipe on the active OpenSea drop tab.

---

## 5. Directory Structure & Key Files

```
mintingBot/
├── CONTEXT.md                       # Canonical project state & architecture memory (This file)
├── server/
│   ├── index.ts                     # Express server + WebSocket console broadcaster
│   ├── session.ts                   # In-memory Active Session & Schedule state manager
│   ├── api/
│   │   ├── analyze.ts               # POST /api/analyze (contract & SeaDrop stage parser)
│   │   ├── gas.ts                   # GET /api/gas (EIP-1559 gas tiers + USDT estimates)
│   │   ├── session.ts               # POST /api/session/start, stop, schedule, cancel
│   │   └── wallets.ts               # GET /api/wallets (balances + USDT values)
│   └── utils/
│       └── price.ts                 # Real-time ETH/USDT price fetcher (cached)
├── public/
│   └── index.html                   # Neobrutalist Web Dashboard (Emerald Green theme)
├── src/
│   ├── config/
│   │   ├── chain.ts                 # Robinhood Chain viem definition
│   │   └── settings.ts              # Settings & safety limit parser (.env)
│   ├── core/
│   │   ├── tx-builder.ts            # Tx builder, pre-signer, parallel raw blast engine
│   │   ├── block-monitor.ts         # WebSocket block watcher & countdown helper
│   │   └── gas-manager.ts           # Safe/Fast/Turbo gas tier calculator
│   ├── strategies/
│   │   ├── public-mint.ts           # Instant parallel mint strategy
│   │   ├── snipe-mint.ts            # FCFS block-watcher snipe strategy
│   │   ├── scheduled-mint.ts        # Two-stage T-5s pre-sign & T-0 blast strategy
│   │   └── whitelist-mint.ts        # Merkle proof mint strategy
│   ├── utils/
│   │   ├── contract-analyzer.ts     # Verified ABI & SeaDrop router prober
│   │   ├── opensea-resolver.ts      # OpenSea URL slug to 0x address converter
│   │   └── logger.ts                # Dual console & WebSocket log emitter
│   └── wallets/
│       └── manager.ts               # Multi-wallet balance & nonce loader
└── package.json
```

---

## 6. Development & Run Commands

```bash
# Start Web Dashboard on port 3000
npm run ui

# Check TypeScript types
npx tsc --noEmit

# Build production bundle
npm run build
```

---

## 7. Roadmap / Next Steps

1. **Auto-Transfer / Vault Consolidation:** Option to automatically transfer minted NFTs to a designated cold wallet (`RECIPIENT_ADDRESS`).
2. **Multicall3 Batch Multi-Funder:** One-click funding of all bot wallets from a master wallet in a single transaction.
