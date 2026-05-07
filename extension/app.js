/* ================================================================
   New Tab — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   NATIVE MESSAGING — 跨浏览器同步

   通过 Native Messaging Host 读写本地共享 JSON 文件
   (~/.newtab_sync/data.json)，使同一台电脑上不同浏览器
   中的 New Tab 扩展共享 Bookmarks 和 Saved for later 数据。

   若 Native Messaging Host 未安装，则自动降级为仅使用
   chrome.storage.sync（原有行为，不影响正常使用）。
   ---------------------------------------------------------------- */

const NATIVE_HOST_NAME = 'com.newtab.sync';
let nativeHostAvailable = null; // null=未检测, true/false=已检测
let nativePort = null;

// 缓存接收到的全端数据（含历史和打开标签页）
let sharedNativeData = { bookmarks: [], deferred: [], openTabs: {}, history: [] };
let activeContextBookmarkIndex = null;
let isEditMode = false;

/**
 * 智能自动检测当前浏览器品牌
 */
function getBrowserName() {
  const ua = navigator.userAgent;
  if (ua.includes('Doubao')) return 'Doubao';
  if (ua.includes('Edg')) return 'Edge';
  if (ua.includes('Brave')) return 'Brave';
  return 'Chrome';
}

/**
 * URL 规范化归一（去除协议、www、尾部斜杠、参数、Hash），用于高精度相似网址判定
 */
function getNormalizedUrl(urlString) {
  if (!urlString) return '';
  try {
    if (urlString.startsWith('chrome://') || urlString.startsWith('chrome-extension://')) {
      return urlString;
    }
    const url = new URL(urlString);
    let host = url.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    let path = url.pathname.toLowerCase();
    if (path.endsWith('/')) path = path.slice(0, -1);
    return host + path;
  } catch {
    let clean = urlString.toLowerCase();
    clean = clean.replace(/^(https?:\/\/)?(www\.)?/, '');
    clean = clean.replace(/\/$/, '');
    clean = clean.split('?')[0].split('#')[0];
    return clean;
  }
}

/**
 * 判定两个网址是否“相似”
 */
function isSimilarUrl(urlA, urlB) {
  return getNormalizedUrl(urlA) === getNormalizedUrl(urlB);
}

/**
 * 合并两个 bookmarks 数组（以 URL 为唯一标识去重）。
 */
function mergeBookmarks(a, b) {
  const map = new Map();
  for (const item of a) map.set(item.url, item);
  for (const item of b) {
    if (!map.has(item.url)) map.set(item.url, item);
  }
  return Array.from(map.values());
}

/**
 * 合并两个 deferred 数组（以 id 为唯一标识去重）。
 */
function mergeDeferred(a, b) {
  const map = new Map();
  for (const item of a) map.set(item.id, item);
  for (const item of b) {
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return Array.from(map.values());
}

/**
 * 建立与 Native Messaging Host 的常驻长连接，实时双向合并数据。
 */
function setupNativePort() {
  if (nativeHostAvailable === false) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    
    nativePort.onMessage.addListener(async (msg) => {
      // 处理全端数据改变
      if (msg && msg.event === 'changed') {
        const shared = msg.data;
        if (!shared) return;

        sharedNativeData = shared; // 缓存最新全端数据给全局

        // 获取本地存储数据
        const syncResult = await chrome.storage.sync.get(['deferred', BOOKMARKS_STORAGE_KEY]);
        const localDeferred = syncResult.deferred || [];
        const localBookmarks = syncResult[BOOKMARKS_STORAGE_KEY] || [];

        // 合并数据
        const mergedDeferred = mergeDeferred(shared.deferred || [], localDeferred);
        const mergedBookmarks = mergeBookmarks(shared.bookmarks || [], localBookmarks);

        // 检查是否有任何一端落后或发生变动，如果有才重新写入，严防死循环广播
        const localChanged = JSON.stringify(mergedDeferred) !== JSON.stringify(localDeferred) ||
                             JSON.stringify(mergedBookmarks) !== JSON.stringify(localBookmarks);
        
        const sharedChanged = JSON.stringify(mergedDeferred) !== JSON.stringify(shared.deferred || []) ||
                              JSON.stringify(mergedBookmarks) !== JSON.stringify(shared.bookmarks || []);

        if (localChanged) {
          await chrome.storage.sync.set({
            deferred: mergedDeferred,
            [BOOKMARKS_STORAGE_KEY]: mergedBookmarks,
          });
        }

        if (sharedChanged) {
          // 如果合并后的最新数据和共享文件里的不一致，把更新同步回共享文件
          nativePort.postMessage({
            action: 'write',
            data: { bookmarks: mergedBookmarks, deferred: mergedDeferred }
          });
        }

        // 刷新本地标签页、获取并重绘整个 Dashboard 视图
        await fetchOpenTabs();
        await renderDashboard();
      }

      // 处理跨浏览器远程关闭标签页指令
      if (msg && msg.event === 'closeTabRequest') {
        const myBrowser = getBrowserName();
        if (msg.browser === myBrowser && msg.url) {
          const allTabs = await chrome.tabs.query({});
          const matches = allTabs.filter(t => isSimilarUrl(t.url, msg.url));
          for (const t of matches) {
            await chrome.tabs.remove(t.id);
          }
          await fetchOpenTabs();
          await renderDashboard();
        }
      }
    });

    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      // 异常断开时，10 秒后自动重试，确保同步通路持续畅通
      setTimeout(setupNativePort, 10000);
    });

    nativeHostAvailable = true;
  } catch (err) {
    nativePort = null;
    nativeHostAvailable = false;
  }
}

