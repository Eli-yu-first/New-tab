'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const backgroundSource = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background.js'),
  'utf8'
);

function loadBackground({ tabs, allowDuplicateTabs = false }) {
  const listeners = {};
  const calls = { removed: [], updated: [], windows: [] };
  const chrome = {
    runtime: {
      id: 'test-extension-id',
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    storage: { local: { get: async () => ({ allowDuplicateTabs }) } },
    windows: { update: async (id, options) => calls.windows.push([id, options]) },
    tabs: {
      query: async () => tabs,
      update: async (id, options) => calls.updated.push([id, options]),
      remove: async id => calls.removed.push(id),
      onCreated: { addListener(listener) { listeners.created = listener; } },
      onRemoved: { addListener(listener) { listeners.removed = listener; } },
      onUpdated: { addListener(listener) { listeners.updated = listener; } },
    },
  };

  vm.runInNewContext(backgroundSource, { chrome, console });
  return { calls, listeners };
}

test('a newly created blank tab is never removed before a link receives its URL', async () => {
  const { calls, listeners } = loadBackground({
    tabs: [{ id: 1, url: 'chrome-extension://test-extension-id/index.html', windowId: 4 }],
  });

  listeners.created({ id: 2, url: '', pendingUrl: '', windowId: 4 });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls.removed, []);
});

test('a duplicate New Tab page focuses the existing page after its final URL is known', async () => {
  const tabs = [
    { id: 1, url: 'chrome-extension://test-extension-id/index.html', windowId: 4 },
    { id: 2, url: 'chrome-extension://test-extension-id/index.html', windowId: 4 },
  ];
  const { calls, listeners } = loadBackground({ tabs });

  await listeners.updated(2, { url: tabs[1].url }, tabs[1]);

  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0][0], 1);
  assert.equal(calls.updated[0][1].active, true);
  assert.equal(calls.windows.length, 1);
  assert.equal(calls.windows[0][0], 4);
  assert.equal(calls.windows[0][1].focused, true);
  assert.deepEqual(calls.removed, [2]);
});

test('a link opening in a new tab is not redirected while its destination is pending', async () => {
  const tabs = [
    { id: 1, url: 'chrome-extension://test-extension-id/index.html', windowId: 4 },
    {
      id: 2,
      url: 'chrome-extension://test-extension-id/index.html',
      pendingUrl: 'https://example.test/article',
      openerTabId: 9,
      windowId: 4,
    },
  ];
  const { calls, listeners } = loadBackground({ tabs });

  await listeners.updated(2, { url: tabs[1].url }, tabs[1]);

  assert.deepEqual(calls.updated, []);
  assert.deepEqual(calls.windows, []);
  assert.deepEqual(calls.removed, []);
});

test('a link-created tab is not redirected even before Chrome exposes its pending URL', async () => {
  const tabs = [
    { id: 1, url: 'chrome-extension://test-extension-id/index.html', windowId: 4 },
    {
      id: 2,
      url: 'chrome-extension://test-extension-id/index.html',
      pendingUrl: '',
      openerTabId: 9,
      windowId: 4,
    },
  ];
  const { calls, listeners } = loadBackground({ tabs });

  await listeners.updated(2, { url: tabs[1].url }, tabs[1]);

  assert.deepEqual(calls.updated, []);
  assert.deepEqual(calls.windows, []);
  assert.deepEqual(calls.removed, []);
});

test('a normal URL containing the extension ID is not mistaken for a New Tab page', async () => {
  const tabs = [
    { id: 1, url: 'chrome-extension://test-extension-id/index.html', windowId: 4 },
    { id: 2, url: 'https://example.test/test-extension-id', windowId: 4 },
  ];
  const { calls, listeners } = loadBackground({ tabs });

  await listeners.updated(2, { url: tabs[1].url }, tabs[1]);

  assert.deepEqual(calls.removed, []);
});
