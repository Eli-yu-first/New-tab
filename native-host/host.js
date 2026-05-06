#!/usr/bin/env node
'use strict';

/**
 * Native Messaging Host — 跨浏览器数据同步
 *
 * 通过 Chrome Native Messaging 协议，在本地文件系统中读写
 * 一个共享 JSON 文件（~/.newtab_sync/data.json），
 * 使同一台电脑上不同浏览器中的 New Tab 扩展共享
 * Bookmarks 和 Saved for later 数据。
 *
 * 协议：stdin/stdout，4 字节 LE 长度前缀 + UTF-8 JSON
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

// ── Native Messaging 协议 ────────────────────────────────────────

function readNativeMessage() {
  const lengthBuf = Buffer.alloc(4);
  let offset = 0;
  while (offset < 4) {
    const n = fs.readSync(0, lengthBuf, offset, 4 - offset, null);
    if (n === 0) process.exit(0);
    offset += n;
  }
  const length = lengthBuf.readUInt32LE(0);

  const msgBuf = Buffer.alloc(length);
  offset = 0;
  while (offset < length) {
    const n = fs.readSync(0, msgBuf, offset, length - offset, null);
    if (n === 0) process.exit(0);
    offset += n;
  }
  return JSON.parse(msgBuf.toString('utf8'));
}

function sendNativeMessage(msg) {
  const json = JSON.stringify(msg);
  const length = Buffer.byteLength(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(length, 0);
  process.stdout.write(header);
  process.stdout.write(json, 'utf8');
}

// ── 主流程 ────────────────────────────────────────────────────────

try {
  const msg = readNativeMessage();

  switch (msg.action) {
    case 'read':
      sendNativeMessage({ success: true, data: readData() });
      break;
    case 'write':
      writeData(msg.data);
      sendNativeMessage({ success: true });
      break;
    case 'ping':
      sendNativeMessage({ success: true, version: '1.0.0' });
      break;
    default:
      sendNativeMessage({ success: false, error: 'Unknown action: ' + msg.action });
  }
} catch (err) {
  try {
    sendNativeMessage({ success: false, error: err.message });
  } catch {
    process.exit(1);
  }
}
