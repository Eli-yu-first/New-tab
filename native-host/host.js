#!/usr/bin/env node
'use strict';

/**
 * Native Messaging Host — 跨浏览器数据同步（常驻监听广播版）
 *
 * 通过 Chrome Native Messaging 协议，在本地文件系统中读写
 * 一个共享 JSON 文件（~/.newtab_sync/data.json）。
 * 
 * 增加文件状态监听功能：当任何一个浏览器实例改写该共享文件时，
 * 主动通过长连接向其它所有打开的扩展页面广播通知，实现真正免刷新的实时同步。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.newtab_sync');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const CLOSE_REQUEST_TTL_MS = 5 * 60 * 1000;
const HISTORY_DELETION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function emptyData() {
  return {
    bookmarks: [],
    deferred: [],
    savedTabGroups: [],
    openTabs: {},
    history: [],
    historyDeletions: [],
    closeRequests: [],
  };
}

function normalizeData(data) {
  const source = data && typeof data === 'object' ? data : {};
  const openTabs = {};

  if (source.openTabs && typeof source.openTabs === 'object' && !Array.isArray(source.openTabs)) {
    for (const [browser, tabs] of Object.entries(source.openTabs)) {
      if (Array.isArray(tabs)) openTabs[browser] = tabs;
    }
  }

  const now = Date.now();
  const historyDeletions = Array.isArray(source.historyDeletions)
    ? source.historyDeletions.filter(deletion =>
      deletion &&
      typeof deletion.id === 'string' &&
      typeof deletion.url === 'string' &&
      Number.isFinite(deletion.createdAt) &&
      now - deletion.createdAt < HISTORY_DELETION_TTL_MS
    )
    : [];
  const closeRequests = Array.isArray(source.closeRequests)
    ? source.closeRequests.filter(request =>
      request &&
      typeof request.id === 'string' &&
      typeof request.browser === 'string' &&
      typeof request.url === 'string' &&
      Number.isFinite(request.createdAt) &&
      now - request.createdAt < CLOSE_REQUEST_TTL_MS
    )
    : [];

  return {
    bookmarks: Array.isArray(source.bookmarks) ? source.bookmarks : [],
    deferred: Array.isArray(source.deferred) ? source.deferred : [],
    savedTabGroups: Array.isArray(source.savedTabGroups)
      ? source.savedTabGroups.filter(group =>
        group && typeof group.id === 'string' && typeof group.name === 'string'
      )
      : [],
    openTabs,
    history: Array.isArray(source.history) ? source.history : [],
    historyDeletions,
    closeRequests,
  };
}

// ── 数据读写 ──────────────────────────────────────────────────────

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyData();
    const content = fs.readFileSync(DATA_FILE, 'utf8');
    return normalizeData(JSON.parse(content));
  } catch {
    return emptyData();
  }
}

function writeData(data) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const safeData = normalizeData(data);
  safeData.lastModified = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(safeData, null, 2), 'utf8');
}

function updateData(update) {
  const current = readData();
  const next = normalizeData(update(current) || current);
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  writeData(next);
  // Notify the initiating extension immediately. The file watcher still
  // propagates the same change to host processes owned by other browsers.
  sendNativeMessage({ event: 'changed', data: next });
  return true;
}

function mergeHistory(existing, incoming, historyDeletions = []) {
  const deletedUrls = new Set(historyDeletions.map(deletion => deletion.url));
  const byUrl = new Map();
  for (const item of [...existing, ...incoming]) {
    if (!item || typeof item.url !== 'string' || !item.url || deletedUrls.has(item.url)) continue;
    const prior = byUrl.get(item.url);
    if (!prior || (item.lastVisitTime || 0) >= (prior.lastVisitTime || 0)) {
      byUrl.set(item.url, item);
    }
  }
  return Array.from(byUrl.values())
    .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0))
    .slice(0, 500);
}

// ── 实时文件监听广播 ──────────────────────────────────────────────

let watcher = null;
function startWatching() {
  if (watcher) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
      writeData({ bookmarks: [], deferred: [], savedTabGroups: [] });
    }

    let watchTimeout = null;
    const broadcastChange = () => {
      if (watchTimeout) clearTimeout(watchTimeout);
      watchTimeout = setTimeout(() => {
        try {
          // 主动向客户端广播文件已被改变的最新数据
          sendNativeMessage({ event: 'changed', data: readData() });
        } catch (e) {
          // 如果管道断开，安全退出进程
          process.exit(0);
        }
      }, 80); // 80ms 防抖，避免多开页面时高频触发
    };

    // Native hosts run in separate browser-owned processes. fs.watch is not
    // reliable for observing writes made by another one of those processes on
    // macOS, so use Node's stat-based watcher for deterministic cross-browser
    // propagation.
    fs.watchFile(DATA_FILE, { interval: 250 }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
        broadcastChange();
      }
    });
    watcher = { close: () => fs.unwatchFile(DATA_FILE) };
  } catch (err) {
    setTimeout(startWatching, 1000);
  }
}

// ── Native Messaging 协议发送 ─────────────────────────────────────

function sendNativeMessage(msg) {
  const json = JSON.stringify(msg);
  const length = Buffer.byteLength(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(length, 0);
  process.stdout.write(header);
  process.stdout.write(json, 'utf8');
}

function handleMessage(msg) {
  switch (msg.action) {
    case 'read':
      sendNativeMessage({ success: true, data: readData() });
      break;
    case 'write':
      updateData(data => ({
        ...data,
        bookmarks: Array.isArray(msg.data && msg.data.bookmarks) ? msg.data.bookmarks : data.bookmarks,
        deferred: Array.isArray(msg.data && msg.data.deferred) ? msg.data.deferred : data.deferred,
        savedTabGroups: Array.isArray(msg.data && msg.data.savedTabGroups)
          ? msg.data.savedTabGroups
          : data.savedTabGroups,
      }));
      break;
    case 'writeOpenTabs':
      if (typeof msg.browser !== 'string' || !Array.isArray(msg.tabs)) {
        sendNativeMessage({ success: false, error: 'Invalid open tabs payload' });
        break;
      }
      updateData(data => ({
        ...data,
        openTabs: { ...data.openTabs, [msg.browser]: msg.tabs },
      }));
      break;
    case 'writeHistory':
      if (!Array.isArray(msg.history)) {
        sendNativeMessage({ success: false, error: 'Invalid history payload' });
        break;
      }
      updateData(data => ({
        ...data,
        history: mergeHistory(data.history, msg.history, data.historyDeletions),
      }));
      break;
    case 'deleteHistory':
      if (typeof msg.url !== 'string' || !msg.url) {
        sendNativeMessage({ success: false, error: 'Invalid history deletion payload' });
        break;
      }
      updateData(data => ({
        ...data,
        history: data.history.filter(item => item.url !== msg.url),
        historyDeletions: [
          ...data.historyDeletions.filter(deletion => deletion.url !== msg.url),
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            url: msg.url,
            createdAt: Date.now(),
          },
        ],
      }));
      break;
    case 'requestCloseTab':
      if (typeof msg.browser !== 'string' || typeof msg.url !== 'string' || !msg.url) {
        sendNativeMessage({ success: false, error: 'Invalid close tab payload' });
        break;
      }
      updateData(data => ({
        ...data,
        closeRequests: [...data.closeRequests, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          browser: msg.browser,
          url: msg.url,
          createdAt: Date.now(),
        }],
      }));
      break;
    case 'ping':
      sendNativeMessage({ success: true, version: '1.2.0' });
      break;
    default:
      sendNativeMessage({ success: false, error: 'Unknown action: ' + msg.action });
  }
}

// ── 标准输入流缓冲与流式粘包解析 ────────────────────────────────────

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLength = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length >= 4 + msgLength) {
      const msgBody = inputBuffer.slice(4, 4 + msgLength);
      inputBuffer = inputBuffer.slice(4 + msgLength);

      try {
        const msg = JSON.parse(msgBody.toString('utf8'));
        handleMessage(msg);
      } catch (err) {
        sendNativeMessage({ success: false, error: 'JSON parse error: ' + err.message });
      }
    } else {
      break; // 缓冲的数据还不够一个完整的数据包，等待下一次读取
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

process.stdin.on('error', () => {
  process.exit(0);
});

// ── 启动运行 ──────────────────────────────────────────────────────

// 启动文件实时监听
startWatching();

// 启动时自动向建立长连接的浏览器客户端推送一次当前最新数据
try {
  sendNativeMessage({ event: 'changed', data: readData() });
} catch (e) {
  process.exit(0);
}