/**
 * 主动将最新数据推送到本地共享文件（当发生写操作时被调用）。
 */
async function pushToNativeHost() {
  if (!nativePort) return;
  try {
    const syncResult = await chrome.storage.sync.get(['deferred', BOOKMARKS_STORAGE_KEY]);
    nativePort.postMessage({
      action: 'write',
      data: {
        bookmarks: syncResult[BOOKMARKS_STORAGE_KEY] || [],
        deferred: syncResult.deferred || [],
      }
    });
  } catch (err) {
    console.error('[tab-out] pushToNativeHost error:', err);
  }
}


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * 读取当前浏览器中真正打开的标签页，将其上报给共享宿主；
 * 同时拉取共享内存中其它浏览器开着的标签页，利用“相似网址”判定进行多端归集和合并。
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    const filteredLocal = tabs.filter(t => t.url && t.url !== newtabUrl && t.url !== 'chrome://newtab/');
    
    const formattedLocal = filteredLocal.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title || t.url,
      favIconUrl: t.favIconUrl || '',
      windowId: t.windowId,
      active:   t.active
    }));

    // 将本浏览器的打开标签推送到共享媒介
    if (nativePort) {
      nativePort.postMessage({
        action: 'writeOpenTabs',
        browser: getBrowserName(),
        tabs: formattedLocal
      });
    }

    // 跨端整合合并
    let combinedTabs = [...formattedLocal];
    const myBrowser = getBrowserName();

    if (sharedNativeData && sharedNativeData.openTabs) {
      for (const [browser, remoteTabs] of Object.entries(sharedNativeData.openTabs)) {
        if (browser === myBrowser) continue; // 剔除自己
        if (!Array.isArray(remoteTabs)) continue;

        for (const remoteTab of remoteTabs) {
          const similarMatch = combinedTabs.find(t => isSimilarUrl(t.url, remoteTab.url));
          if (similarMatch) {
            // 如果两个端打开了相似/相同的网址，合并它们，并标记多端存在
            if (!similarMatch.remoteBrowsers) similarMatch.remoteBrowsers = [];
            if (!similarMatch.remoteBrowsers.includes(browser)) {
              similarMatch.remoteBrowsers.push(browser);
            }
          } else {
            // 在本端没开、但在其它端开着的标签，作为跨端标签显示
            combinedTabs.push({
              id: `remote-${browser}-${Date.now()}-${Math.random()}`,
              url: remoteTab.url,
              title: remoteTab.title,
              favIconUrl: remoteTab.favIconUrl,
              remoteBrowser: browser,
              windowId: -1,
              active: false
            });
          }
        }
      }
    }

    openTabs = combinedTabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      favIconUrl: t.favIconUrl,
      remoteBrowser: t.remoteBrowser,
      remoteBrowsers: t.remoteBrowsers,
      isTabOut: false
    }));
  } catch (err) {
    console.error('fetchOpenTabs error:', err);
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). If no match is found, creates a new tab.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  let matches = allTabs.filter(t => t.url === url);

  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  // 如果没有找到任何匹配的已打开页面，直接在新标签页中打开该链接
  if (matches.length === 0) {
    await chrome.tabs.create({ url });
    return;
  }

  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate New Tab new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local
   ---------------------------------------------------------------- */

// 封装统一的读取与自动迁移逻辑
async function getDeferred() {
  const syncResult = await chrome.storage.sync.get('deferred');
  if (syncResult.deferred && syncResult.deferred.length > 0) {
    return syncResult.deferred;
  }
  
  // 如果同步存储区为空，尝试读取旧的本地存储进行迁移
  const localResult = await chrome.storage.local.get('deferred');
  const localData = localResult.deferred || [];
  if (localData.length > 0) {
    await chrome.storage.sync.set({ deferred: localData });
    await chrome.storage.local.remove('deferred');
  }
  return localData;
}

// 统一的写入逻辑（保存至云端同步存储区）
async function setDeferred(deferred) {
  await chrome.storage.sync.set({ deferred });
  await pushToNativeHost();
}

async function saveTabForLater(tab) {
  const deferred = await getDeferred();
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await setDeferred(deferred);
}

async function getSavedTabs() {
  const deferred = await getDeferred();
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

async function checkOffSavedTab(id) {
  const deferred = await getDeferred();
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await setDeferred(deferred);
  }
}

async function dismissSavedTab(id) {
  const deferred = await getDeferred();
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await setDeferred(deferred);
  }
}


/* ----------------------------------------------------------------
   FREQUENTLY USED TABS — chrome.topSites API
   ---------------------------------------------------------------- */

