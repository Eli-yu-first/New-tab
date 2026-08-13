'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const hostPath = path.join(__dirname, '..', 'native-host', 'host.js');

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function startHost(home) {
  const child = spawn(process.execPath, [hostPath], {
    env: { ...process.env, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let buffer = Buffer.alloc(0);

  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      messages.push(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')));
      buffer = buffer.subarray(length + 4);
    }
  });

  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const timer = setInterval(() => {
        const found = messages.find(predicate);
        if (found) {
          clearInterval(timer);
          resolve(found);
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for native message: ${JSON.stringify(messages)}`));
        }
      }, 10);
    });
  }

  return {
    child,
    send(message) { child.stdin.write(frame(message)); },
    waitFor,
  };
}

test('native host persists open tabs, history, and remote close requests', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'new-tab-host-'));
  const client = startHost(home);

  try {
    await client.waitFor(message => message.event === 'changed');

    client.send({
      action: 'writeOpenTabs',
      browser: 'Chrome',
      tabs: [{ id: 5, url: 'https://example.test/a', title: 'Example' }],
    });
    await client.waitFor(message => message.event === 'changed' && message.data.openTabs.Chrome);

    client.send({
      action: 'write',
      data: { savedTabGroups: [{ id: 'project-a', name: 'Project A' }] },
    });
    const savedGroupChange = await client.waitFor(message =>
      message.event === 'changed' && message.data.savedTabGroups.length === 1
    );
    assert.equal(savedGroupChange.data.savedTabGroups[0].name, 'Project A');

    client.send({
      action: 'writeHistory',
      history: [{ url: 'https://example.test/a', title: 'Example', lastVisitTime: 100 }],
    });
    await client.waitFor(message => message.event === 'changed' && message.data.history.length === 1);

    client.send({ action: 'requestCloseTab', browser: 'Chrome', url: 'https://example.test/a' });
    const changed = await client.waitFor(message =>
      message.event === 'changed' && message.data.closeRequests.length === 1
    );

    assert.equal(changed.data.openTabs.Chrome[0].url, 'https://example.test/a');
    assert.equal(changed.data.history[0].url, 'https://example.test/a');
    assert.equal(changed.data.closeRequests[0].browser, 'Chrome');

    client.send({ action: 'deleteHistory', url: 'https://example.test/a' });
    const deleted = await client.waitFor(message =>
      message.event === 'changed' && message.data.historyDeletions.length === 1
    );
    assert.equal(deleted.data.history.length, 0);

    client.send({
      action: 'writeHistory',
      history: [{ url: 'https://example.test/a', title: 'Example', lastVisitTime: 100 }],
    });
    client.send({ action: 'read' });
    const current = await client.waitFor(message => message.success === true && message.data);
    assert.equal(current.data.history.length, 0);
  } finally {
    client.child.stdin.end();
    client.child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a change from one native host reaches another host for the same profile', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'new-tab-host-sync-'));
  const source = startHost(home);
  const target = startHost(home);

  try {
    await Promise.all([
      source.waitFor(message => message.event === 'changed'),
      target.waitFor(message => message.event === 'changed'),
    ]);

    source.send({
      action: 'writeOpenTabs',
      browser: 'Edge',
      tabs: [{ id: 9, url: 'https://example.test/shared', title: 'Shared tab' }],
    });

    const changed = await target.waitFor(message =>
      message.event === 'changed' && message.data.openTabs.Edge
    );
    assert.equal(changed.data.openTabs.Edge[0].url, 'https://example.test/shared');
  } finally {
    source.child.stdin.end();
    target.child.stdin.end();
    source.child.kill();
    target.child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
