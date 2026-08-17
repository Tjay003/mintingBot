/**
 * MintBot Chrome Extension — Complete Client Logic
 */

const API = 'http://localhost:3000/api'
let walletsData = []
let currentEthPriceUsdt = 1900
let pollSessionTimer = null
let analyzeDebounceTimer = null

document.addEventListener('DOMContentLoaded', () => {
  initTabs()
  initDetectButtons()
  initWalletsManager()
  initSnipeTab()
  initScheduleTab()
  initAnalyzerTab()
  initGasTracker()

  refreshCore()
  setInterval(refreshCore, 3000)
})

// ==========================================
// 1. TABS SYSTEM
// ==========================================
function initTabs() {
  const tabs = document.querySelectorAll('.nav-tab')
  const panes = document.querySelectorAll('.tab-pane')

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'))
      panes.forEach((p) => p.classList.remove('active'))

      tab.classList.add('active')
      const targetId = tab.getAttribute('data-tab')
      const targetPane = document.getElementById(targetId)
      if (targetPane) targetPane.classList.add('active')
    })
  })
}

// ==========================================
// 2. DETECT TAB BUTTONS
// ==========================================
function initDetectButtons() {
  async function getCurrentTabUrl() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab && tab.url) return tab.url
    } catch {}
    return ''
  }

  const detectBtns = [
    { btnId: 'detect-tab-btn', inputId: 'snipe-target' },
    { btnId: 'sched-detect-btn', inputId: 'sched-target', triggerSchedule: true },
    { btnId: 'analyze-detect-btn', inputId: 'analyze-input' },
  ]

  detectBtns.forEach(({ btnId, inputId, triggerSchedule }) => {
    const btn = document.getElementById(btnId)
    const input = document.getElementById(inputId)
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const url = await getCurrentTabUrl()
        if (url) {
          input.value = url
          if (triggerSchedule) autoDetectScheduleStages(url)
        }
      })
    }
  })
}

// ==========================================
// 3. CORE STATUS & WALLETS LOADER
// ==========================================
async function refreshCore() {
  try {
    const res = await fetch(`${API}/extension/status`)
    if (!res.ok) throw new Error('Offline')
    const data = await res.json()

    updateCoreStatus(true, data.walletsCount)
    walletsData = data.wallets || []
    currentEthPriceUsdt = data.ethPriceUsdt || currentEthPriceUsdt

    renderSnipeWallets()
    renderScheduleWallets()
    renderWalletsTab()
    checkActiveSession(data.activeSession)
  } catch (err) {
    updateCoreStatus(false, 0)
  }
}

function updateCoreStatus(isOnline, walletCount) {
  const pill = document.getElementById('status-pill')
  const footerStatus = document.getElementById('core-text-status')
  if (pill) {
    if (isOnline) {
      pill.className = 'status-pill status-online'
      pill.innerHTML = `<span>🟢 ${walletCount} WALLETS</span>`
      if (footerStatus) footerStatus.innerText = 'Connected (Port 3000)'
    } else {
      pill.className = 'status-pill status-offline'
      pill.innerHTML = `<span>🔴 CORE OFF</span>`
      if (footerStatus) footerStatus.innerText = 'Offline (Run npm run ui)'
    }
  }
}

