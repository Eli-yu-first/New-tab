#!/usr/bin/env node
'use strict';

/**
 * Native Messaging Host — 跨浏览器数据同步（常驻监听版）
 *
 * 通过 Chrome Native Messaging 协议，在本地文件系统中读写
 * 一个共享 JSON 文件（~/.newtab_sync/data.json）。
 * 
 * 增加 fs.watch 文件监听功能：当任何一个浏览器实例改写该共享文件时，
 * 主动通过长连接向其它所有打开的扩展页面广播通知，实现真正免刷新的实时同步。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.newtab_sync');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// ── 数据读写 ──────────────────────────────────────────────────────

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { bookmarks: [], deferred: [] };
    const content = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(content);
    return {
      bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [],
      deferred: Array.isArray(data.deferred) ? data.deferred : [],
    };
  } catch {
    return { bookmarks: [], deferred: [] };
  }
}

function writeData(data) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const safeData = {
    bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [],
    deferred: Array.isArray(data.deferred) ? data.deferred : [],
    lastModified: new Date().toISOString(),
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(safeData, null, 2), 'utf8');
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
      writeData({ bookmarks: [], deferred: [] });
    }

    let watchTimeout = null;
    watcher = fs.watch(DATA_FILE, (eventType) => {
      if (watchTimeout) clearTimeout(watchTimeout);
      watchTimeout = setTimeout(() => {
        try {
          // 主动向客户端广播文件已被改变的事件
          sendNativeMessage({ event: 'changed' });
        } catch (e) {
          // 如果管道断开，安全退出进程
          process.exit(0);
        }
      }, 100); // 100ms 防抖，避免写入时的多次高频事件
    });

    watcher.on('error', () => {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      setTimeout(startWatching, 500); // 出错时半秒后自动重连监听
    });
  } catch (err) {
    setTimeout(startWatching, 1000);
  }
}

// ── Native Messaging 协议与粘包解析 ────────────────────────────────

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
      writeData(msg.data);
      sendNativeMessage({ success: true });
      break;
    case 'ping':
      sendNativeMessage({ success: true, version: '1.1.0' });
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
