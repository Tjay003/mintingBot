# MintBot — Future Roadmap & Feature Backlog

> **STATUS:** **BACKLOG / PROPOSED ONLY**
> ⚠️ **AGENT INSTRUCTION:** Do NOT implement any of these features until the user explicitly asks to start working on them. This file serves as persistent memory for future enhancements.

---

## 📋 High-Priority Feature Candidates

### 1. Auto-Transfer / Cold Vault Sweeper (from `osnm-z`)
- **Concept:** After burner wallets successfully mint NFTs, the bot automatically sweeps/transfers the newly minted NFTs to a designated master cold wallet (`RECIPIENT_ADDRESS`).
- **How It Works:**
  1. Inspect the mint transaction receipt `logs` on-chain to extract the exact `tokenId`s transferred from `0x0000000000000000000000000000000000000000` to the burner wallet.
  2. Burner wallet immediately dispatches `safeTransferFrom(burnerWallet, recipientAddress, tokenId)`.
  3. UI toggle: `[x] Auto-Transfer to Vault Address: 0x...`
- **Benefit:** Keeps all valuable NFTs in cold storage instantly, leaving burner wallets empty and safe from exposure.

---

### 2. Multicall3 1-Tx Batch Wallet Funder (from `osnm-z`)
- **Concept:** Fund all 5–10 bot burner wallets from a single master wallet in **one single transaction** using the canonical Multicall3 contract.
- **Multicall3 Address on EVM / Orbit:** `0xcA11bde05977b3631167028862bE2a173976CA11`
- **How It Works:**
  1. In the **Wallets** tab, click `Fund All Wallets`.
  2. Enter amount per wallet (e.g. `0.005 ETH`).
  3. Master wallet sends 1 Multicall3 transaction that splits and distributes ETH to all burner wallets atomically.
- **Benefit:** Saves massive time and gas compared to sending 5–10 individual funding transactions from MetaMask.

---

### 3. Upfront Gas Reservation Pre-Check (from `morsyxbt`)
- **Concept:** Pre-flight math check before firing or arming scheduled mints.
- **Formula:** `walletBalance >= (estimatedGasLimit * maxFeePerGas) + (mintPrice * quantity)`
- **Behavior:** If a wallet has enough for the mint price but is missing 0.0001 ETH for the maximum gas ceiling reservation, warn the user in the UI with the exact required top-up amount.

---

### 4. Discord & Telegram Webhook Notifications
- **Concept:** Send real-time notifications to a private Discord channel or Telegram bot when a mint completes.
- **Payload:**
  - Collection Name & Contract Address
  - Minted Quantity & Token IDs
  - Transaction Hash (with Robinhood Explorer link)
  - Execution Speed (e.g. `1.24s end-to-end`)

---

### 5. OpenSea Seaport Auto-Listing (Post-Mint)
- **Concept:** Option to automatically list the minted NFT on OpenSea / Seaport right after minting at a specified floor multiplier (e.g. `2x mint price`).

---

## 📝 Implementation Decision Log

| Date | Feature | Decision / Status |
|---|---|---|
| 2026-08-16 | Pre-Signed T-0 Byte Blast | ✅ **Implemented & Live** (Two-stage T-5s / T-0 engine) |
| 2026-08-16 | OpenSea SeaDrop Router Auto-Routing | ✅ **Implemented & Live** (`mintPublic` on `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`) |
| 2026-08-16 | On-Chain Auto Price Detection | ✅ **Implemented & Live** (`getPublicDrop` prober + UI auto-fill) |
| 2026-08-17 | Auto-Transfer to Cold Vault | ✅ **Implemented & Live** (`src/utils/nft-sweeper.ts`) |
| 2026-08-17 | Multicall3 Batch Wallet Funder | ✅ **Implemented & Live** (`src/wallets/funder.ts`) |