async function getHistoryItems() {
  try {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const startTime = now - 90 * oneDayMs;

    const items = await chrome.history.search({
      text: '',
      startTime: startTime,
      maxResults: 150, // 只取最新的 150 条
    });

    const uniqueLocal = [];
    const seen = new Set();
    for (const item of items) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      uniqueLocal.push({
        url: item.url,
        title: item.title || item.url,
        lastVisitTime: item.lastVisitTime || 0,
        visitCount: item.visitCount || 0,
      });
    }

    // 将本地的最新历史推送到共享主机以完成全端汇总
    if (nativePort && uniqueLocal.length > 0) {
      nativePort.postMessage({
        action: 'writeHistory',
        history: uniqueLocal
      });
    }

    // 整合其它端发来的历史记录并做“网址相似”合并去重
    let combinedHistory = [...uniqueLocal];
    if (sharedNativeData && Array.isArray(sharedNativeData.history)) {
      for (const hist of sharedNativeData.history) {
        const match = combinedHistory.find(h => isSimilarUrl(h.url, hist.url));
        if (match) {
          // 若属于相似 URL，做整合：取最新的访问时间，标题取长，计数加一
          match.lastVisitTime = Math.max(match.lastVisitTime || 0, hist.lastVisitTime || 0);
          match.visitCount = Math.max(match.visitCount || 0, hist.visitCount || 0) + 1;
          if (hist.title && hist.title.length > match.title.length) {
            match.title = hist.title;
          }
        } else {
          combinedHistory.push(hist);
        }
      }
    }

    // 重新按最后访问时间降序排列
    combinedHistory.sort((a, b) => b.lastVisitTime - a.lastVisitTime);

    return combinedHistory;
  } catch (err) {
    console.error('getHistoryItems error:', err);
    return [];
  }
}

function groupHistoryByTime(items) {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const weekStart = todayMs - (todayStart.getDay()) * oneDayMs;
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthMs = monthStart.getTime();
  const yearStart = new Date(now);
  yearStart.setMonth(0, 1);
  yearStart.setHours(0, 0, 0, 0);
  const yearMs = yearStart.getTime();

  const groups = {
    today:     { label: '今天', items: [] },
    thisWeek:  { label: '本周', items: [] },
    thisMonth: { label: '本月', items: [] },
    thisYear:  { label: '今年', items: [] },
    older:     { label: '更早', items: [] },
  };

  for (const item of items) {
    const t = item.lastVisitTime || 0;
    if (t >= todayMs)       groups.today.items.push(item);
    else if (t >= weekStart) groups.thisWeek.items.push(item);
    else if (t >= monthMs)  groups.thisMonth.items.push(item);
    else if (t >= yearMs)   groups.thisYear.items.push(item);
    else                    groups.older.items.push(item);
  }

  return groups;
}


/* ----------------------------------------------------------------
   BOOKMARKS — chrome.bookmarks API
   ---------------------------------------------------------------- */