// ==========================================
// 4. SNIPE / ACTIVE SESSION TAB
// ==========================================
function initSnipeTab() {
  const startBtn = document.getElementById('snipe-start-btn')
  const stopBtn = document.getElementById('snipe-stop-btn')
  const toggleWallets = document.getElementById('snipe-toggle-wallets')
  const targetInput = document.getElementById('snipe-target')

  if (toggleWallets) {
    toggleWallets.addEventListener('click', () => {
      const cbs = document.querySelectorAll('.snipe-wallet-cb')
      const allChecked = Array.from(cbs).every((cb) => cb.checked)
      cbs.forEach((cb) => (cb.checked = !allChecked))
    })
  }

  if (targetInput) {
    targetInput.addEventListener('input', () => {
      clearTimeout(analyzeDebounceTimer)
      const target = targetInput.value.trim()
      if (target.length < 10) return
      analyzeDebounceTimer = setTimeout(async () => {
        try {
          const res = await fetch(`${API}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target }),
          })
          const data = await res.json()
          if (data?.analysis?.mintPriceEth) {
            const priceInput = document.getElementById('snipe-price')
            const priceBadge = document.getElementById('snipe-price-badge')
            if (priceInput) priceInput.value = data.analysis.mintPriceEth
            if (priceBadge) priceBadge.innerText = `✓ ${data.analysis.mintPriceEth} ETH`
          }
        } catch {}
      }, 600)
    })
  }

  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      const target = document.getElementById('snipe-target')?.value.trim()
      const mode = document.getElementById('snipe-mode')?.value
      const gasStrategy = document.getElementById('snipe-gas')?.value
      const quantity = parseInt(document.getElementById('snipe-qty')?.value || '1', 10)
      const priceEth = document.getElementById('snipe-price')?.value || '0'

      const selectedWallets = Array.from(
        document.querySelectorAll('.snipe-wallet-cb:checked'),
      ).map((cb) => parseInt(cb.getAttribute('data-idx'), 10))

      if (!target) {
        alert('Please provide an OpenSea URL or 0x contract address.')
        return
      }

      startBtn.disabled = true
      startBtn.innerHTML = '<span>⚡ FIRING...</span>'

      try {
        const res = await fetch(`${API}/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target,
            mode,
            gasStrategy,
            quantity,
            priceEth,
            selectedWallets: selectedWallets.length > 0 ? selectedWallets : undefined,
          }),
        })
        const json = await res.json()
        if (!res.ok) alert(json.error)
        else pollSession()
      } catch (err: any) {
        alert(err.message)
      } finally {
        startBtn.disabled = false
        startBtn.innerHTML = '<span>⚡ BLAST MINT SESSION</span>'
      }
    })
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
      try {
        await fetch(`${API}/session/stop`, { method: 'POST' })
        pollSession()
      } catch {}
    })
  }
}

function renderSnipeWallets() {
  const container = document.getElementById('snipe-wallets-list')
  if (!container) return

  if (walletsData.length === 0) {
    container.innerHTML = `<div style="font-size: 11px; color: var(--text-muted); text-align: center; padding: 6px;">No wallets found in .env</div>`
    return
  }

  const existingChecked = new Set(
    Array.from(document.querySelectorAll('.snipe-wallet-cb:checked')).map((cb) =>
      cb.getAttribute('data-idx'),
    ),
  )

  container.innerHTML = walletsData
    .map((w) => {
      const isChecked = existingChecked.size === 0 || existingChecked.has(String(w.index))
      return `
      <label style="display: flex; align-items: center; justify-content: space-between; padding: 4px 6px; font-size: 11px; cursor: pointer; border-radius: 4px; margin-bottom: 2px;" onmouseover="this.style.background='#FFFFFF'" onmouseout="this.style.background='transparent'">
        <div style="display: flex; align-items: center; gap: 6px;">
          <input type="checkbox" class="snipe-wallet-cb" data-idx="${w.index}" ${isChecked ? 'checked' : ''} />
          <strong>${w.label}</strong>
          <span style="font-family: var(--font-mono); color: var(--text-muted); font-size: 10px;">${w.address.slice(0, 6)}...${w.address.slice(-4)}</span>
        </div>
        <span style="font-family: var(--font-mono); font-weight: 700; color: var(--accent-dark);">${w.balanceEth} ETH</span>
      </label>
    `
    })
    .join('')
}

function checkActiveSession(session) {
  const card = document.getElementById('snipe-session-card')
  const info = document.getElementById('snipe-session-info')
  const stopBtn = document.getElementById('snipe-stop-btn')

  if (session && session.status === 'running') {
    if (card) card.style.display = 'block'
    if (stopBtn) stopBtn.style.display = 'inline-flex'
    if (info) info.innerHTML = `Running <strong>${session.mode}</strong> on <code>${session.target.slice(0, 30)}...</code>`
    if (!pollSessionTimer) pollSessionTimer = setInterval(pollSession, 1000)
  } else {
    if (stopBtn) stopBtn.style.display = 'none'
    if (pollSessionTimer) {
      clearInterval(pollSessionTimer)
      pollSessionTimer = null
    }
  }
}

async function pollSession() {
  try {
    const res = await fetch(`${API}/session`)
    const data = await res.json()
    const card = document.getElementById('snipe-session-card')
    const info = document.getElementById('snipe-session-info')
    const logBox = document.getElementById('snipe-log-box')

    if (data.status === 'running') {
      if (card) card.style.display = 'block'
      if (info) info.innerHTML = `Status: <span class="badge badge-green">RUNNING</span> | Target: <code>${data.target}</code>`
    } else if (data.status === 'success') {
      if (info) info.innerHTML = `Status: <span class="badge badge-green">COMPLETED ✓</span>`
    } else if (data.status === 'error') {
      if (info) info.innerHTML = `Status: <span class="badge badge-red">FAILED: ${data.error}</span>`
    }
  } catch {}
}

