'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionDir = path.join(__dirname, '..', 'extension');
const html = fs.readFileSync(path.join(extensionDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(extensionDir, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(extensionDir, 'app.js'), 'utf8');

test('duplicate New Tab cleanup uses a compact top-right close control', () => {
  assert.match(html, /class="tab-cleanup-control"/);
  assert.match(html, /class="tab-cleanup-close"/);
  assert.match(html, /class="tab-cleanup-tooltip"/);
  assert.match(html, /aria-describedby="tabOutDupeTooltip"/);
  assert.doesNotMatch(html, /class="tab-cleanup-banner"/);

  assert.match(css, /\.tab-cleanup-control\s*{[\s\S]*?position:\s*fixed;[\s\S]*?top:[\s\S]*?right:/);
  assert.match(css, /\.tab-cleanup-close:hover\s+\.tab-cleanup-tooltip/);
  assert.match(css, /\.tab-cleanup-close:focus-visible\s+\.tab-cleanup-tooltip/);
});

test('cleanup tooltip reports only the number of other New Tab pages', () => {
  assert.match(app, /const extraCount = tabOutTabs\.length - 1;/);
  assert.match(app, /tabOutDupeTooltip/);
  assert.match(app, /关闭其他 \{count\} 个新标签页/);
  assert.match(app, /replace\('\{count\}', String\(extraCount\)\)/);
});
