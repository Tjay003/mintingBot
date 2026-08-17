/**
 * MintBot Chrome Extension — Complete Client Logic & Debug Console
 */

const API = 'http://localhost:3000/api'
let walletsData = []
let currentEthPriceUsdt = 1900
let defaultRecipientAddress = ''
let pollSessionTimer = null
let analyzeDebounceTimer = null

// Console & Telemetry state
const consoleLogs = []
let activeLogFilter = 'all'
let wsConnection = null
let unreadErrorCount = 0

document.addEventListener('DOMContentLoaded', () => {
  initGlobalErrorHandling()
  initTabs()
  initDetectButtons()
  initConsoleTab()
  initWalletsManager()
  initSnipeTab()
  initScheduleTab()
  initAnalyzerTab()
  initGasTracker()

  initWebSocket()
  fetchRecentLogs()

  refreshCore()
  setInterval(refreshCore, 3000)
})

// ==========================================
// 1. GLOBAL ERROR HANDLING & BANNER
// ==========================================
function initGlobalErrorHandling() {
  window.addEventListener('error', (event) => {
    appendConsoleLog('error', `UI Exception: ${event.message} at ${event.filename}:${event.lineno}`)
    showGlobalError(event.message)
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason ? (event.reason.message || String(event.reason)) : 'Unhandled Promise Rejection'
    appendConsoleLog('error', `Promise Rejection: ${reason}`)
    showGlobalError(reason)
  })

  const dismissBtn = document.getElementById('dismiss-error-btn')
  const inspectBtn = document.getElementById('view-error-console-btn')

  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      const banner = document.getElementById('global-error-banner')
      if (banner) banner.style.display = 'none'
    })
  }

  if (inspectBtn) {
    inspectBtn.addEventListener('click', () => {
      const banner = document.getElementById('global-error-banner')
      if (banner) banner.style.display = 'none'
      switchToTab('tab-console')
      setLogFilter('error')
    })
  }

  const openConsoleLink = document.getElementById('snipe-open-console-link')
  if (openConsoleLink) {
    openConsoleLink.addEventListener('click', () => {
      switchToTab('tab-console')
    })
  }
}

function showGlobalError(message) {
  const banner = document.getElementById('global-error-banner')
  const textEl = document.getElementById('global-error-msg')
  if (banner && textEl) {
    textEl.innerText = message
    banner.style.display = 'flex'
  }
}

// ==========================================
// 2. TABS SYSTEM
// ==========================================
function initTabs() {
  const tabs = document.querySelectorAll('.nav-tab')

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetId = tab.getAttribute('data-tab')
      switchToTab(targetId)
    })
  })
}

function switchToTab(targetId) {
  const tabs = document.querySelectorAll('.nav-tab')
  const panes = document.querySelectorAll('.tab-pane')

  tabs.forEach((t) => {
    if (t.getAttribute('data-tab') === targetId) t.classList.add('active')
    else t.classList.remove('active')
  })

  panes.forEach((p) => {
    if (p.id === targetId) p.classList.add('active')
    else p.classList.remove('active')
  })

  // Clear unread error badge if user views Console tab
  if (targetId === 'tab-console') {
    unreadErrorCount = 0
    updateErrorBadge()
  }
}