// ==========================================
// 5. SCHEDULE TAB
// ==========================================
function initScheduleTab() {
  const targetInput = document.getElementById('sched-target')
  const toggleWallets = document.getElementById('sched-toggle-wallets')
  const qtyInput = document.getElementById('sched-qty')
  const priceInput = document.getElementById('sched-price')
  const submitBtn = document.getElementById('sched-submit-btn')

  if (targetInput) {
    targetInput.addEventListener('input', () => {
      autoDetectScheduleStages(targetInput.value.trim())
    })
  }

  if (toggleWallets) {
    toggleWallets.addEventListener('click', () => {
      const cbs = document.querySelectorAll('.sched-wallet-cb')
      const allChecked = Array.from(cbs).every((cb) => cb.checked)
      cbs.forEach((cb) => (cb.checked = !allChecked))
      updateScheduleSummary()
    })
  }

  if (qtyInput) qtyInput.addEventListener('input', updateScheduleSummary)
  if (priceInput) priceInput.addEventListener('input', updateScheduleSummary)

  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const target = document.getElementById('sched-target')?.value.trim()
      const mintTime = document.getElementById('sched-time')?.value
      const quantity = parseInt(document.getElementById('sched-qty')?.value || '1', 10)
      const priceEth = document.getElementById('sched-price')?.value || '0'
      const gasStrategy = document.getElementById('sched-gas')?.value

      const selectedWallets = Array.from(
        document.querySelectorAll('.sched-wallet-cb:checked'),
      ).map((cb) => parseInt(cb.getAttribute('data-idx'), 10))

      if (!target || !mintTime) {
        alert('Target and Scheduled Mint Date/Time are required.')
        return
      }

      submitBtn.disabled = true
      submitBtn.innerHTML = '<span>Arming Schedule...</span>'

      try {
        const res = await fetch(`${API}/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'scheduled',
            target,
            mintTime,
            quantity,
            priceEth,
            gasStrategy,
            selectedWallets: selectedWallets.length > 0 ? selectedWallets : undefined,
          }),
        })
        const json = await res.json()
        if (!res.ok) alert(json.error)
        else {
          alert('✓ Scheduled Mint Armed! The bot will execute T-0 pre-signed blast at drop time.')
          // Switch to Snipe tab to see status
          document.querySelector('[data-tab="tab-snipe"]')?.click()
        }
      } catch (err: any) {
        alert(err.message)
      } finally {
        submitBtn.disabled = false
        submitBtn.innerHTML = '<span>⏱️ ARM SCHEDULED MINT (T-0 BLAST)</span>'
      }
    })
  }
}

async function autoDetectScheduleStages(target) {
  if (!target || target.length < 10) {
    const box = document.getElementById('sched-stages-box')
    if (box) box.style.display = 'none'
    return
  }

  clearTimeout(analyzeDebounceTimer)
  analyzeDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`${API}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      })
      const data = await res.json()
      if (data?.analysis) {
        const price = data.analysis.mintPriceEth || '0'
        const priceInput = document.getElementById('sched-price')
        if (priceInput) priceInput.value = price

        const stagesBox = document.getElementById('sched-stages-box')
        const stagesList = document.getElementById('sched-stages-list')
        const stages = data.analysis.dropStages || []

        if (stages.length > 0 && stagesBox && stagesList) {
          stagesBox.style.display = 'block'
          stagesList.innerHTML = stages
            .map(
              (s, i) => `
            <div class="sched-stage-btn" data-idx="${i}" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; background: #FFFFFF; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 11px;">
              <div>
                <strong>${s.label}</strong>
                <div style="font-size: 9px; color: var(--text-muted);">${s.startTimeLocal} · Max: ${s.maxTotalMintableByWallet}</div>
              </div>
              <div style="text-align: right;">
                <span style="font-weight: 700; color: var(--accent-dark);">${s.priceEth} ETH</span>
                <div>${s.isLive ? '<span class="badge badge-green" style="font-size: 8px;">LIVE</span>' : '<span class="badge badge-amber" style="font-size: 8px;">UPCOMING</span>'}</div>
              </div>
            </div>
          `,
            )
            .join('')

          stagesList.querySelectorAll('.sched-stage-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              const idx = parseInt(btn.getAttribute('data-idx'), 10)
              const s = stages[idx]
              if (s) {
                const date = new Date(s.startTime)
                const localIso = new Date(
                  date.getTime() - date.getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 16)

                const timeInput = document.getElementById('sched-time')
                const qtyInput = document.getElementById('sched-qty')
                const pInput = document.getElementById('sched-price')

                if (timeInput) timeInput.value = localIso
                if (qtyInput && s.maxTotalMintableByWallet) qtyInput.value = s.maxTotalMintableByWallet
                if (pInput) pInput.value = s.priceEth
                updateScheduleSummary()
              }
            })
          })
        }
        updateScheduleSummary()
      }
    } catch {}
  }, 600)
}

