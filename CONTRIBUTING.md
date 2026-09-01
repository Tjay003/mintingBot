# Contributing to MintBot

Thank you for your interest in contributing to MintBot! MintBot is an open-source, high-performance NFT minting and sniping suite for Robinhood Chain (Arbitrum Orbit L2).

## Getting Started

1. **Fork and clone the repository:**
   `ash
   git clone https://github.com/<your-username>/mintingBot.git
   cd mintingBot
   `

2. **Install dependencies:**
   `ash
   npm install
   `

3. **Set up local environment:**
   `ash
   cp .env.example .env
   `
   > ?? **IMPORTANT:** Never commit real private keys, API keys, or .env files to git.

## Development Workflow

- **Typecheck code:**
  `ash
  npm run typecheck
  `

- **Build distribution bundle:**
  `ash
  npm run build
  `

- **Run Web Dashboard locally:**
  `ash
  npm run ui
  `

- **Run CLI commands locally:**
  `ash
  npx tsx src/index.ts --help
  `

## Code Guidelines

- **TypeScript Strictness:** Ensure all types are explicitly declared and pass 	sc --noEmit with zero errors.
- **BigInt Serialization:** Remember that standard JSON / Express cannot serialize raw JavaScript BigInt. Always convert to .toString() or format before returning via HTTP endpoints.
- **Performance:** Keep pre-flight and dispatch paths asynchronous and parallelized. Never block the execution loop during mint triggers.
- **Security:** Do not log private keys, seeds, or unredacted secrets in terminal or log outputs.

## Submitting Pull Requests

1. Create a feature branch:
   `ash
   git checkout -b feat/your-feature-name
   `
2. Commit your changes with clear, descriptive commit messages.
3. Ensure 
pm run typecheck and 
pm run build succeed cleanly.
4. Push your branch and open a Pull Request against main.
