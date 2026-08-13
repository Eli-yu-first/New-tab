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

function isNewTabPageUrl(url, extensionId) {
  if (!url) return false;

  const extensionNewTabUrl = `chrome-extension://${extensionId}/index.html`;
  return (
    url.startsWith(extensionNewTabUrl) ||
    url === 'chrome://newtab/' ||
    url === 'chrome://new-tab-page/'
  );
}

/**
 * A tab opened by a link may briefly render the overridden New Tab page while
 * Chrome is still committing its destination. Only collapse standalone blank
 * tabs; tabs with an opener or a non-New-Tab pending URL are navigation tabs.
 */
function isStandaloneNewTab(tab, url, extensionId) {
  if (!isNewTabPageUrl(url, extensionId)) return false;
  if (tab.openerTabId != null) return false;

  const pendingUrl = tab.pendingUrl || '';
  return !pendingUrl || isNewTabPageUrl(pendingUrl, extensionId);
}

async function focusExistingNewTab(currentTabId, extensionId) {
  const allTabs = await chrome.tabs.query({});
  const existingNewTabs = allTabs.filter(t => {
    if (t.id === currentTabId) return false;
    return isNewTabPageUrl(t.url || '', extensionId);
  });

  if (existingNewTabs.length === 0) return false;

  const keepTab = existingNewTabs[0];
  await chrome.tabs.update(keepTab.id, { active: true });
  await chrome.windows.update(keepTab.windowId, { focused: true });
  await chrome.tabs.remove(currentTabId);
  return true;
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

// Update the badge as soon as a tab is created. Do not enforce the singleton
// here: a link opened in a new tab is briefly blank before its destination URL
// is assigned, and closing it at that stage cancels the navigation.
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  updateBadge();
  
  try {
    const url = changeInfo.url || tab.url || '';
    const extensionId = chrome.runtime.id;
    
    if (isStandaloneNewTab(tab, url, extensionId)) {
      const settings = await chrome.storage.local.get(['allowDuplicateTabs']);
      if (settings.allowDuplicateTabs === true) return;

      await focusExistingNewTab(tabId, extensionId);
    }
  } catch (err) {
    console.error('onUpdated singleton check error:', err);
  }
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