function renderScheduleWallets() {
  const container = document.getElementById('sched-wallets-list')
  if (!container) return

  if (walletsData.length === 0) {
    container.innerHTML = `<div style="font-size: 11px; color: var(--text-muted); text-align: center; padding: 6px;">No wallets found</div>`
    return
  }

  const existingChecked = new Set(
    Array.from(document.querySelectorAll('.sched-wallet-cb:checked')).map((cb) =>
      cb.getAttribute('data-idx'),
    ),
  )

  container.innerHTML = walletsData
    .map((w) => {
      const isChecked = existingChecked.size === 0 || existingChecked.has(String(w.index))
      return `
      <label style="display: flex; align-items: center; justify-content: space-between; padding: 4px 6px; font-size: 11px; cursor: pointer; border-radius: 4px; margin-bottom: 2px;" onmouseover="this.style.background='#FFFFFF'" onmouseout="this.style.background='transparent'">
        <div style="display: flex; align-items: center; gap: 6px;">
          <input type="checkbox" class="sched-wallet-cb" data-idx="${w.index}" ${isChecked ? 'checked' : ''} onchange="updateScheduleSummary()" />
          <strong>${w.label}</strong>
        </div>
        <span style="font-family: var(--font-mono); font-weight: 700; color: var(--accent-dark);">${w.balanceEth} ETH</span>
      </label>
    `
    })
    .join('')

  updateScheduleSummary()
}

function updateScheduleSummary() {
  const checked = document.querySelectorAll('.sched-wallet-cb:checked').length
  const qty = parseInt(document.getElementById('sched-qty')?.value || '1', 10) || 1
  const price = parseFloat(document.getElementById('sched-price')?.value || '0') || 0
  const totalNfts = checked * qty
  const totalEth = totalNfts * price

  const wEl = document.getElementById('sched-sum-wallets')
  const nEl = document.getElementById('sched-sum-nfts')
  const cEl = document.getElementById('sched-sum-cost')

  if (wEl) wEl.innerText = checked
  if (nEl) nEl.innerText = `${totalNfts} (${checked} × ${qty})`
  if (cEl) cEl.innerText = `${totalEth.toFixed(4)} ETH`
}