// ==========================================
// 3. CONSOLE & DEBUG TERMINAL
// ==========================================
function initConsoleTab() {
  // Filter buttons
  const filterBtns = document.querySelectorAll('.log-filter-btn')
  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterBtns.forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      const filter = btn.getAttribute('data-filter')
      setLogFilter(filter)
    })
  })

  // Copy Logs button
  const copyBtn = document.getElementById('copy-logs-btn')
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const text = consoleLogs
        .map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`)
        .join('\n')
      navigator.clipboard.writeText(text).then(() => {
        const orig = copyBtn.innerText
        copyBtn.innerText = '✓ Copied'
        setTimeout(() => (copyBtn.innerText = orig), 1500)
      })
    })
  }

  // Clear Logs button
  const clearBtn = document.getElementById('clear-logs-btn')
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      consoleLogs.length = 0
      unreadErrorCount = 0
      updateErrorBadge()
      renderTerminalLogs()
      try {
        await fetch(`${API}/logs`, { method: 'DELETE' })
      } catch {}
    })
  }
}

function setLogFilter(filter) {
  activeLogFilter = filter
  document.querySelectorAll('.log-filter-btn').forEach((b) => {
    if (b.getAttribute('data-filter') === filter) b.classList.add('active')
    else b.classList.remove('active')
  })
  renderTerminalLogs()
}

function initWebSocket() {
  const wsPill = document.getElementById('ws-pill')
  try {
    wsConnection = new WebSocket('ws://localhost:3000')

    wsConnection.onopen = () => {
      if (wsPill) {
        wsPill.className = 'badge badge-green'
        wsPill.innerText = 'WS: LIVE'
      }
      appendConsoleLog('info', 'WebSocket stream connected to MintBot Core.')
    }

    wsConnection.onclose = () => {
      if (wsPill) {
        wsPill.className = 'badge badge-red'
        wsPill.innerText = 'WS: DISCONNECTED'
      }
      // Retry in 3 seconds
      setTimeout(initWebSocket, 3000)
    }

    wsConnection.onerror = () => {
      if (wsPill) {
        wsPill.className = 'badge badge-red'
        wsPill.innerText = 'WS: ERROR'
      }
    }

    wsConnection.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'log') {
          appendConsoleLog(data.level, data.message, data.timestamp)
        } else if (data.type === 'session') {
          checkActiveSession(data)
        }
      } catch {}
    }
  } catch (err) {
    if (wsPill) {
      wsPill.className = 'badge badge-red'
      wsPill.innerText = 'WS: OFF'
    }
  }
}

async function fetchRecentLogs() {
  try {
    const res = await fetch(`${API}/logs`)
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data.logs)) {
        for (const item of data.logs) {
          appendConsoleLog(item.level, item.message, item.timestamp, false)
        }
        renderTerminalLogs()
      }
    }
  } catch {}
}

function appendConsoleLog(level, message, timestamp = new Date().toISOString(), renderNow = true) {
  const cleanLevel = level || 'info'
  const time = timestamp ? timestamp.slice(11, 19) : new Date().toTimeString().slice(0, 8)

  if (cleanLevel === 'error') {
    unreadErrorCount++
    updateErrorBadge()
    showGlobalError(message)
  }

  consoleLogs.push({ level: cleanLevel, message, timestamp: time })
  if (consoleLogs.length > 300) consoleLogs.shift()

  updateLogCounters()

  if (renderNow) {
    renderTerminalLogs()
  }

  // Also sync to mini snipe log box if active
  const snipeBox = document.getElementById('snipe-log-box')
  if (snipeBox) {
    const row = document.createElement('div')
    row.style.marginBottom = '2px'
    row.innerHTML = `<span style="color: #64748B;">[${time}]</span> <span style="color: ${getLevelColor(cleanLevel)};">[${cleanLevel.toUpperCase()}]</span> ${escapeHtml(message)}`
    snipeBox.appendChild(row)
    snipeBox.scrollTop = snipeBox.scrollHeight
  }
}

function updateLogCounters() {
  const allCount = consoleLogs.length
  const errCount = consoleLogs.filter((l) => l.level === 'error').length
  const fireCount = consoleLogs.filter((l) => l.level === 'fire').length

  const allEl = document.getElementById('log-count-all')
  const errEl = document.getElementById('log-count-error')
  const fireEl = document.getElementById('log-count-fire')

  if (allEl) allEl.innerText = allCount
  if (errEl) errEl.innerText = errCount
  if (fireEl) fireEl.innerText = fireCount
}

function updateErrorBadge() {
  const badge = document.getElementById('console-error-badge')
  if (badge) {
    if (unreadErrorCount > 0) {
      badge.style.display = 'inline-block'
      badge.innerText = unreadErrorCount
    } else {
      badge.style.display = 'none'
    }
  }
}

function renderTerminalLogs() {
  const terminal = document.getElementById('full-terminal-output')
  if (!terminal) return

  const filtered = consoleLogs.filter((l) => {
    if (activeLogFilter === 'all') return true
    return l.level === activeLogFilter
  })

  if (filtered.length === 0) {
    terminal.innerHTML = `<div style="color: #64748B; padding: 12px; text-align: center;">No logs matching filter "${activeLogFilter}"</div>`
    return
  }

  terminal.innerHTML = filtered
    .map((l) => {
      const tagClass = `tag-${l.level}`
      const rowClass = l.level === 'error' ? 'row-error' : l.level === 'fire' ? 'row-fire' : ''
      return `
      <div class="terminal-row ${rowClass}">
        <span class="t-time">[${l.timestamp}]</span>
        <span class="t-tag ${tagClass}">${l.level}</span>
        <span class="t-msg">${escapeHtml(l.message)}</span>
      </div>
    `
    })
    .join('')

  const autoscroll = document.getElementById('console-autoscroll')
  if (autoscroll && autoscroll.checked) {
    terminal.scrollTop = terminal.scrollHeight
  }
}

function getLevelColor(level) {
  switch (level) {
    case 'error': return '#EF4444'
    case 'success': return '#10B981'
    case 'warn': return '#F59E0B'
    case 'fire': return '#E879F9'
    case 'block': return '#94A3B8'
    default: return '#38BDF8'
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ==========================================
// 4. DETECT TAB BUTTONS
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
          appendConsoleLog('info', `Detected tab target URL: ${url}`)
          if (triggerSchedule) autoDetectScheduleStages(url)
        }
      })
    }
  })
}

// ==========================================
// 5. CORE STATUS & WALLETS LOADER
// ==========================================
async function refreshCore() {
  try {
    const res = await fetch(`${API}/extension/status`)
    if (!res.ok) throw new Error('Core is offline')
    const data = await res.json()

    updateCoreStatus(true, data.walletsCount)
    walletsData = data.wallets || []
    currentEthPriceUsdt = data.ethPriceUsdt || currentEthPriceUsdt
    defaultRecipientAddress = data.recipientAddress || defaultRecipientAddress

    const snipeVault = document.getElementById('snipe-vault-address')
    const schedVault = document.getElementById('sched-vault-address')
    const sweepVault = document.getElementById('sweep-vault-input')

    if (snipeVault && !snipeVault.value && defaultRecipientAddress) {
      snipeVault.value = defaultRecipientAddress
    }
    if (schedVault && !schedVault.value && defaultRecipientAddress) {
      schedVault.value = defaultRecipientAddress
    }
    if (sweepVault && !sweepVault.value && defaultRecipientAddress) {
      sweepVault.value = defaultRecipientAddress
    }

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
// 6. SNIPE / ACTIVE SESSION TAB
// ==========================================
function initSnipeTab() {
  const startBtn = document.getElementById('snipe-start-btn')
  const stopBtn = document.getElementById('snipe-stop-btn')
  const toggleWallets = document.getElementById('snipe-toggle-wallets')
  const targetInput = document.getElementById('snipe-target')
  const autoTransferCb = document.getElementById('snipe-auto-transfer')
  const vaultContainer = document.getElementById('snipe-vault-container')

  if (autoTransferCb && vaultContainer) {
    autoTransferCb.addEventListener('change', () => {
      vaultContainer.style.display = autoTransferCb.checked ? 'block' : 'none'
    })
  }

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
            appendConsoleLog('info', `Target resolved price: ${data.analysis.mintPriceEth} ETH`)
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
      const autoTransfer = document.getElementById('snipe-auto-transfer')?.checked
      const autoTransferVault = autoTransfer
        ? document.getElementById('snipe-vault-address')?.value.trim()
        : undefined

      const selectedWallets = Array.from(
        document.querySelectorAll('.snipe-wallet-cb:checked'),
      ).map((cb) => parseInt(cb.getAttribute('data-idx'), 10))

      if (!target) {
        showGlobalError('Target contract address or OpenSea URL is required.')
        return
      }

      startBtn.disabled = true
      startBtn.innerHTML = '<span>⚡ FIRING...</span>'
      appendConsoleLog('fire', `Firing Blast Mint Session for target: ${target} [Mode: ${mode.toUpperCase()}]`)
      switchToTab('tab-console')

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
            autoTransferVault,
          }),
        })
        const json = await res.json()
        if (!res.ok) {
          appendConsoleLog('error', `Session start error: ${json.error}`)
          showGlobalError(json.error)
        } else {
          appendConsoleLog('success', `Session armed and executing!`)
          pollSession()
        }
      } catch (err) {
        appendConsoleLog('error', `Network failure: ${err.message}`)
        showGlobalError(err.message)
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
        appendConsoleLog('warn', `Session manually stopped by user.`)
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
    const vaultNote = session.autoTransferVault ? ` | 🏛️ Vault: ${session.autoTransferVault.slice(0, 8)}...` : ''
    if (info) info.innerHTML = `Running <strong>${session.mode}</strong> on <code>${session.target.slice(0, 24)}...</code>${vaultNote}`
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

    if (data.status === 'running') {
      if (card) card.style.display = 'block'
      const vaultNote = data.autoTransferVault ? ` | 🏛️ Vault: ${data.autoTransferVault.slice(0, 8)}...` : ''
      if (info) info.innerHTML = `Status: <span class="badge badge-green">RUNNING</span> | Target: <code>${data.target}</code>${vaultNote}`
    } else if (data.status === 'success') {
      if (info) info.innerHTML = `Status: <span class="badge badge-green">COMPLETED ✓</span>`
    } else if (data.status === 'error') {
      if (info) info.innerHTML = `Status: <span class="badge badge-red">FAILED: ${data.error}</span>`
      showGlobalError(data.error)
    }
  } catch {}
}

// ==========================================
// 7. SCHEDULE TAB
// ==========================================
function initScheduleTab() {
  const targetInput = document.getElementById('sched-target')
  const toggleWallets = document.getElementById('sched-toggle-wallets')
  const qtyInput = document.getElementById('sched-qty')
  const priceInput = document.getElementById('sched-price')
  const submitBtn = document.getElementById('sched-submit-btn')
  const autoTransferCb = document.getElementById('sched-auto-transfer')
  const vaultContainer = document.getElementById('sched-vault-container')

  if (autoTransferCb && vaultContainer) {
    autoTransferCb.addEventListener('change', () => {
      vaultContainer.style.display = autoTransferCb.checked ? 'block' : 'none'
    })
  }

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
      const autoTransfer = document.getElementById('sched-auto-transfer')?.checked
      const autoTransferVault = autoTransfer
        ? document.getElementById('sched-vault-address')?.value.trim()
        : undefined

      const selectedWallets = Array.from(
        document.querySelectorAll('.sched-wallet-cb:checked'),
      ).map((cb) => parseInt(cb.getAttribute('data-idx'), 10))

      if (!target || !mintTime) {
        showGlobalError('Target and Scheduled Mint Date/Time are required.')
        return
      }

      submitBtn.disabled = true
      submitBtn.innerHTML = '<span>Arming Schedule...</span>'
      appendConsoleLog('info', `Arming scheduled mint for ${mintTime} on ${target}...`)
      switchToTab('tab-console')

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
            autoTransferVault,
          }),
        })
        const json = await res.json()
        if (!res.ok) {
          appendConsoleLog('error', `Schedule Error: ${json.error}`)
          showGlobalError(json.error)
        } else {
          appendConsoleLog('success', `Scheduled mint successfully armed for ${mintTime}! T-0 blast ready.`)
        }
      } catch (err) {
        appendConsoleLog('error', `Schedule Network Error: ${err.message}`)
        showGlobalError(err.message)
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
// 8. WALLETS TAB (Multicall3 & Sweep)
// ==========================================
function initWalletsManager() {
  const addBtn = document.getElementById('add-wallet-btn')
  const fundBtn = document.getElementById('batch-fund-btn')
  const sweepBtn = document.getElementById('sweep-funds-btn')

  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const label = document.getElementById('add-wallet-label')?.value.trim()
      const privateKey = document.getElementById('add-wallet-pk')?.value.trim()

      if (!privateKey) {
        showGlobalError('Private Key is required.')
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
        if (!res.ok) {
          appendConsoleLog('error', `Failed to add wallet: ${json.error}`)
          showGlobalError(json.error)
        } else {
          appendConsoleLog('success', `Added new wallet (${label || 'Wallet'}) to vault.`)
          document.getElementById('add-wallet-label').value = ''
          document.getElementById('add-wallet-pk').value = ''
          refreshCore()
        }
      } catch (err) {
        appendConsoleLog('error', `Add Wallet Error: ${err.message}`)
        showGlobalError(err.message)
      } finally {
        addBtn.disabled = false
      }
    })
  }

  // Multicall3 1-Tx Batch Funder
  if (fundBtn) {
    fundBtn.addEventListener('click', async () => {
      const amountEth = document.getElementById('fund-amount-input')?.value.trim()
      const statusEl = document.getElementById('batch-fund-status')
      if (!amountEth || parseFloat(amountEth) <= 0) {
        showGlobalError('Please enter a valid ETH amount per wallet (e.g. 0.005).')
        return
      }

      fundBtn.disabled = true
      fundBtn.innerHTML = '<span>⚡ Dispersing 1-Tx...</span>'
      appendConsoleLog('fire', `Initiating Multicall3 1-Tx Batch Funding of ${amountEth} ETH / wallet...`)
      switchToTab('tab-console')

      try {
        const res = await fetch(`${API}/wallets/fund-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountEthPerWallet: amountEth }),
        })
        const data = await res.json()
        if (!res.ok) {
          appendConsoleLog('error', `Multicall3 funding error: ${data.error}`)
          if (statusEl) statusEl.innerHTML = `<span style="color: var(--red);">Failed: ${data.error}</span>`
          showGlobalError(data.error)
        } else {
          appendConsoleLog('success', `Multicall3 funded ${data.walletsFunded} wallets (${data.totalEthDistributed} ETH) in 1 Tx!`)
          if (statusEl) {
            statusEl.innerHTML = `<span style="color: var(--accent-dark);">✓ Multicall3 Funded ${data.walletsFunded} Wallets (${data.totalEthDistributed} ETH) in 1 Tx!</span>`
          }
          refreshCore()
        }
      } catch (err) {
        appendConsoleLog('error', `Multicall3 Network Error: ${err.message}`)
        if (statusEl) statusEl.innerHTML = `<span style="color: var(--red);">${err.message}</span>`
        showGlobalError(err.message)
      } finally {
        fundBtn.disabled = false
        fundBtn.innerHTML = '<span>⚡ Disperse ETH</span>'
      }
    })
  }

  // Sweep Native ETH Dust
  if (sweepBtn) {
    sweepBtn.addEventListener('click', async () => {
      const recipientAddress = document.getElementById('sweep-vault-input')?.value.trim()
      const statusEl = document.getElementById('sweep-funds-status')
      if (!recipientAddress || !recipientAddress.startsWith('0x') || recipientAddress.length !== 42) {
        showGlobalError('Please enter a valid 0x 40-character Cold Vault address.')
        return
      }

      if (!confirm(`Sweep all remaining ETH dust from burner wallets to ${recipientAddress}?`)) return

      sweepBtn.disabled = true
      sweepBtn.innerHTML = '<span>Sweeping...</span>'
      appendConsoleLog('info', `Sweeping all remaining ETH dust to ${recipientAddress}...`)
      switchToTab('tab-console')

      try {
        const res = await fetch(`${API}/wallets/sweep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipientAddress }),
        })
        const data = await res.json()
        if (!res.ok) {
          appendConsoleLog('error', `Sweep Error: ${data.error}`)
          if (statusEl) statusEl.innerHTML = `<span style="color: var(--red);">Failed: ${data.error}</span>`
          showGlobalError(data.error)
        } else {
          const sweptCount = data.results?.filter((r) => r.hash && !r.error)?.length || 0
          appendConsoleLog('success', `Swept dust from ${sweptCount} burner wallets to cold vault!`)
          if (statusEl) {
            statusEl.innerHTML = `<span style="color: var(--accent-dark);">✓ Swept from ${sweptCount} wallets to vault!</span>`
          }
          refreshCore()
        }
      } catch (err) {
        appendConsoleLog('error', `Sweep Network Error: ${err.message}`)
        if (statusEl) statusEl.innerHTML = `<span style="color: var(--red);">${err.message}</span>`
        showGlobalError(err.message)
      } finally {
        sweepBtn.disabled = false
        sweepBtn.innerHTML = '<span>Sweep All</span>'
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
        appendConsoleLog('info', `Removed Wallet ${idx} from vault.`)
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
        appendConsoleLog('info', `Renamed Wallet ${idx} to "${newName.trim()}".`)
        refreshCore()
      }
    })
  })
}

// ==========================================
// 9. ANALYZER TAB
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
      appendConsoleLog('info', `Probing target contract: ${target}`)

      try {
        const res = await fetch(`${API}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target }),
        })
        const data = await res.json()
        if (!res.ok) {
          appendConsoleLog('error', `Analyzer error: ${data.error}`)
          showGlobalError(data.error)
        } else if (data?.analysis) {
          const a = data.analysis
          appendConsoleLog('success', `Analysis completed for ${a.contractAddress} (Verified: ${a.isVerified})`)
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
      } catch (err) {
        appendConsoleLog('error', `Analyzer Network Failure: ${err.message}`)
        showGlobalError(err.message)
      } finally {
        btn.disabled = false
        btn.innerText = 'Analyze'
      }
    })
  }
}

// ==========================================
// 10. GAS TRACKER
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
