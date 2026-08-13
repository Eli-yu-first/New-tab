'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'extension', 'index.html'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'style.css'), 'utf8');

function loadApp({ deferred = [], groups = [], tabs = [], bookmarks = [], fetchImpl, geolocation } = {}) {
  const syncData = {
    deferred,
    tabOut_savedTabGroups: groups,
    tabOut_customBookmarks: bookmarks,
  };
  const writes = [];
  const tabCalls = { created: [], updated: [], focusedWindows: [] };
  const context = {
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    navigator: { userAgent: 'Chrome', geolocation },
    fetch: fetchImpl,
    window: {},
    chrome: {
      runtime: { id: 'test-extension' },
      tabs: {
        query: async () => tabs,
        create: async value => { tabCalls.created.push(value); },
        update: async (id, value) => { tabCalls.updated.push([id, value]); },
      },
      windows: {
        getCurrent: async () => ({ id: 1 }),
        update: async (id, value) => { tabCalls.focusedWindows.push([id, value]); },
      },
      storage: {
        sync: {
          get: (keys, callback) => {
            const result = typeof keys === 'string'
              ? { [keys]: syncData[keys] }
              : Array.isArray(keys)
                ? Object.fromEntries(keys.map(key => [key, syncData[key]]))
                : { ...syncData };
            if (callback) callback(result);
            return Promise.resolve(result);
          },
          set: (value, callback) => {
            Object.assign(syncData, value);
            writes.push(value);
            if (callback) callback();
            return Promise.resolve();
          },
        },
        local: {
          get: (keys, callback) => {
            const result = typeof keys === 'string' ? { [keys]: [] } : {};
            if (callback) callback(result);
            return Promise.resolve(result);
          },
          set: async () => {},
          remove: async () => {},
        },
      },
    },
  };

  vm.runInNewContext(`${appSource}\nglobalThis.__featureTest = {
    findTabSearchMatches,
    buildTabSearchCandidates,
    getSearchResultFaviconUrl,
    getSearchSourceMeta,
    isImeComposing,
    formatDashboardClock,
    getEffectiveClockTimeZone,
    isDashboardWeatherCacheFresh,
    getDashboardWeatherPresentation,
    formatDashboardTemperatureRange,
    fetchDashboardWeather,
    getBookmarkUsageTag,
    renderSimpleCard,
    addCustomBookmark,
    shouldDismissTabSearchResults,
    renderHistoryCard,
    buildSavedTabGroups,
    createSavedTabGroup,
    moveSavedTabToGroup,
    bookmarkOpenTab,
    focusTab,
  };`, context);

  return { helpers: context.__featureTest, syncData, writes, tabCalls };
}

test('tab search matches title, full URL, and domain with separated fuzzy terms', () => {
  const { helpers } = loadApp();
  const tabs = [
    { id: 1, title: 'Deploy checklist', url: 'https://github.com/acme/repository' },
    { id: 2, title: 'Design notes', url: 'https://docs.example.test/architecture' },
  ];

  const matches = helpers.findTabSearchMatches('git deploy', tabs);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 1);
});

test('dashboard columns place bookmarks before history and saved-for-later', () => {
  const openTabsIndex = indexHtml.indexOf('id="openTabsSection"');
  const bookmarksIndex = indexHtml.indexOf('id="bookmarksSection"');
  const historyIndex = indexHtml.indexOf('id="frequentTabsSection"');
  const savedTabsIndex = indexHtml.indexOf('id="savedTabsSection"');

  assert.ok(openTabsIndex < bookmarksIndex);
  assert.ok(bookmarksIndex < historyIndex);
  assert.ok(historyIndex < savedTabsIndex);
});

test('tab-search suggestions dismiss only when clicking outside their shell', () => {
  const { helpers } = loadApp();
  const inside = {};
  const outside = {};
  const shell = { contains: target => target === inside };

  assert.equal(helpers.shouldDismissTabSearchResults(inside, shell), false);
  assert.equal(helpers.shouldDismissTabSearchResults(outside, shell), true);
  assert.equal(helpers.shouldDismissTabSearchResults(outside, null), false);
});

