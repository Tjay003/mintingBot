let cachedEthPriceUsdt = 2700
let lastFetchTime = 0

/**
 * Fetch live ETH/USDT price from public API with 60s caching.
 * Falls back to $2,700 if network fails.
 */
export async function getEthUsdtPrice(): Promise<number> {
  const now = Date.now()
  if (now - lastFetchTime < 60_000) {
    return cachedEthPriceUsdt
  }

  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT')
    const data = await res.json() as { price?: string }
    if (data.price) {
      cachedEthPriceUsdt = parseFloat(data.price)
      lastFetchTime = now
      return cachedEthPriceUsdt
    }
  } catch {
    // Fallback to CoinGecko
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
      const data = await res.json() as { ethereum?: { usd?: number } }
      if (data.ethereum?.usd) {
        cachedEthPriceUsdt = data.ethereum.usd
        lastFetchTime = now
        return cachedEthPriceUsdt
      }
    } catch {
      // Keep cached / fallback price
    }
  }
  return cachedEthPriceUsdt
}

/**
 * Calculate USD cost for a given Gwei gas price (assuming 150,000 gas limit standard NFT mint)
 */
export function calcGasCostUsdt(gwei: number, ethPrice: number, gasLimit = 150000): string {
  const ethCost = (gwei * 1e-9) * gasLimit
  const usdCost = ethCost * ethPrice
  if (usdCost < 0.01) return `<$0.01`
  return `$${usdCost.toFixed(3)}`
}

/**
 * Calculate USD cost for a given ETH amount
 */
export function calcEthToUsdt(eth: number, ethPrice: number): string {
  const usd = eth * ethPrice
  return `$${usd.toFixed(2)} USDT`
}
