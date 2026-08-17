/**
 * MintBot Background Service Worker
 */

const LOCAL_CORE_URL = 'http://localhost:3000/api'

// Listen for messages from popup or content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CORE_STATUS') {
    fetch(`${LOCAL_CORE_URL}/extension/status`)
      .then((r) => r.json())
      .then((data) => {
        updateBadge(data.walletsCount || 0, true)
        sendResponse({ success: true, data })
      })
      .catch((err) => {
        updateBadge(0, false)
        sendResponse({ success: false, error: err.message })
      })
    return true // Keep channel open for async response
  }

  if (message.type === 'TRIGGER_MINT') {
    fetch(`${LOCAL_CORE_URL}/extension/mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload),
    })
      .then((r) => r.json())
      .then((data) => {
        sendResponse({ success: true, data })
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message })
      })
    return true
  }

  if (message.type === 'ANALYZE_TARGET') {
    fetch(`${LOCAL_CORE_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: message.target }),
    })
      .then((r) => r.json())
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }))
    return true
  }
})

// Hotkey command listener (e.g. Ctrl+Shift+M)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'quick-snipe') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_HOTKEY_SNIPE' })
    }
  }
})

function updateBadge(walletCount, isOnline) {
  if (isOnline && walletCount > 0) {
    chrome.action.setBadgeText({ text: `${walletCount}W` })
    chrome.action.setBadgeBackgroundColor({ color: '#10B981' }) // Emerald Green
  } else {
    chrome.action.setBadgeText({ text: 'OFF' })
    chrome.action.setBadgeBackgroundColor({ color: '#EF4444' }) // Red
  }
}

// Initial status check on startup
chrome.runtime.onInstalled.addListener(() => {
  fetch(`${LOCAL_CORE_URL}/extension/status`)
    .then((r) => r.json())
    .then((data) => updateBadge(data.walletsCount || 0, true))
    .catch(() => updateBadge(0, false))
})
