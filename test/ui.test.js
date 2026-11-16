'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { JSDOM, VirtualConsole } = require('jsdom');
const axe = require('axe-core');
const { App } = require('../src/app');
const { createServer } = require('../src/server');

async function boot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ui-'));
  const notes = path.join(root, 'notes');
  fs.mkdirSync(notes);
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(notes, rel), body);
  const cfg = path.join(root, 'cfg');
  fs.mkdirSync(cfg);
  const app = new App({ dir: cfg, now: () => new Date(2026, 10, 16, 9), opener: () => {}, secretApi: { getJiraToken: () => null, setJiraToken() {}, clearJiraToken() {} } });
  app.setFolders([{ path: notes }]);
  const server = createServer(app, { token: 'test-token' });
  await server.listen(0);
  const port = server.address().port;
  return { app, notes, port, base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function openPage(env, page = '/') {
  const dom = await JSDOM.fromURL(`${env.base}${page}`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole().sendTo(console),
    beforeParse(window) {
      window.fetch = (u, o) => fetch(new URL(u, env.base), o);
      window.EventSource = class { addEventListener() {} close() {} };
      window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
      window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
    },
  });
  return dom;
}

async function waitFor(fn, what) {
  for (let i = 0; i < 100; i += 1) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function key(win, target, k) {
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

test('server rejects missing tokens, foreign hosts and non-JSON posts', async () => {
  const env = await boot({ 'a.txt': '@ one\n' });
  try {
    assert.equal((await get(env.port, '/api/summary')).status, 403);
    assert.equal((await get(env.port, '/api/summary', { 'x-plaintasks-token': 'test-token', Host: 'evil.example' })).status, 403);
    const ok = await get(env.port, '/api/summary', { 'x-plaintasks-token': 'test-token' });
    assert.equal(ok.status, 200);
    const page = await get(env.port, '/');
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.ok(page.body.includes('content="test-token"'));
    const post = await fetch(`${env.base}/api/undo`, { method: 'POST', headers: { 'x-plaintasks-token': 'test-token', 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(post.status, 415);
  } finally {
    env.close();
  }
});

test('list is a tree with roving tabindex; keyboard moves, collapses and completes', async () => {
  const env = await boot({ 'a.txt': 'Project\n@ parent task due:2026-11-20\n\t@ child task\n< reply to Sam\n' });
  try {
    const dom = await openPage(env);
    const { window } = dom;
    const doc = window.document;
    const tree = doc.getElementById('tree');
    await waitFor(() => tree.querySelectorAll('[role=treeitem]').length === 3, 'items');
    assert.equal(tree.getAttribute('role'), 'tree');
    assert.equal(tree.getAttribute('aria-labelledby'), 'list-heading');
    const rows = () => [...tree.querySelectorAll('[role=treeitem]')];
    assert.equal(rows().filter((r) => r.tabIndex === 0).length, 1, 'exactly one tab stop');
    assert.equal(doc.activeElement, rows()[0]);
    assert.match(rows()[0].textContent, /Open\. parent task\. .*Due .*Nov 20/);
    assert.equal(rows()[0].getAttribute('aria-expanded'), 'true');
    assert.equal(rows()[1].getAttribute('aria-level'), '2');

    key(window, doc.activeElement, 'ArrowDown');
    assert.equal(doc.activeElement, rows()[1]);
    key(window, doc.activeElement, 'ArrowLeft');
    assert.equal(doc.activeElement, rows()[0], 'left on a leaf moves to the parent');
    key(window, doc.activeElement, 'ArrowLeft');
    assert.equal(rows().length, 2);
    assert.equal(rows()[0].getAttribute('aria-expanded'), 'false');
    key(window, doc.activeElement, 'ArrowRight');
    assert.equal(rows().length, 3);

    key(window, doc.activeElement, 'x');
    await waitFor(() => /Marked done: parent task/.test(doc.getElementById('live').textContent), 'live announcement');
    assert.match(fs.readFileSync(path.join(env.notes, 'a.txt'), 'utf8'), /^\+.* parent task due:2026-11-20 done:2026-11-16$/m);
    await waitFor(() => tree.contains(doc.activeElement), 'focus stays in list');
    key(window, doc.activeElement, 'u');
    await waitFor(() => /Undid change/.test(doc.getElementById('live').textContent), 'undo announcement');
    assert.match(fs.readFileSync(path.join(env.notes, 'a.txt'), 'utf8'), /^@ parent task due:2026-11-20$/m);

    key(window, doc.activeElement, '5');
    await waitFor(() => /Waiting on me/.test(doc.getElementById('list-heading').textContent), 'view switch');
    assert.equal(rows().length, 1);
    window.close();
  } finally {
    env.close();
  }
});

for (const [name, page] of [['list page', '/'], ['settings page', '/setup'], ['list fallback', '/?ui=list']]) {
  test(`axe finds no violations on the ${name}`, async () => {
    const env = await boot({ 'a.txt': 'Project\n@ one\n\t@ two\n' });
    try {
      const dom = await openPage(env, page);
      const { window } = dom;
      await waitFor(() => window.document.querySelector('[role=treeitem],[role=option],#folders section'), 'content');
      window.eval(axe.source);
      const results = await window.axe.run(window.document, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      const found = Array.from(results.violations, (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
      assert.equal(found.length, 0, found.join('\n'));
      window.close();
    } finally {
      env.close();
    }
  });
}
