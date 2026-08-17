/**
 * MintBot Content Script — OpenSea Injected HUD & Fast Snipe Overlay
 */

;(function () {
  let hudContainer = null
  let coreData = null
  let analysisData = null
  let selectedStage = null
  let isCollapsed = false

  function init() {
    if (!window.location.hostname.includes('opensea.io')) return
    if (!window.location.pathname.includes('/collection/')) return

    injectHud()
    refreshCoreStatus()
    analyzeCurrentPage()

    // Re-check periodically & on URL changes
    let lastUrl = location.href
    new MutationObserver(() => {
      const url = location.href
      if (url !== lastUrl) {
        lastUrl = url
        setTimeout(analyzeCurrentPage, 1000)
      }
    }).observe(document, { subtree: true, childList: true })
  }

  function injectHud() {
    if (document.getElementById('mintbot-injected-hud')) return

    hudContainer = document.createElement('div')
    hudContainer.id = 'mintbot-injected-hud'
    hudContainer.innerHTML = `
      <div class="mintbot-hud-header" id="mintbot-header">
        <div class="mintbot-brand">
          <img src="${chrome.runtime.getURL('icons/icon48.png')}" class="mintbot-brand-icon" alt="MintBot" />
          <span>MINTBOT SNIPER</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div id="mintbot-status-pill" class="mintbot-status-pill mintbot-status-offline">
            <span>CORE: OFF</span>
          </div>
          <span id="mintbot-toggle-btn" style="color: #94A3B8; font-size: 14px; font-weight: bold;">−</span>
        </div>
      </div>

      <div class="mintbot-hud-body" id="mintbot-body">
        <!-- Collection Info -->
        <div class="mintbot-card">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span class="mintbot-label">Target Collection</span>
            <span id="mintbot-network-tag" class="mintbot-stage-badge">Robinhood Chain</span>
          </div>
          <div id="mintbot-collection-name" style="font-weight: 700; font-size: 14px; margin-top: 4px; color: #F8FAFC;">
            Detecting...
          </div>
        </div>

        <!-- Detected Stages -->
        <div id="mintbot-stages-section" class="mintbot-card" style="display: none;">
          <span class="mintbot-label">Drop Stages (Click to Select)</span>
          <div id="mintbot-stages-list"></div>
        </div>

        <!-- Parameters & Wallets -->
        <div class="mintbot-row">
          <div style="flex: 1;">
            <span class="mintbot-label">Qty / Wallet</span>
            <input type="number" id="mintbot-qty-input" class="mintbot-input" value="1" min="1" />
          </div>
          <div style="flex: 1.2;">
            <span class="mintbot-label">Gas Strategy</span>
            <select id="mintbot-gas-select" class="mintbot-select">
              <option value="turbo" selected>Turbo (2.5x)</option>
              <option value="fast">Fast (1.5x)</option>
              <option value="safe">Safe (1.0x)</option>
            </select>
          </div>
        </div>

        <!-- Wallets Status Summary -->
        <div style="display: flex; justify-content: space-between; font-size: 12px; color: #94A3B8; padding: 2px 4px;">
          <span>Active Wallets: <strong id="mintbot-wallets-count" style="color: #10B981;">0</strong></span>
          <span id="mintbot-price-display">Price: Auto</span>
        </div>

        <!-- Blast Button -->
        <button id="mintbot-blast-btn" class="mintbot-btn-blast">
          <span>⚡ BLAST ALL WALLETS</span>
        </button>

        <div id="mintbot-feedback" style="display: none; font-size: 12px; padding: 8px; border-radius: 6px; text-align: center;"></div>
      </div>
    `

    document.body.appendChild(hudContainer)

    // Setup event listeners
    document.getElementById('mintbot-header').addEventListener('click', toggleCollapse)
    document.getElementById('mintbot-blast-btn').addEventListener('click', handleBlastMint)
  }

  function toggleCollapse() {
    isCollapsed = !isCollapsed
    const body = document.getElementById('mintbot-body')
    const toggleBtn = document.getElementById('mintbot-toggle-btn')
    if (isCollapsed) {
      body.style.display = 'none'
      toggleBtn.innerText = '+'
    } else {
      body.style.display = 'flex'
      toggleBtn.innerText = '−'
    }
  }

  function refreshCoreStatus() {
    chrome.runtime.sendMessage({ type: 'GET_CORE_STATUS' }, (res) => {
      const statusPill = document.getElementById('mintbot-status-pill')
      const walletsCountEl = document.getElementById('mintbot-wallets-count')
      const blastBtn = document.getElementById('mintbot-blast-btn')

      if (res && res.success && res.data) {
        coreData = res.data
        if (statusPill) {
          statusPill.className = 'mintbot-status-pill mintbot-status-online'
          statusPill.innerHTML = `<span>🟢 ${res.data.walletsCount} WALLETS</span>`
        }
        if (walletsCountEl) walletsCountEl.innerText = `${res.data.walletsCount} Wallets Ready`
        if (blastBtn) blastBtn.disabled = false
      } else {
        coreData = null
        if (statusPill) {
          statusPill.className = 'mintbot-status-pill mintbot-status-offline'
          statusPill.innerHTML = `<span>🔴 CORE OFF</span>`
        }
        if (walletsCountEl) walletsCountEl.innerText = `0 (Launch UI)`
      }
    })
  }

  function analyzeCurrentPage() {
    const colNameEl = document.getElementById('mintbot-collection-name')
    if (colNameEl) colNameEl.innerText = 'Analyzing OpenSea Drop...'

    chrome.runtime.sendMessage(
      { type: 'ANALYZE_TARGET', target: window.location.href },
      (res) => {
        if (!res || !res.success || !res.data) return

        analysisData = res.data
        const a = res.data.analysis
        const resolved = res.data.resolved

        if (colNameEl) {
          colNameEl.innerText = resolved.collectionName || a.contractAddress
        }

        const stagesSection = document.getElementById('mintbot-stages-section')
        const stagesList = document.getElementById('mintbot-stages-list')
        const stages = a.dropStages || []

        if (stages.length > 0 && stagesSection && stagesList) {
          stagesSection.style.display = 'block'
          stagesList.innerHTML = stages
            .map(
              (s, idx) => `
            <div class="mintbot-stage-item ${s.isLive ? 'active' : ''}" data-idx="${idx}">
              <div>
                <div style="font-weight: 700; font-size: 12px; color: #F8FAFC;">${s.label}</div>
                <div style="font-size: 10px; color: #94A3B8;">${s.startTimeLocal} · Max: ${s.maxTotalMintableByWallet}</div>
              </div>
              <div style="text-align: right;">
                <div style="font-weight: 800; font-size: 12px; color: #10B981;">${s.priceEth} ETH</div>
                <div>${s.isLive ? '<span class="mintbot-stage-badge">LIVE</span>' : '<span style="font-size: 9px; color: #F59E0B;">UPCOMING</span>'}</div>
              </div>
            </div>
          `,
            )
            .join('')

          // Bind stage selection clicks
          stagesList.querySelectorAll('.mintbot-stage-item').forEach((el) => {
            el.addEventListener('click', () => {
              const idx = parseInt(el.getAttribute('data-idx'), 10)
              const stage = stages[idx]
              selectedStage = stage
              stagesList.querySelectorAll('.mintbot-stage-item').forEach((i) => i.classList.remove('active'))
              el.classList.add('active')

              const qtyInput = document.getElementById('mintbot-qty-input')
              const priceDisplay = document.getElementById('mintbot-price-display')
              if (qtyInput && stage.maxTotalMintableByWallet) qtyInput.value = stage.maxTotalMintableByWallet
              if (priceDisplay) priceDisplay.innerText = `Price: ${stage.priceEth} ETH`
            })
          })
        }
      },
    )
  }

  function handleBlastMint() {
    const blastBtn = document.getElementById('mintbot-blast-btn')
    const feedback = document.getElementById('mintbot-feedback')
    const qty = parseInt(document.getElementById('mintbot-qty-input')?.value || '1', 10)
    const gasStrategy = document.getElementById('mintbot-gas-select')?.value || 'turbo'

    if (!coreData || !coreData.walletsCount) {
      alert('MintBot Local Core is not running. Please start it with: npm run ui')
      return
    }

    blastBtn.disabled = true
    blastBtn.innerHTML = '<span>⚡ FIRING WALLETS...</span>'
    if (feedback) {
      feedback.style.display = 'block'
      feedback.style.background = '#1E293B'
      feedback.style.color = '#38BDF8'
      feedback.innerText = 'Blasting transaction across all wallets...'
    }

    const payload = {
      target: window.location.href,
      quantity: qty,
      priceEth: selectedStage ? selectedStage.priceEth : '0',
      gasStrategy,
      mode: selectedStage && selectedStage.stageType === 'SIGNED_PRESALE' ? 'whitelist' : 'public',
    }

    chrome.runtime.sendMessage({ type: 'TRIGGER_MINT', payload }, (res) => {
      blastBtn.disabled = false
      blastBtn.innerHTML = '<span>⚡ BLAST ALL WALLETS</span>'

      if (res && res.success) {
        if (feedback) {
          feedback.style.background = 'rgba(16, 185, 129, 0.2)'
          feedback.style.color = '#10B981'
          feedback.innerText = `✓ Session Started! Check MintBot Dashboard.`
        }
      } else {
        if (feedback) {
          feedback.style.background = 'rgba(239, 68, 68, 0.2)'
          feedback.style.color = '#EF4444'
          feedback.innerText = `✗ Error: ${res?.error || 'Failed to dispatch'}`
        }
      }
    })
  }

  // Hotkey trigger
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TRIGGER_HOTKEY_SNIPE') {
      handleBlastMint()
    }
  })

  // Start after DOM load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