async function getBookmarks() {
  const customBookmarks = await getCustomBookmarks();
  return customBookmarks.map(b => ({
    url: b.url,
    title: b.title || b.url,
  }));
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

function shootConfetti(x, y) {
  const colors = [
    '#c8713a', '#e8a070', '#5a7a62', '#8aaa92',
    '#5a6b7a', '#8a9baa', '#d4b896', '#b35a5a',
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');
    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6;
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80;
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200;

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    let remoteBadge = '';
    if (tab.remoteBrowser) {
      remoteBadge = ` <span class="remote-badge remote-${tab.remoteBrowser.toLowerCase()}" style="font-size:9px; background:rgba(154,145,138,0.15); color:var(--muted); padding:1px 4px; border-radius:3px; margin-left:4px;">${tab.remoteBrowser}</span>`;
    }
    if (tab.remoteBrowsers && tab.remoteBrowsers.length > 0) {
      remoteBadge = ` <span class="remote-badge remote-multi" style="font-size:9px; background:rgba(90,122,98,0.15); color:var(--accent-sage); padding:1px 4px; border-radius:3px; margin-left:4px;">多端</span>`;
    }

    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}${remoteBadge}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''}
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge dupe-badge">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  const closeButton = `
    <button class="minimal-close-btn" data-action="close-domain-tabs" data-domain-id="${stableId}" title="Close all ${tabCount} tabs">
      ${ICONS.close}
    </button>`;

  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    let remoteBadge = '';
    if (tab.remoteBrowser) {
      remoteBadge = ` <span class="remote-badge remote-${tab.remoteBrowser.toLowerCase()}" style="font-size:9px; background:rgba(154,145,138,0.15); color:var(--muted); padding:1px 4px; border-radius:3px; margin-left:4px;">${tab.remoteBrowser}</span>`;
    }
    if (tab.remoteBrowsers && tab.remoteBrowsers.length > 0) {
      remoteBadge = ` <span class="remote-badge remote-multi" style="font-size:9px; background:rgba(90,122,98,0.15); color:var(--accent-sage); padding:1px 4px; border-radius:3px; margin-left:4px;">多端</span>`;
    }

    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}${remoteBadge}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = '';
  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml = `
      <div class="actions">
        <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
          Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
        </button>
      </div>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
          ${closeButton}
        </div>
        <div class="mission-pages">${pageChips}</div>
        ${actionsHtml}
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   FREQUENTLY USED AND BOOKMARKS CARD RENDERER
   ---------------------------------------------------------------- */

function renderSimpleCard(title, items, sectionType) {
  const cardId = `simple-card-${sectionType}`;
  const isBookmarks = sectionType === 'bookmarks';
  
  const pageChips = items.slice(0, 50).map((item, index) => {
    let label = cleanTitle(smartTitle(stripTitleNoise(item.title || ''), item.url), '');
    const safeUrl   = (item.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(item.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';

    const draggableAttr = isBookmarks ? ' draggable="true"' : '';
    const extraClass = isBookmarks ? ' bookmark-chip' : '';

    return `<div class="page-chip clickable${extraClass}"${draggableAttr} data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}" data-index="${index}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>
      <div class="chip-actions">
        ${isBookmarks ? '' : `<button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>`}
      </div>
    </div>`;
  }).join('');

  return `
    <div class="mission-card simple-card" id="${cardId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${title}</span>
          <span class="open-tabs-badge">
            ${ICONS.tabs}
            ${items.length}
          </span>
        </div>
        <div class="mission-pages">${pageChips}</div>
      </div>
    </div>`;
}

/**
 * renderHistoryCard — 渲染单个时间分组的History卡片
 * 每条记录展示 favicon、标题、访问时间
 */
function renderHistoryCard(groupLabel, items, groupKey) {
  const cardId = `history-card-${groupKey}`;
  const maxVisible = 8;
  const visibleItems = items.slice(0, maxVisible);
  const hiddenItems = items.slice(maxVisible);

  function formatVisitTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMins < 1)   return '刚刚';
    if (diffMins < 60)  return `${diffMins} 分钟前`;
    if (diffHours < 24) return `${diffHours} 小时前`;

    // 同一年只显示月日+时分
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  function renderChip(item) {
    let label = cleanTitle(smartTitle(stripTitleNoise(item.title || ''), item.url), '');
    const safeUrl = (item.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(item.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    const timeStr = formatVisitTime(item.lastVisitTime);

    return `<div class="page-chip clickable history-chip" data-action="open-history-url" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>
      <span class="history-time">${timeStr}</span>
      <div class="chip-actions">
        <button class="chip-action chip-delete" data-action="delete-history-item" data-tab-url="${safeUrl}" title="Delete history">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }

  const visibleChips = visibleItems.map(renderChip).join('');
  let overflowHtml = '';
  if (hiddenItems.length > 0) {
    const hiddenChips = hiddenItems.map(renderChip).join('');
    overflowHtml = `
      <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
      <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
        <span class="chip-text">+${hiddenItems.length} more</span>
      </div>`;
  }

  return `
    <div class="mission-card history-group-card has-neutral-bar" id="${cardId}" data-group-key="${groupKey}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${groupLabel}</span>
          <span class="open-tabs-badge">
            ${ICONS.tabs}
            ${items.length}
          </span>
        </div>
        <div class="mission-pages">${visibleChips}${overflowHtml}</div>
      </div>
    </div>`;
}

/**
 * renderHistoryGroups — 渲染全部时间分组的History
 */
function renderHistoryGroups(groups) {
  let html = '';
  for (const [key, group] of Object.entries(groups)) {
    if (group.items.length === 0) continue;
    html += renderHistoryCard(group.label, group.items, key);
  }
  return html;
}

/**
 * renderSavedTabs — 渲染 Saved for later 的标签页
 */
function renderSavedTabs(savedTabs) {
  // 格式化保存时间（与 History 一致）
  function formatSavedTime(savedAt) {
    if (!savedAt) return '';
    const date = new Date(savedAt);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMins < 1)   return '刚刚';
    if (diffMins < 60)  return `${diffMins} 分钟前`;
    if (diffHours < 24) return `${diffHours} 小时前`;

    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  const pageChips = savedTabs.map((tab) => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const safeUrl = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    const safeId = (tab.id || '').replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    const timeStr = formatSavedTime(tab.savedAt);

    return `<div class="page-chip clickable saved-chip" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>
      <span class="saved-time">${timeStr}</span>
      <div class="chip-actions">
        <button class="chip-action chip-delete" data-action="dismiss-saved" data-tab-id="${safeId}" title="Remove">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="mission-card simple-card" id="saved-for-later-card">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">Saved for later</span>
          <span class="open-tabs-badge">
            ${ICONS.tabs}
            ${savedTabs.length}
          </span>
        </div>
        <div class="mission-pages">${pageChips}</div>
      </div>
    </div>`;
}

// 全局历史排序状态：'time-desc'（最新优先）或 'time-asc'（最早优先）
let historySortOrder = 'time-desc';
// 全局 Saved for later 排序状态
let savedTabsSortOrder = 'time-desc';


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

async function renderStaticDashboard() {
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true;
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render Open tabs column ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');

  if (domainGroups.length > 0 && openTabsSection) {
    openTabsSectionCount.textContent = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''}`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Render History column ---
  const frequentTabsSection = document.getElementById('frequentTabsSection');
  const frequentTabsMissionsEl = document.getElementById('frequentTabsMissions');
  const frequentTabsCount = document.getElementById('frequentTabsCount');
  
  const historyItems = await getHistoryItems();
  if (frequentTabsSection) {
    frequentTabsSection.style.display = 'block';
    if (historyItems.length > 0) {
      // 按当前排序方向对History排序
      const sortedItems = [...historyItems].sort((a, b) => {
        return historySortOrder === 'time-asc'
          ? (a.lastVisitTime || 0) - (b.lastVisitTime || 0)
          : (b.lastVisitTime || 0) - (a.lastVisitTime || 0);
      });
      const groups = groupHistoryByTime(sortedItems);
      const totalShown = Object.values(groups).reduce((s, g) => s + g.items.length, 0);
      frequentTabsCount.textContent = `${totalShown} 条`;
      frequentTabsMissionsEl.innerHTML = renderHistoryGroups(groups);
    } else {
      frequentTabsCount.textContent = '0 条';
      frequentTabsMissionsEl.innerHTML = `
        <div class="missions-empty-state">
          <div class="empty-title">暂无浏览记录</div>
          <div class="empty-subtitle">您的浏览历史将显示在这里</div>
        </div>
      `;
    }
  }

  // --- Render Bookmarks column ---
  const bookmarksSection = document.getElementById('bookmarksSection');
  const bookmarksMissionsEl = document.getElementById('bookmarksMissions');
  const bookmarksCount = document.getElementById('bookmarksCount');
  
  const bookmarks = await getBookmarks();
  if (bookmarksSection) {
    bookmarksSection.style.display = 'block';
    if (bookmarks.length > 0) {
      bookmarksCount.textContent = `${bookmarks.length} bookmarks`;
      bookmarksMissionsEl.innerHTML = renderSimpleCard('Bookmarks', bookmarks, 'bookmarks');
    } else {
      bookmarksCount.textContent = '0 bookmarks';
      bookmarksMissionsEl.innerHTML = `
        <div class="missions-empty-state">
          <div class="empty-title">No bookmarks yet</div>
          <div class="empty-subtitle">Click + to add a bookmark</div>
        </div>
      `;
    }
  }

  // --- Render Saved for later column ---
  const savedTabsSection = document.getElementById('savedTabsSection');
  const savedTabsMissionsEl = document.getElementById('savedTabsMissions');
  const savedTabsCount = document.getElementById('savedTabsCount');
  
  const savedTabsData = await getSavedTabs();
  if (savedTabsSection) {
    savedTabsSection.style.display = 'block';
    if (savedTabsData.active.length > 0) {
      // 按照保存时间对 Saved for later 进行排序
      const sortedSavedTabs = [...savedTabsData.active].sort((a, b) => {
        const timeA = new Date(a.savedAt || 0).getTime();
        const timeB = new Date(b.savedAt || 0).getTime();
        return savedTabsSortOrder === 'time-asc' ? timeA - timeB : timeB - timeA;
      });
      savedTabsCount.textContent = `${sortedSavedTabs.length} saved`;
      savedTabsMissionsEl.innerHTML = renderSavedTabs(sortedSavedTabs);
    } else {
      savedTabsCount.textContent = '0 saved';
      savedTabsMissionsEl.innerHTML = `
        <div class="missions-empty-state">
          <div class="empty-title">Nothing saved yet</div>
          <div class="empty-subtitle">Click the bookmark icon to save tabs</div>
        </div>
      `;
    }
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  checkTabOutDupes();
  setupDragAndDrop();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra New Tab tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  if (action === 'close-single-tab') {
    e.stopPropagation();
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // 支持跨浏览器多端远程关闭
    if (nativePort) {
      const matchedOpenTab = openTabs.find(t => t.url === tabUrl);
      if (matchedOpenTab) {
        if (matchedOpenTab.remoteBrowser) {
          nativePort.postMessage({
            action: 'requestCloseTab',
            browser: matchedOpenTab.remoteBrowser,
            url: tabUrl
          });
        }
        if (matchedOpenTab.remoteBrowsers && matchedOpenTab.remoteBrowsers.length > 0) {
          for (const rb of matchedOpenTab.remoteBrowsers) {
            nativePort.postMessage({
              action: 'requestCloseTab',
              browser: rb,
              url: tabUrl
            });
          }
        }
      }
    }

    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl || isSimilarUrl(t.url, tabUrl));
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDashboard();
    return;
  }

  if (action === 'check-off-saved') {
    e.stopPropagation();
    const tabId = actionEl.dataset.tabId;
    if (!tabId) return;

    await checkOffSavedTab(tabId);
    showToast('Marked as done');
    await renderDashboard();
    return;
  }

  if (action === 'dismiss-saved') {
    e.stopPropagation();
    const tabId = actionEl.dataset.tabId;
    if (!tabId) return;

    await dismissSavedTab(tabId);
    showToast('Removed');
    await renderDashboard();
    return;
  }

  if (action === 'delete-history-item') {
    e.stopPropagation();
    const url = actionEl.dataset.tabUrl;
    if (!url) return;

    try {
      await chrome.history.deleteUrl({ url });
      showToast('Deleted from history');
      await renderDashboard();
    } catch (err) {
      console.error('[tab-out] Failed to delete history:', err);
      showToast('Failed to delete history');
    }
    return;
  }

  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);

    if (allUrls.length === 0) return;

    const toClose = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.id);

    if (toClose.length > 0) await chrome.tabs.remove(toClose);
    await fetchOpenTabs();

    playCloseSound();
    showToast(`Closed ${allUrls.length} tabs`);

    setTimeout(() => {
      document.querySelectorAll('.mission-card').forEach(card => {
        animateCardOut(card);
      });
      checkAndShowEmptyState();
    }, 100);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }
});


/* ----------------------------------------------------------------
   BOOKMARK MANAGEMENT FUNCTIONS
   ---------------------------------------------------------------- */

const BOOKMARKS_STORAGE_KEY = 'tabOut_customBookmarks';

async function getCustomBookmarks() {
  return new Promise((resolve) => {
    // 优先从跨设备同步存储 (sync) 获取
    chrome.storage.sync.get(BOOKMARKS_STORAGE_KEY, (syncResult) => {
      const syncData = syncResult[BOOKMARKS_STORAGE_KEY];
      if (syncData && syncData.length > 0) {
        resolve(syncData);
      } else {
        // 若 sync 中无数据，尝试读取旧的本地 (local) 存储进行数据迁移
        chrome.storage.local.get(BOOKMARKS_STORAGE_KEY, (localResult) => {
          const localData = localResult[BOOKMARKS_STORAGE_KEY] || [];
          if (localData.length > 0) {
            // 发现本地旧数据，执行迁移并清空本地存储
            chrome.storage.sync.set({ [BOOKMARKS_STORAGE_KEY]: localData }, () => {
              chrome.storage.local.remove(BOOKMARKS_STORAGE_KEY);
              resolve(localData);
            });
          } else {
            resolve([]);
          }
        });
      }
    });
  });
}

async function saveCustomBookmarks(bookmarks) {
  return new Promise((resolve) => {
    // 保存至同步存储区，所有登录了同一谷歌账号的设备会自动同步
    chrome.storage.sync.set({ [BOOKMARKS_STORAGE_KEY]: bookmarks }, async () => {
      await pushToNativeHost();
      resolve();
    });
  });
}

async function addCustomBookmark(url, title) {
  if (!url) return false;
  try {
    new URL(url);
  } catch {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    try { new URL(url); } catch { return false; }
  }

  const bookmarks = await getCustomBookmarks();
  const exists = bookmarks.some(b => b.url === url);
  if (exists) {
    showToast('Bookmark already exists');
    return false;
  }

  bookmarks.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    url: url,
    title: title || url,
    createdAt: Date.now(),
  });

  await saveCustomBookmarks(bookmarks);
  return true;
}