// ==========================================
// 6. WALLETS TAB
// ==========================================
function initWalletsManager() {
  const addBtn = document.getElementById('add-wallet-btn')
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const label = document.getElementById('add-wallet-label')?.value.trim()
      const privateKey = document.getElementById('add-wallet-pk')?.value.trim()

      if (!privateKey) {
        alert('Private Key is required.')
        return
      }

      addBtn.disabled = true
      try {
        const res = await fetch(`${API}/wallets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ privateKey, label: label || undefined }),
        })
        const json = await res.json()
        if (!res.ok) alert(json.error)
        else {
          document.getElementById('add-wallet-label').value = ''
          document.getElementById('add-wallet-pk').value = ''
          refreshCore()
        }
      } catch (err: any) {
        alert(err.message)
      } finally {
        addBtn.disabled = false
      }
    })
  }
}

function renderWalletsTab() {
  const list = document.getElementById('wallets-tab-list')
  const count = document.getElementById('wallets-tab-count')
  const ethPrice = document.getElementById('wallets-eth-price')

  if (count) count.innerText = walletsData.length
  if (ethPrice) ethPrice.innerText = `ETH: $${currentEthPriceUsdt.toLocaleString()}`
  if (!list) return

  if (walletsData.length === 0) {
    list.innerHTML = `<div style="font-size: 11px; color: var(--text-muted); text-align: center; padding: 10px;">No wallets in vault. Add one above.</div>`
    return
  }

  list.innerHTML = walletsData
    .map(
      (w) => `
    <div class="wallet-row">
      <div>
        <div class="wallet-label">
          <span>${w.label}</span>
          <button class="btn btn-outline btn-sm rename-btn" data-idx="${w.index}" style="padding: 1px 4px; font-size: 9px;">✏️</button>
        </div>
        <div class="wallet-address">${w.address.slice(0, 10)}...${w.address.slice(-6)}</div>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <div class="wallet-balance">
          <div>${w.balanceEth} ETH</div>
          <div style="font-size: 10px; color: var(--text-muted);">${w.balanceUsdt}</div>
        </div>
        <button class="btn btn-danger btn-sm del-btn" data-idx="${w.index}" style="padding: 4px 6px;">✕</button>
      </div>
    </div>
  `,
    )
    .join('')

  // Bind delete buttons
  list.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = btn.getAttribute('data-idx')
      if (confirm(`Remove Wallet ${idx} from vault?`)) {
        await fetch(`${API}/wallets/${idx}`, { method: 'DELETE' })
        refreshCore()
      }
    })
  })

  // Bind rename buttons
  list.querySelectorAll('.rename-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = btn.getAttribute('data-idx')
      const newName = prompt(`Enter new label for Wallet ${idx}:`)
      if (newName !== null) {
        await fetch(`${API}/wallets/${idx}/label`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newName.trim() }),
        })
        refreshCore()
      }
    })
  })
}

// ==========================================
// 7. ANALYZER TAB
// ==========================================
function initAnalyzerTab() {
  const btn = document.getElementById('analyze-btn')
  const input = document.getElementById('analyze-input')
  const resCard = document.getElementById('analyze-result-card')
  const details = document.getElementById('analyze-details')

  if (btn && input) {
    btn.addEventListener('click', async () => {
      const target = input.value.trim()
      if (!target) return

      btn.disabled = true
      btn.innerText = 'Probing...'

      try {
        const res = await fetch(`${API}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target }),
        })
        const data = await res.json()
        if (!res.ok) alert(data.error)
        else if (data?.analysis) {
          const a = data.analysis
          if (resCard) resCard.style.display = 'block'

          let stagesHtml = ''
          if (a.dropStages && a.dropStages.length > 0) {
            stagesHtml = `
              <div style="margin-top: 8px; padding: 8px; background: #F8FAFC; border: 1px solid var(--border); border-radius: 6px;">
                <strong>Detected OpenSea Stages (${a.dropStages.length}):</strong>
                ${a.dropStages
                  .map(
                    (s) => `
                  <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dashed var(--border); font-size: 11px;">
                    <div>${s.label} (${s.stageType})</div>
                    <strong>${s.priceEth} ETH</strong>
                  </div>
                `,
                  )
                  .join('')}
              </div>
            `
          }

          if (details) {
            details.innerHTML = `
              <p><strong>Contract:</strong> <code>${a.contractAddress.slice(0, 16)}...</code></p>
              <p><strong>Type:</strong> ${a.isSeaDrop ? 'OpenSea SeaDrop' : 'Standard ERC-721'}</p>
              <p><strong>Verified:</strong> ${a.isVerified ? '✓ Yes' : '✗ No'}</p>
              <p><strong>Price:</strong> ${a.mintPriceEth ? a.mintPriceEth + ' ETH' : 'Auto'}</p>
              <p><strong>Limit:</strong> ${a.maxPerWallet || 'Check stage'}</p>
              ${stagesHtml}
            `
          }
        }
      } catch (err: any) {
        alert(err.message)
      } finally {
        btn.disabled = false
        btn.innerText = 'Analyze'
      }
    })
  }
}

// ==========================================
// 8. GAS TRACKER
// ==========================================
async function initGasTracker() {
  try {
    const res = await fetch(`${API}/gas/current`)
    if (res.ok) {
      const data = await res.json()
      if (data.rates) {
        const safe = document.getElementById('gas-safe-val')
        const fast = document.getElementById('gas-fast-val')
        const turbo = document.getElementById('gas-turbo-val')

        if (safe) safe.innerText = `${data.rates.safe.maxFeeGwei} Gwei`
        if (fast) fast.innerText = `${data.rates.fast.maxFeeGwei} Gwei`
        if (turbo) turbo.innerText = `${data.rates.turbo.maxFeeGwei} Gwei`
      }
    }
  } catch {}
}
