'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'app.js'), 'utf8');

function loadHistoryHelpers(historyItems) {
  const deletedUrls = [];
  const context = {
    URL,
    console,
    setTimeout,
    clearTimeout,
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    navigator: { userAgent: 'Chrome' },
    chrome: {
      runtime: { id: 'test-extension' },
      history: {
        search: async () => historyItems,
        deleteUrl: async ({ url }) => deletedUrls.push(url),
      },
    },
  };

  vm.runInNewContext(`${appSource}\nglobalThis.__historyTest = {
    deleteHistoryItem,
    getHistoryItems,
    processHistoryDeletions,
    setSharedNativeData(data) { sharedNativeData = data; },
  };`, context);

  return { helpers: context.__historyTest, deletedUrls };
}

test('a deleted history URL stays hidden even when it remains in shared history data', async () => {
  const url = 'https://example.test/article';
  const { helpers, deletedUrls } = loadHistoryHelpers([
    { url, title: 'Article', lastVisitTime: 100, visitCount: 1 },
  ]);
  helpers.setSharedNativeData({
    bookmarks: [],
    deferred: [],
    openTabs: {},
    history: [{ url, title: 'Article', lastVisitTime: 100, visitCount: 1 }],
    historyDeletions: [],
  });

  await helpers.deleteHistoryItem(url);

  assert.deepEqual(deletedUrls, [url]);
  assert.equal((await helpers.getHistoryItems()).length, 0);
});

test('a synchronized history deletion removes the URL from the receiving browser', async () => {
  const url = 'https://example.test/remote';
  const { helpers, deletedUrls } = loadHistoryHelpers([
    { url, title: 'Remote', lastVisitTime: 100, visitCount: 1 },
  ]);

  await helpers.processHistoryDeletions([{ id: 'delete-1', url, createdAt: Date.now() }]);

  assert.deepEqual(deletedUrls, [url]);
  assert.equal((await helpers.getHistoryItems()).length, 0);
});