async function deleteCustomBookmark(url) {
  const bookmarks = await getCustomBookmarks();
  const filtered = bookmarks.filter(b => b.url !== url);
  if (filtered.length < bookmarks.length) {
    await saveCustomBookmarks(filtered);
    return true;
  }
  return false;
}

/**
 * 设置拖拽事件，实现纯 HTML5 拖拽上下排序
 */
let dragSourceEl = null;

function setupDragAndDrop() {
  const container = document.querySelector('#simple-card-bookmarks .mission-pages');
  if (!container) return;

  const chips = container.querySelectorAll('.bookmark-chip');
  chips.forEach((chip) => {
    chip.addEventListener('dragstart', (e) => {
      dragSourceEl = chip;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/html', chip.innerHTML);
      chip.classList.add('dragging');
    });

    chip.addEventListener('dragover', (e) => {
      e.preventDefault();
      return false;
    });

    chip.addEventListener('dragenter', (e) => {
      if (chip !== dragSourceEl) {
        chip.classList.add('drag-over');
      }
    });

    chip.addEventListener('dragleave', (e) => {
      chip.classList.remove('drag-over');
    });

    chip.addEventListener('drop', async (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (dragSourceEl !== chip) {
        const srcIndex = parseInt(dragSourceEl.dataset.index, 10);
        const targetIndex = parseInt(chip.dataset.index, 10);

        if (!isNaN(srcIndex) && !isNaN(targetIndex)) {
          const bookmarks = await getCustomBookmarks();
          // 移除源项
          const [moved] = bookmarks.splice(srcIndex, 1);
          // 插入到目标位置
          bookmarks.splice(targetIndex, 0, moved);

          // 保存最新顺序并实时同步
          await saveCustomBookmarks(bookmarks);
          await renderDashboard();
        }
      }
      return false;
    });

    chip.addEventListener('dragend', () => {
      chips.forEach((c) => {
        c.classList.remove('dragging');
        c.classList.remove('drag-over');
      });
    });
  });
}

