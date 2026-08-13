'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'app.js'), 'utf8');

function loadApp({ deferred = [], groups = [] } = {}) {
  const syncData = {
    deferred,
    tabOut_savedTabGroups: groups,
  };
  const writes = [];
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
    window: {},
    chrome: {
      runtime: { id: 'test-extension' },
      storage: {
        sync: {
          get: async keys => {
            if (typeof keys === 'string') return { [keys]: syncData[keys] };
            if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, syncData[key]]));
            return { ...syncData };
          },
          set: async value => {
            Object.assign(syncData, value);
            writes.push(value);
          },
        },
        local: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
        },
      },
    },
  };

  vm.runInNewContext(`${appSource}\nglobalThis.__featureTest = {
    findTabSearchMatches,
    buildSavedTabGroups,
    createSavedTabGroup,
    moveSavedTabToGroup,
  };`, context);

  return { helpers: context.__featureTest, syncData, writes };
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

test('tab search ranks a title match ahead of a URL-only match', () => {
  const { helpers } = loadApp();
  const matches = helpers.findTabSearchMatches('project', [
    { id: 1, title: 'Project dashboard', url: 'https://example.test/overview' },
    { id: 2, title: 'Overview', url: 'https://example.test/project' },
  ]);

  assert.deepEqual(Array.from(matches, tab => tab.id), [1, 2]);
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
