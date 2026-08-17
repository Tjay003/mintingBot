/**
 * MintBot Extension Popup Script
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusPill = document.getElementById('status-pill')
  const targetInput = document.getElementById('target-input')
  const tabDetectBadge = document.getElementById('tab-detect-badge')
  const qtyInput = document.getElementById('qty-input')
  const gasSelect = document.getElementById('gas-select')
  const walletsCountText = document.getElementById('wallets-count-text')
  const ethPriceText = document.getElementById('eth-price-text')
  const walletsList = document.getElementById('wallets-list')
  const blastBtn = document.getElementById('blast-btn')
  const feedbackBox = document.getElementById('feedback-box')

  // 1. Auto-detect active OpenSea tab
  async function detectCurrentTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab && tab.url && tab.url.includes('opensea.io')) {
        targetInput.value = tab.url
        tabDetectBadge.innerText = '✓ DETECTED'
      } else {
        tabDetectBadge.innerText = 'DETECT TAB'
      }
    } catch {}
  }

  tabDetectBadge.addEventListener('click', detectCurrentTab)
  await detectCurrentTab()

  // 2. Fetch Core Status
  function refreshStatus() {
    chrome.runtime.sendMessage({ type: 'GET_CORE_STATUS' }, (res) => {
      if (res && res.success && res.data) {
        const d = res.data
        statusPill.className = 'status-pill status-online'
        statusPill.innerHTML = `<span>🟢 ${d.walletsCount} WALLETS</span>`
        walletsCountText.innerText = d.walletsCount
        ethPriceText.innerText = `ETH: $${d.ethPriceUsdt.toLocaleString()}`
        blastBtn.disabled = false

        if (d.wallets && d.wallets.length > 0) {
          walletsList.innerHTML = d.wallets
            .map(
              (w) => `
            <div class="wallet-item">
              <span class="wallet-name">${w.label}</span>
              <span class="wallet-bal">${w.balanceEth} ETH (${w.balanceUsdt})</span>
            </div>
          `,
            )
            .join('')
        } else {
          walletsList.innerHTML = `<div style="color: var(--text-muted); font-size: 11px; text-align: center; padding: 6px;">No wallets found in .env</div>`
        }
      } else {
        statusPill.className = 'status-pill status-offline'
        statusPill.innerHTML = `<span>🔴 CORE OFF</span>`
        walletsCountText.innerText = '0'
        blastBtn.disabled = true
        walletsList.innerHTML = `<div style="color: var(--red); font-size: 11px; text-align: center; padding: 8px;">MintBot is not running. Launch <code>npm run ui</code></div>`
      }
    })
  }

  refreshStatus()

  // 3. Handle Blast Mint
  blastBtn.addEventListener('click', () => {
    const target = targetInput.value.trim()
    const qty = parseInt(qtyInput.value, 10) || 1
    const gasStrategy = gasSelect.value

    if (!target) {
      alert('Please enter an OpenSea URL or contract address.')
      return
    }

    blastBtn.disabled = true
    blastBtn.innerHTML = '<span>⚡ BLASTING...</span>'
    feedbackBox.style.display = 'block'
    feedbackBox.style.background = '#1E293B'
    feedbackBox.style.color = '#38BDF8'
    feedbackBox.innerText = 'Submitting mint across all wallets...'

    const payload = {
      target,
      quantity: qty,
      priceEth: '0', // Auto-detects on-chain
      gasStrategy,
      mode: 'public',
    }

    chrome.runtime.sendMessage({ type: 'TRIGGER_MINT', payload }, (res) => {
      blastBtn.disabled = false
      blastBtn.innerHTML = '<span>⚡ BLAST ALL WALLETS</span>'

      if (res && res.success) {
        feedbackBox.style.background = 'rgba(16, 185, 129, 0.2)'
        feedbackBox.style.color = '#10B981'
        feedbackBox.innerText = '✓ Session Started! Check Dashboard (localhost:3000)'
      } else {
        feedbackBox.style.background = 'rgba(239, 68, 68, 0.2)'
        feedbackBox.style.color = '#EF4444'
        feedbackBox.innerText = `✗ Error: ${res?.error || 'Failed to dispatch'}`
      }
    })
  })
})