/**
 * 设置书签专用的右键上下文菜单事件绑定
 */
function setupContextMenu() {
  const customMenu = document.getElementById('custom-context-menu');
  if (!customMenu) return;

  // 点击书签以外的任何地方隐藏菜单
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#custom-context-menu')) {
      customMenu.style.display = 'none';
    }
  });

  // 绑定“修改”功能
  const menuEdit = document.getElementById('menu-edit');
  if (menuEdit) {
    menuEdit.addEventListener('click', async () => {
      customMenu.style.display = 'none';
      if (activeContextBookmarkIndex !== null) {
        const bookmarks = await getCustomBookmarks();
        const item = bookmarks[activeContextBookmarkIndex];
        if (item) {
          isEditMode = true;
          const modal = document.getElementById('bookmarkModal');
          if (modal) {
            const modalHeader = modal.querySelector('h3');
            if (modalHeader) modalHeader.textContent = '修改书签';
            
            const modalUrl = document.getElementById('bookmarkModalUrl');
            const modalTitle = document.getElementById('bookmarkModalTitle');
            if (modalUrl) modalUrl.value = item.url;
            if (modalTitle) modalTitle.value = item.title;
            
            modal.style.display = 'flex';
            modalUrl.focus();
          }
        }
      }
    });
  }

  // 绑定“删除”功能
  const menuDelete = document.getElementById('menu-delete');
  if (menuDelete) {
    menuDelete.addEventListener('click', async () => {
      customMenu.style.display = 'none';
      if (activeContextBookmarkIndex !== null) {
        const bookmarks = await getCustomBookmarks();
        if (activeContextBookmarkIndex >= 0 && activeContextBookmarkIndex < bookmarks.length) {
          bookmarks.splice(activeContextBookmarkIndex, 1);
          await saveCustomBookmarks(bookmarks);
          showToast('书签已成功删除');
          playCloseSound();
          await renderDashboard();
          activeContextBookmarkIndex = null;
        }
      }
    });
  }

  // 右键事件全局拦截监听器（只处理书签卡片）
  document.addEventListener('contextmenu', (e) => {
    const bookmarkChip = e.target.closest('.bookmark-chip');
    if (bookmarkChip) {
      e.preventDefault();
      activeContextBookmarkIndex = parseInt(bookmarkChip.dataset.index, 10);
      
      customMenu.style.display = 'block';
      let x = e.pageX;
      let y = e.pageY;
      
      const menuWidth = 140;
      const menuHeight = 80;
      if (x + menuWidth > window.innerWidth) x -= menuWidth;
      if (y + menuHeight > window.innerHeight) y -= menuHeight;
      
      customMenu.style.left = `${x}px`;
      customMenu.style.top = `${y}px`;
    } else {
      customMenu.style.display = 'none';
    }
  });
}