test('dashboard clock renders two-line date and time in the selected time zone', () => {
  const { helpers } = loadApp();
  const clock = helpers.formatDashboardClock(new Date('2026-08-13T00:05:06.000Z'), 'Asia/Shanghai');

  assert.equal(clock.date, '2026年08月13日');
  assert.equal(clock.time, '08:05:06');
  assert.equal(clock.timeZone, 'Asia/Shanghai');
});

test('dashboard clock uses the system time zone for automatic and invalid settings', () => {
  const { helpers } = loadApp();
  const systemTimeZone = helpers.getEffectiveClockTimeZone('auto');

  assert.equal(helpers.getEffectiveClockTimeZone('not/a-time-zone'), systemTimeZone);
});

test('dashboard weather cache is valid only for the same local day and six-hour window', () => {
  const { helpers } = loadApp();
  const cache = {
    weatherCode: 0,
    minTemperature: 23.2,
    maxTemperature: 31.8,
    timeZone: 'Asia/Shanghai',
    dateKey: '2026-08-13',
    fetchedAt: new Date('2026-08-13T00:00:00.000Z').getTime(),
  };

  assert.equal(helpers.isDashboardWeatherCacheFresh(cache, new Date('2026-08-13T05:59:59.000Z')), true);
  assert.equal(helpers.isDashboardWeatherCacheFresh(cache, new Date('2026-08-13T06:00:00.000Z')), false);
  assert.equal(helpers.isDashboardWeatherCacheFresh(cache, new Date('2026-08-13T16:00:00.000Z')), false);
});

test('dashboard weather maps weather codes and formats compact temperature ranges', () => {
  const { helpers } = loadApp();

  assert.equal(helpers.getDashboardWeatherPresentation(0).icon, '\u2600');
  assert.equal(helpers.getDashboardWeatherPresentation(63).icon, '\u2614');
  assert.equal(helpers.getDashboardWeatherPresentation(95).icon, '\u26a1');
  assert.equal(helpers.formatDashboardTemperatureRange(23.2, 31.8), '23\u00b0 - 32\u00b0');
  assert.equal(helpers.formatDashboardTemperatureRange(undefined, 31.8), '--\u00b0 - --\u00b0');
});

