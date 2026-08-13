# 🤖 MintBot — NFT Minting Bot for Robinhood Chain

High-performance minting bot. Beats manual minters by interacting directly with smart contracts via WebSocket block monitoring.

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure your `.env`
```bash
copy .env.example .env
```
Then open `.env` and fill in:
- `WALLET_KEY_1` — your bot wallet private key (export from MetaMask → Account Details → Export Private Key)
- Add `WALLET_KEY_2`, `WALLET_KEY_3` etc. for multi-wallet minting
- `OPENSEA_API_KEY` — optional, needed for resolving collection slugs (free at opensea.io/developers)

> ⚠️ **NEVER use your main wallet.** Use a dedicated bot wallet with only enough ETH to mint.

### 3. (Optional) Private RPC for faster minting
Sign up at [Alchemy](https://dashboard.alchemy.com) (free), create an app, select Robinhood Chain, and copy the HTTPS + WSS URLs into `.env` as `PRIVATE_RPC_HTTP_URL` and `PRIVATE_RPC_WSS_URL`.

---

## Commands

All commands accept an **OpenSea URL** or a raw **contract address** as the target.

### Check wallet balances
```bash
npx tsx src/index.ts status
```

### Check current gas prices
```bash
npx tsx src/index.ts gas
```

### Analyze a contract before minting
Detects mint function, price, WL type, and whether sale is active.
```bash
npx tsx src/index.ts analyze https://opensea.io/collection/spritehood
npx tsx src/index.ts analyze 0xYourContractAddress
```

---

### Public Mint
Fires all wallets immediately. Use when the mint is already live.
```bash
npx tsx src/index.ts mint https://opensea.io/collection/spritehood \
  --quantity 2 \
  --price 0.05 \
  --gas-strategy fast
```

---

### FCFS Snipe ⚡ (the fastest mode)
Monitors the contract every block (~250ms). The instant the sale goes live, fires all wallets simultaneously. Run this **before** the mint opens.
```bash
npx tsx src/index.ts snipe https://opensea.io/collection/spritehood \
  --quantity 2 \
  --price 0.05 \
  --gas-strategy turbo
```

---

### Scheduled Mint
Fires at an exact clock time. Use when you know the announced mint time.
```bash
npx tsx src/index.ts schedule https://opensea.io/collection/spritehood \
  --time "2026-08-15T14:00:00Z" \
  --quantity 2 \
  --price 0.05 \
  --gas-strategy turbo
```

---

### Whitelist Mint (WL)

#### Auto-detected (on-chain WL — your wallet is already registered)
```bash
npx tsx src/index.ts wl-mint https://opensea.io/collection/spritehood \
  --quantity 1 \
  --price 0.03
```

#### Merkle Proof WL (most common — project gives you a proof)
```bash
npx tsx src/index.ts wl-mint https://opensea.io/collection/spritehood \
  --quantity 1 \
  --price 0.03 \
  --proof '["0xabc123...","0xdef456..."]'
```

#### Signature-based WL
```bash
npx tsx src/index.ts wl-mint https://opensea.io/collection/spritehood \
  --quantity 1 \
  --price 0.03 \
  --signature 0xYourSignatureHere
```

---

## Gas Strategies

| Strategy | Multiplier | When to use |
|:---|:---|:---|
| `safe` | 1.0x | Testing, low-competition mints |
| `fast` | 1.5x | Normal public mints |
| `turbo` | 2.5x | Hot FCFS races where speed is everything |
| `custom` | — | Specify exact Gwei with `--gas-price <gwei>` |

---

## Safety Limits (in `.env`)

| Variable | Default | Purpose |
|:---|:---|:---|
| `MAX_GAS_PRICE_GWEI` | 50 | Bot refuses to mint if gas exceeds this |
| `MAX_ETH_PER_MINT` | 0.5 | Max ETH per single wallet per mint |
| `MAX_TOTAL_ETH` | 2.0 | Max total ETH across all wallets in one session |

---

## File Structure

```
src/
  index.ts                    # CLI entry point
  config/
    chain.ts                  # Robinhood Chain definition
    settings.ts               # .env loader + validation
  wallets/
    manager.ts                # Multi-wallet management
  core/
    gas-manager.ts            # Gas pricing strategies
    tx-builder.ts             # Transaction builder + parallel executor
    block-monitor.ts          # WebSocket block watcher for sniping
  strategies/
    public-mint.ts            # Public mint strategy
    whitelist-mint.ts         # WL mint (merkle/signature/on-chain)
    snipe-mint.ts             # FCFS snipe strategy
    scheduled-mint.ts         # Time-based scheduled mint
  utils/
    opensea-resolver.ts       # OpenSea URL → contract address
    contract-analyzer.ts      # Auto-detect mint functions, price, WL type
    logger.ts                 # Colored terminal output + file logging
logs/                         # Transaction logs (auto-created)
```

---

## Logs

Every transaction is logged to `logs/mintbot-YYYY-MM-DD.log` automatically.