function setupBookmarkButtons() {
  const addNewBtn = document.getElementById('addNewBookmarkBtn');
  const bookmarkModal = document.getElementById('bookmarkModal');
  const modalUrl = document.getElementById('bookmarkModalUrl');
  const modalTitle = document.getElementById('bookmarkModalTitle');
  const modalCancel = document.getElementById('bookmarkModalCancel');
  const modalSave = document.getElementById('bookmarkModalSave');

  if (addNewBtn && bookmarkModal) {
    addNewBtn.addEventListener('click', () => {
      isEditMode = false;
      const modalHeader = bookmarkModal.querySelector('h3');
      if (modalHeader) modalHeader.textContent = 'Add new bookmark';
      modalUrl.value = '';
      modalTitle.value = '';
      bookmarkModal.style.display = 'flex';
      modalUrl.focus();
    });

    const closeModal = () => {
      bookmarkModal.style.display = 'none';
    };

    modalCancel.addEventListener('click', closeModal);

    modalSave.addEventListener('click', async () => {
      const url = modalUrl.value.trim();
      const title = modalTitle.value.trim();
      
      if (!url) {
        showToast('URL is required');
        return;
      }
      
      if (isEditMode) {
        if (activeContextBookmarkIndex !== null) {
          const bookmarks = await getCustomBookmarks();
          bookmarks[activeContextBookmarkIndex] = { url, title: title || url };
          await saveCustomBookmarks(bookmarks);
          showToast('书签已成功修改');
          closeModal();
          await renderDashboard();
          activeContextBookmarkIndex = null;
        }
      } else {
        const success = await addCustomBookmark(url, title);
        if (success) {
          showToast('Bookmark added successfully');
          closeModal();
          await renderStaticDashboard();
        } else {
          showToast('Failed to add bookmark');
        }
      }
    });
    
    // Allow pressing Enter to save
    [modalUrl, modalTitle].forEach(el => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          modalSave.click();
        }
      });
    });
  }

  // 初始化绑定书签卡片的右键上下文菜单
  setupContextMenu();
}

/* ----------------------------------------------------------------
   SEARCH FUNCTIONS
   ---------------------------------------------------------------- */

function performSearch(query) {
  const engine = document.getElementById('searchEngine').value;
  let url = '';
  
  switch (engine) {
    case 'google':
      url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      break;
    case 'bing':
      url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      break;
    case 'baidu':
      url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
      break;
    default:
      url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  }
  
  chrome.tabs.create({ url });
}

function setupSearchHandlers() {
  const searchInput = document.getElementById('searchInput');
  const searchBtn = document.getElementById('searchBtn');
  const tabSearchInput = document.getElementById('tabSearchInput');
  
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      const query = searchInput?.value.trim();
      if (query) performSearch(query);
    });
  }
  
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const query = searchInput.value.trim();
        if (query) performSearch(query);
      }
    });
  }
  
  let searchDebounceTimeout = null;
  if (tabSearchInput) {
    tabSearchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      if (searchDebounceTimeout) clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = setTimeout(() => {
        filterTabs(query);
      }, 300);
    });
  }
}