test('dashboard weather falls back to IP location when browser geolocation is unavailable', async () => {
  const requests = [];
  const { helpers } = loadApp({
    geolocation: {
      getCurrentPosition(_resolve, reject) {
        reject(new Error('Location denied'));
      },
    },
    fetchImpl: async url => {
      const requestUrl = String(url);
      requests.push(requestUrl);
      if (requestUrl === 'https://ipinfo.io/json') {
        return {
          ok: true,
          json: async () => ({ loc: '31.2304,121.4737' }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          timezone: 'Asia/Shanghai',
          daily: {
            weather_code: [2],
            temperature_2m_min: [24.4],
            temperature_2m_max: [32.1],
          },
        }),
      };
    },
  });

  const weather = await helpers.fetchDashboardWeather();

  assert.equal(weather.weatherCode, 2);
  assert.equal(weather.minTemperature, 24.4);
  assert.equal(weather.maxTemperature, 32.1);
  assert.equal(requests[0], 'https://ipinfo.io/json');
  assert.match(requests[1], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.match(requests[1], /latitude=31.2304/);
  assert.match(requests[1], /longitude=121.4737/);
});

test('bookmark usage labels are rendered only from the saved usage level', () => {
  const { helpers } = loadApp();
  const items = [
    { title: 'Github', url: 'https://github.com/Eli-yu-first/New-tab', usageLevel: 'frequent' },
    { title: 'ChatGPT', url: 'https://chatgpt.com/', usageLevel: 'medium' },
    { title: '豆包', url: 'https://www.doubao.com/', usageLevel: 'low' },
    { title: 'Project repository', url: 'https://example.test/project' },
  ];
  const bookmarksMarkup = helpers.renderSimpleCard('Bookmarks', items, 'bookmarks');

  assert.match(bookmarksMarkup, /bookmark-usage-frequent">常用/);
  assert.match(bookmarksMarkup, /bookmark-usage-medium">中等/);
  assert.match(bookmarksMarkup, /bookmark-usage-low">较少/);
  assert.equal((bookmarksMarkup.match(/bookmark-usage-tag/g) || []).length, 3);
  assert.equal(helpers.getBookmarkUsageTag(items.at(-1).usageLevel), null);
  assert.doesNotMatch(
    helpers.renderSimpleCard('History', items, 'history'),
    /bookmark-common-tag/
  );
});

test('tab search ranks a title match ahead of a URL-only match', () => {
  const { helpers } = loadApp();
  const matches = helpers.findTabSearchMatches('project', [
    { id: 1, title: 'Project dashboard', url: 'https://example.test/overview' },
    { id: 2, title: 'Overview', url: 'https://example.test/project' },
  ]);

  assert.deepEqual(Array.from(matches, tab => tab.id), [1, 2]);
});

test('tab search recommends matching history and bookmarks alongside open tabs', () => {
  const { helpers } = loadApp();
  const candidates = helpers.buildTabSearchCandidates({
    tabs: [{ id: 1, title: 'Project dashboard', url: 'https://app.example.test/project' }],
    history: [{ title: 'Project deploy guide', url: 'https://docs.example.test/deploy', lastVisitTime: 50 }],
    bookmarks: [{ title: 'Project repository', url: 'https://github.com/acme/project' }],
  });
  const matches = helpers.findTabSearchMatches('project', candidates);

  assert.equal(matches.length, 3);
  assert.deepEqual(
    Array.from(matches, item => item.searchSources[0]).sort(),
    ['bookmark', 'history', 'open']
  );
});

test('tab-search sorts open tabs, bookmarks, then recent history with distinct source metadata', () => {
  const { helpers } = loadApp();
  const matches = helpers.findTabSearchMatches('project', helpers.buildTabSearchCandidates({
    tabs: [{ id: 1, title: 'Project open', url: 'https://open.example.test/project' }],
    bookmarks: [{ title: 'Project bookmark', url: 'https://bookmark.example.test/project' }],
    history: [
      { title: 'Project old history', url: 'https://history.example.test/old-project', lastVisitTime: 10 },
      { title: 'Project recent history', url: 'https://history.example.test/recent-project', lastVisitTime: 20 },
    ],
  }));

  assert.deepEqual(Array.from(matches, item => item.searchSources[0]), ['open', 'bookmark', 'history', 'history']);
  assert.equal(matches[2].title, 'Project recent history');
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.getSearchSourceMeta(['open']))),
    { label: '打开标签', className: 'tab-search-source-open', rank: 3 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.getSearchSourceMeta(['bookmark']))),
    { label: '收藏', className: 'tab-search-source-bookmark', rank: 2 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.getSearchSourceMeta(['history']))),
    { label: '历史', className: 'tab-search-source-history', rank: 1 }
  );
});

