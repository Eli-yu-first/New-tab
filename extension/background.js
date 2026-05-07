/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for New Tab.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(async (tab) => {
  updateBadge();
  
  try {
    // 1. 获取是否允许重复创建新标签页。如果 allowDuplicateTabs 不为 true（即默认是单例拦截模式）
    const settings = await chrome.storage.local.get(['allowDuplicateTabs']);
    const allowDuplicate = settings.allowDuplicateTabs === true;
    
    if (allowDuplicate) return;
    
    // 如果是单例模式，我们要判断这个新开的标签页是否是 New Tab
    const url = tab.pendingUrl || tab.url || '';
    const extensionId = chrome.runtime.id;
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;
    
    // 识别新标签页的多种可能特征
    const isNewTab = url === newtabUrl || url === 'chrome://newtab/' || url.includes(extensionId);
    
    if (isNewTab) {
      const allTabs = await chrome.tabs.query({});
      const existingNewTabs = allTabs.filter(t => {
        if (t.id === tab.id) return false; // 排除当前自己
        const u = t.url || '';
        return u === newtabUrl || u === 'chrome://newtab/' || u.includes(extensionId);
      });
      
      if (existingNewTabs.length > 0) {
        // 如果已经有别的新标签页，就把用户飞跃跳转至已存在的第一个新标签页，并销毁当前这个！
        const keepTab = existingNewTabs[0];
        await chrome.tabs.update(keepTab.id, { active: true });
        await chrome.windows.update(keepTab.windowId, { focused: true });
        await chrome.tabs.remove(tab.id);
      }
    }
  } catch (err) {
    console.error('Singleton check error:', err);
  }
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