function filterTabs(query) {
  const missionCards = document.querySelectorAll('.mission-card');
  
  missionCards.forEach(card => {
    if (!query) {
      card.style.display = 'block';
      card.querySelectorAll('.page-chip').forEach(chip => {
        if (!chip.classList.contains('page-chip-overflow')) {
          chip.style.display = 'flex';
        }
      });
      card.querySelectorAll('.page-chips-overflow').forEach(container => container.style.display = 'none');
      card.querySelectorAll('.page-chip-overflow').forEach(btn => btn.style.display = 'flex');
      return;
    }
    
    let cardMatchesTitle = false;
    const missionName = card.querySelector('.mission-name');
    if (missionName && missionName.textContent.toLowerCase().includes(query)) {
      cardMatchesTitle = true;
    }
    
    const pageChips = card.querySelectorAll('.page-chip:not(.page-chip-overflow)');
    let anyChipVisible = false;
    
    pageChips.forEach(chip => {
      const textContent = (chip.querySelector('.chip-text')?.textContent || '').toLowerCase();
      const tabUrl = (chip.dataset.tabUrl || '').toLowerCase();
      const tabTitle = (chip.getAttribute('title') || '').toLowerCase();
      
      const matches = cardMatchesTitle || textContent.includes(query) || tabUrl.includes(query) || tabTitle.includes(query);
      
      if (matches) {
        chip.style.display = 'flex';
        anyChipVisible = true;
      } else {
        chip.style.display = 'none';
      }
    });

    // 搜索时自动展开被折叠的内容，保证所有匹配的都能看到
    const overflowContainer = card.querySelector('.page-chips-overflow');
    const expandBtn = card.querySelector('.page-chip-overflow');
    if (overflowContainer) overflowContainer.style.display = 'contents';
    if (expandBtn) expandBtn.style.display = 'none';
    
    if (anyChipVisible || cardMatchesTitle) {
      card.style.display = 'block';
    } else {
      card.style.display = 'none';
    }
  });
}

/* ----------------------------------------------------------------
   INITIALIZATION
   ---------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  setupNativePort();
  renderDashboard();
  setupSearchHandlers();
  setupBookmarkButtons();

  // History排序按钮
  const historySortBtn = document.getElementById('historySortBtn');
  if (historySortBtn) {
    historySortBtn.addEventListener('click', async () => {
      historySortOrder = historySortOrder === 'time-desc' ? 'time-asc' : 'time-desc';
      const label = document.getElementById('historySortLabel');
      if (label) label.textContent = historySortOrder === 'time-desc' ? '最新' : '最早';
      await renderStaticDashboard();
    });
  }

  // Saved for later 排序按钮
  const savedTabsSortBtn = document.getElementById('savedTabsSortBtn');
  if (savedTabsSortBtn) {
    savedTabsSortBtn.addEventListener('click', async () => {
      savedTabsSortOrder = savedTabsSortOrder === 'time-desc' ? 'time-asc' : 'time-desc';
      const label = document.getElementById('savedTabsSortLabel');
      if (label) label.textContent = savedTabsSortOrder === 'time-desc' ? '最新' : '最早';
      await renderStaticDashboard();
    });
  }

  // History条目点击 → 打开新标签
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action="open-history-url"]');
    if (el) {
      if (e.target.closest('[data-action="delete-history-item"]')) {
        return;
      }
      const url = el.dataset.tabUrl;
      if (url) chrome.tabs.create({ url });
    }
  });

  // Data Backup
  const exportDataBtn = document.getElementById('exportDataBtn');
  if (exportDataBtn) {
    exportDataBtn.addEventListener('click', async () => {
      try {
        const bookmarks = await getCustomBookmarks();
        const deferred = await getDeferred();
        const data = {
          bookmarks,
          deferred,
          exportedAt: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tab-out-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Backup downloaded');
      } catch (err) {
        console.error('Export failed:', err);
        showToast('Export failed');
      }
    });
  }

  // Data Restore
  const importDataBtn = document.getElementById('importDataBtn');
  const importDataInput = document.getElementById('importDataInput');
  if (importDataBtn && importDataInput) {
    importDataBtn.addEventListener('click', () => {
      importDataInput.click();
    });
    importDataInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const content = event.target.result;
          const data = JSON.parse(content);
          
          if (data.bookmarks && Array.isArray(data.bookmarks)) {
            const existingBookmarks = await getCustomBookmarks();
            const mergedBookmarks = [...existingBookmarks];
            for (const b of data.bookmarks) {
              if (!mergedBookmarks.some(eb => eb.url === b.url)) {
                mergedBookmarks.push(b);
              }
            }
            await saveCustomBookmarks(mergedBookmarks);
          }
          
          if (data.deferred && Array.isArray(data.deferred)) {
            const existingDeferred = await getDeferred();
            const mergedDeferred = [...existingDeferred];
            for (const d of data.deferred) {
              if (!mergedDeferred.some(ed => ed.url === d.url && ed.savedAt === d.savedAt)) {
                mergedDeferred.push(d);
              }
            }
            await setDeferred(mergedDeferred);
          }
          
          showToast('Restore completed');
          await renderDashboard();
        } catch (err) {
          console.error('Import failed:', err);
          showToast('Invalid backup file');
        } finally {
          importDataInput.value = '';
        }
      };
      reader.readAsText(file);
    });
  }

  // --- 实时监听标签页变化，自动刷新控制台 ---
  let refreshTimer = null;
  function debouncedRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      renderDashboard();
    }, 300);
  }

  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener(debouncedRefresh);
  }
  if (chrome.tabs && chrome.tabs.onCreated) {
    chrome.tabs.onCreated.addListener(debouncedRefresh);
  }
  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      // 仅在页面加载完成时刷新，避免加载过程中频繁触发
      if (changeInfo.status === 'complete') {
        debouncedRefresh();
      }
    });
  }
});