test('history groups keep all records in an internal scroll container', () => {
  const { helpers } = loadApp();
  const items = Array.from({ length: 10 }, (_, index) => ({
    title: `History ${index}`,
    url: `https://history.example.test/${index}`,
    lastVisitTime: Date.now() - index * 1000,
  }));
  const markup = helpers.renderHistoryCard('今天', items, 'today');

  assert.equal((markup.match(/history-chip/g) || []).length, 10);
  assert.match(markup, /history-group-scroll/);
  assert.doesNotMatch(markup, /page-chip-overflow/);
  assert.match(styleSource, /\.history-group-scroll\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test('tab search candidates merge duplicate URLs and preserve all sources', () => {
  const { helpers } = loadApp();
  const candidates = helpers.buildTabSearchCandidates({
    tabs: [{ id: 1, title: 'Project', url: 'https://example.test/project' }],
    history: [{ title: 'Project', url: 'https://example.test/project' }],
    bookmarks: [{ title: 'Project', url: 'https://example.test/project' }],
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(Array.from(candidates[0].searchSources), ['open', 'history', 'bookmark']);
});

test('search results reuse a tab favicon and otherwise derive one from the domain', () => {
  const { helpers } = loadApp();

  assert.equal(
    helpers.getSearchResultFaviconUrl({ url: 'https://github.com/acme/project', favIconUrl: 'https://assets.example.test/github.png' }),
    'https://assets.example.test/github.png'
  );
  assert.equal(
    helpers.getSearchResultFaviconUrl({ url: 'https://github.com/acme/project' }),
    'https://www.google.com/s2/favicons?domain=github.com&sz=32'
  );
  assert.equal(helpers.getSearchResultFaviconUrl({ url: 'not a URL' }), '');
});

test('IME composition Enter is not treated as a search submission', () => {
  const { helpers } = loadApp();

  assert.equal(helpers.isImeComposing({ isComposing: true, key: 'Enter' }), true);
  assert.equal(helpers.isImeComposing({ keyCode: 229, key: 'Enter' }), true);
  assert.equal(helpers.isImeComposing({ isComposing: false, key: 'Enter' }), false);
});

test('focusing a different URL on the same domain opens that specific URL', async () => {
  const { helpers, tabCalls } = loadApp({
    tabs: [{ id: 1, url: 'https://github.com/acme/one', windowId: 1 }],
  });

  await helpers.focusTab('https://github.com/acme/two');

  assert.equal(tabCalls.created.length, 1);
  assert.equal(tabCalls.created[0].url, 'https://github.com/acme/two');
  assert.equal(tabCalls.updated.length, 0);
});

test('focusing the same full URL still opens a new tab', async () => {
  const { helpers, tabCalls } = loadApp({
    tabs: [{ id: 7, url: 'https://github.com/acme/one', windowId: 2 }],
  });

  await helpers.focusTab('https://github.com/acme/one');

  assert.equal(tabCalls.created.length, 1);
  assert.equal(tabCalls.created[0].url, 'https://github.com/acme/one');
  assert.equal(tabCalls.updated.length, 0);
  assert.equal(tabCalls.focusedWindows.length, 0);
});

test('bookmarking an open tab saves it without closing the tab', async () => {
  const { helpers, syncData, tabCalls } = loadApp({
    tabs: [{ id: 7, url: 'https://github.com/acme/project', windowId: 2 }],
  });

  const saved = await helpers.bookmarkOpenTab({
    url: 'https://github.com/acme/project',
    title: 'Project repository',
  });

  assert.equal(saved, true);
  assert.equal(syncData.tabOut_customBookmarks.length, 1);
  assert.equal(syncData.tabOut_customBookmarks[0].url, 'https://github.com/acme/project');
  assert.equal(syncData.tabOut_customBookmarks[0].usageLevel, 'medium');
  assert.equal(tabCalls.removed?.length || 0, 0);
});

test('new bookmarks persist the usage level selected in the bookmark dialog', async () => {
  const { helpers, syncData } = loadApp();

  const saved = await helpers.addCustomBookmark('https://example.test/project', 'Project', 'frequent');

  assert.equal(saved, true);
  assert.equal(syncData.tabOut_customBookmarks[0].usageLevel, 'frequent');
});

test('saved tabs stay in named fixed groups and unknown groups fall back to ungrouped', () => {
  const { helpers } = loadApp();
  const grouped = helpers.buildSavedTabGroups([
    { id: 'a', url: 'https://github.com/acme/repo', groupId: 'project-a' },
    { id: 'b', url: 'https://docs.example.test/spec', groupId: 'missing' },
    { id: 'c', url: 'https://deploy.example.test', groupId: '' },
  ], [{ id: 'project-a', name: 'Project A' }]);

  assert.equal(grouped[0].name, 'Project A');
  assert.deepEqual(Array.from(grouped[0].tabs, tab => tab.id), ['a']);
  assert.deepEqual(Array.from(grouped.at(-1).tabs, tab => tab.id), ['b', 'c']);
});

test('creating a saved group persists its fixed-group metadata', async () => {
  const { helpers, syncData } = loadApp();

  const group = await helpers.createSavedTabGroup('Project A');

  assert.equal(group.name, 'Project A');
  assert.equal(syncData.tabOut_savedTabGroups.length, 1);
  assert.equal(syncData.tabOut_savedTabGroups[0].id, group.id);
});

test('moving a saved tab into a group persists the assignment', async () => {
  const { helpers, syncData, writes } = loadApp({
    deferred: [{ id: 'a', url: 'https://github.com/acme/repo', title: 'Repository' }],
    groups: [{ id: 'project-a', name: 'Project A' }],
  });

  await helpers.moveSavedTabToGroup('a', 'project-a');

  assert.equal(syncData.deferred[0].groupId, 'project-a');
  assert.ok(writes.some(write => write.deferred));
});
