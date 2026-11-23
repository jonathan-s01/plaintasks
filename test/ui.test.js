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
  for (let i = 0; i < 250; i += 1) {
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

test('default list says collapsed or expanded only on rows that can open', async () => {
  const env = await boot({ 'a.txt': '@ parent task\n\t@ child task\n@ lone task\n' });
  try {
    const { window } = await openPage(env);
    const doc = window.document;
    const tree = doc.getElementById('tree');
    const rows = () => [...tree.querySelectorAll('[role=option]')];
    await waitFor(() => rows().length === 3, 'items');
    assert.equal(tree.getAttribute('role'), 'listbox');
    assert.ok(rows().every((r) => !r.hasAttribute('aria-expanded')));
    const said = (r) => r.textContent.replace(r.querySelector('.meta') ? r.querySelector('.meta').textContent : '', '').replace(/\s+/g, ' ').trim();
    assert.equal(said(rows()[0]), 'parent task. task. Expanded. Open.');
    assert.equal(said(rows()[1]), 'child task. subtask. Level 2. Open.');
    assert.equal(said(rows()[2]), 'lone task. task. Open.');
    key(window, rows()[0], 'ArrowLeft');
    await waitFor(() => rows().length === 2, 'collapsed');
    assert.equal(said(rows()[0]), 'parent task. task. Collapsed. Open.');
  } finally {
    await env.close();
  }
});

test('pressing a view key announces the view name before anything else', async () => {
  const env = await boot({ 'a.txt': '@ call Sam\n\nstray line\n' });
  try {
    const { window } = await openPage(env);
    const doc = window.document;
    await waitFor(() => doc.querySelectorAll('[role=option]').length > 0, 'items');
    const heard = [];
    new window.MutationObserver(() => heard.push(doc.getElementById('live').textContent)).observe(doc.getElementById('live'), { childList: true, characterData: true, subtree: true });
    key(window, doc.querySelector('[role=option]'), '0');
    await waitFor(() => heard.length >= 2, 'announcements');
    assert.equal(heard[0], "Triage unmarked lines.");
    assert.notEqual(heard[heard.length - 1], heard[0]);
  } finally {
    await env.close();
  }
});

test('?ui=tree is a tree with roving tabindex; keyboard moves, collapses and completes', async () => {
  const env = await boot({ 'a.txt': 'Project\n@ parent task due:2026-11-20\n\t@ child task\n< reply to Sam\n' });
  try {
    const dom = await openPage(env, '/?ui=tree');
    const { window } = dom;
    const doc = window.document;
    const tree = doc.getElementById('tree');
    await waitFor(() => tree.querySelectorAll('[role=treeitem]').length === 3, 'items');
    assert.equal(tree.getAttribute('role'), 'tree');
    assert.equal(tree.getAttribute('aria-labelledby'), 'list-heading');
    const rows = () => [...tree.querySelectorAll('[role=treeitem]')];
    assert.equal(rows().filter((r) => r.tabIndex === 0).length, 1, 'exactly one tab stop');
    assert.equal(doc.activeElement, rows()[0]);
    assert.match(rows()[0].textContent, /parent task\. .*Open\. .*Due .*Nov 20/);
    assert.equal(rows()[0].querySelector('.text').tagName, 'H3', 'task names are headings (experiment)');
    const meta = rows()[0].querySelector('.meta');
    assert.match(meta.textContent, /Due .*List Project, line 2/);
    assert.equal(meta.getAttribute('aria-hidden'), 'true', 'rows speak only status and name');
    assert.equal(doc.getElementById('actions-dialog').getAttribute('aria-describedby'), 'actions-details');

    key(window, doc.activeElement, '?');
    assert.ok(doc.getElementById('help-dialog').hasAttribute('open'), 'help opens');
    assert.equal(doc.activeElement, doc.getElementById('help-title'), 'help starts at its heading');
    key(window, doc.body, 'Escape');
    assert.ok(!doc.getElementById('help-dialog').hasAttribute('open'), 'Escape closes help even with focus outside it');
    await waitFor(() => doc.activeElement === rows()[0], 'focus back on the task');
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

for (const [name, page] of [['list page', '/'], ['settings page', '/setup'], ['tree layout', '/?ui=tree']]) {
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

test('My list: l adds, g grabs, arrows reorder with announcements, Enter drops', async () => {
  const env = await boot({ 'a.txt': '@ one\n@ two\n@ three\n' });
  try {
    const { window } = await openPage(env);
    const doc = window.document;
    const tree = doc.getElementById('tree');
    const rows = () => [...tree.querySelectorAll('[role=option]')];
    const live = () => doc.getElementById('live').textContent;
    await waitFor(() => rows().length === 3, 'items');
    for (let i = 0; i < 3; i += 1) {
      const before = live();
      key(window, doc.activeElement, 'l');
      await waitFor(() => live() !== before || /Added to My list/.test(live()), 'added');
      await waitFor(() => /On list: My list/.test(rows()[i].textContent), 'marker');
      key(window, doc.activeElement, 'ArrowDown');
    }
    key(window, doc.activeElement, '-');
    await waitFor(() => /My list/.test(doc.getElementById('list-heading').textContent) && rows().length === 3, 'my list view');
    assert.deepEqual(rows().map((r) => /(one|two|three)\./.exec(r.textContent)[1]), ['one', 'two', 'three']);

    key(window, rows()[0], 'g');
    await waitFor(() => /Picked up: one/.test(live()), 'grab announced');
    assert.equal(doc.getElementById('grab-status').hidden, false);
    key(window, doc.activeElement, 'ArrowDown');
    await waitFor(() => /position 2 of 3: one/.test(live()), 'move announced');
    await waitFor(() => /one\./.test(rows()[1].textContent) && doc.activeElement === rows()[1], 'focus follows item');
    assert.equal(doc.getElementById('grab-status').hidden, false);
    key(window, doc.activeElement, 'Enter');
    await waitFor(() => /Dropped at position 2 of 3: one/.test(live()), 'drop announced');
    assert.equal(doc.getElementById('grab-status').hidden, true);
    assert.deepEqual(env.app.view({ view: 'list:mylist', q: '', showCompleted: false }).items.map((i) => i.text), ['two', 'one', 'three']);
    window.close();
  } finally {
    env.close();
  }
});

test('multiple lists: l opens a chooser, new list is created, [ ] cycle lists, dialogs pass axe', async () => {
  const env = await boot({ 'a.txt': '@ one\n@ two\n' });
  try {
    env.app.action({ op: 'listCreate', value: 'Work' });
    const { window } = await openPage(env);
    const doc = window.document;
    const tree = doc.getElementById('tree');
    const rows = () => [...tree.querySelectorAll('[role=option]')];
    const live = () => doc.getElementById('live').textContent;
    await waitFor(() => rows().length === 2, 'items');
    key(window, doc.activeElement, 'l');
    await waitFor(() => doc.getElementById('lists-dialog').hasAttribute('open'), 'chooser opens');
    const boxes = () => [...doc.querySelectorAll('#lists-choices input')];
    assert.deepEqual([...doc.querySelectorAll('#lists-choices label')].map((l) => l.textContent), ['My list', 'Work']);
    assert.equal(doc.activeElement, boxes()[0]);

    window.eval(axe.source);
    const results = await window.axe.run(doc.getElementById('lists-dialog'), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    assert.equal(results.violations.length, 0, results.violations.map((v) => v.id).join());

    boxes()[1].checked = true;
    doc.getElementById('lists-new').value = 'Errands';
    doc.getElementById('lists-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => /one is on Work and Errands/.test(live()), 'saved and announced');
    await waitFor(() => /On lists: Work, Errands/.test(rows()[0].textContent), 'meta shows both lists');

    key(window, doc.activeElement, ']');
    await waitFor(() => /^My list/.test(doc.getElementById('list-heading').textContent), 'first list');
    key(window, doc.activeElement, ']');
    await waitFor(() => /^Work/.test(doc.getElementById('list-heading').textContent) && rows().length === 1, 'second list');
    key(window, doc.activeElement, 'L');
    await waitFor(() => /Removed from Work: one/.test(live()), 'quick toggle removes');

    key(window, doc.body, 'M');
    await waitFor(() => doc.getElementById('manage-dialog').hasAttribute('open'), 'manage opens');
    const res2 = await window.axe.run(doc.getElementById('manage-dialog'), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    assert.equal(res2.violations.length, 0, res2.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join()}`).join('\n'));
    window.close();
  } finally {
    env.close();
  }
});

test('status symbols, add note, add task with master file, sort and dates dialogs', async () => {
  const env = await boot({ 'a.txt': '@ one\n@ two\n' });
  try {
    const { window } = await openPage(env);
    const doc = window.document;
    const tree = doc.getElementById('tree');
    const rows = () => [...tree.querySelectorAll('[role=option]')];
    const live = () => doc.getElementById('live').textContent;
    const submit = (id) => doc.getElementById(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    const rules = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } };
    const axeOk = async (id) => {
      const r = await window.axe.run(doc.getElementById(id), rules);
      assert.equal(r.violations.length, 0, `${id}: ${r.violations.map((v) => v.id).join()}`);
    };
    window.eval(axe.source);
    await waitFor(() => rows().length === 2, 'items');

    key(window, doc.activeElement, '>');
    await waitFor(() => doc.getElementById('note-dialog').hasAttribute('open') && /Waiting on others/.test(doc.getElementById('note-title').textContent), 'status note prompt');
    await axeOk('note-dialog');
    submit('note-form');
    await waitFor(() => /one/.test(live()) && /waiting/i.test(live()) && !doc.getElementById('note-dialog').hasAttribute('open'), 'waiting set with blank Enter');
    assert.equal(fs.readFileSync(path.join(env.notes, 'a.txt'), 'utf8'), '@> one\n@ two\n');

    key(window, doc.activeElement, '*');
    await waitFor(() => doc.getElementById('note-dialog').hasAttribute('open'), 'important prompt');
    doc.getElementById('note-input').value = 'board asked';
    submit('note-form');
    await waitFor(() => /Note added/.test(live()) && !doc.getElementById('note-dialog').hasAttribute('open'), 'important with note');
    assert.match(fs.readFileSync(path.join(env.notes, 'a.txt'), 'utf8'), /^@>\* one\n {2}\[2026-11-16\] Important: board asked\n@ two\n$/);

    await waitFor(() => doc.activeElement && doc.activeElement.getAttribute('role') === 'option', 'focus back on the list');
    key(window, doc.activeElement, 's');
    await waitFor(() => doc.getElementById('note-dialog').hasAttribute('open'), 'note dialog');
    await axeOk('note-dialog');
    doc.getElementById('note-input').value = 'called them';
    submit('note-form');
    await waitFor(() => /called them|[Nn]ote/.test(live()) && !doc.getElementById('note-dialog').hasAttribute('open'), 'note saved');
    assert.match(fs.readFileSync(path.join(env.notes, 'a.txt'), 'utf8'), /\[2026-11-16\] called them/);

    doc.getElementById('note-dialog').removeAttribute('open');
    doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'n', code: 'KeyN', bubbles: true, cancelable: true }));
    await waitFor(() => doc.getElementById('newtask-dialog').hasAttribute('open'), 'add task dialog');
    await axeOk('newtask-dialog');
    doc.getElementById('nt-text').value = 'brand new thing';
    submit('newtask-form');
    await waitFor(() => doc.getElementById('master-dialog').hasAttribute('open'), 'master picker');
    await waitFor(() => doc.getElementById('master-folder').options.length === 1, 'folders listed');
    await axeOk('master-dialog');
    doc.getElementById('master-create').click();
    await waitFor(() => doc.getElementById('newtask-dialog').hasAttribute('open') && !doc.getElementById('master-dialog').hasAttribute('open'), 'back to add task');
    doc.getElementById('nt-text').value = 'brand new thing';
    submit('newtask-form');
    await waitFor(() => /brand new thing/.test(fs.existsSync(path.join(env.notes, 'Tasks.txt')) ? fs.readFileSync(path.join(env.notes, 'Tasks.txt'), 'utf8') : ''), 'task written to master');

    doc.getElementById('newtask-dialog').removeAttribute('open');
    await env.app.action({ id: env.app.index.tasks[0].id, op: 'listAdd', list: 'mylist' });
    key(window, doc.body, '-');
    await waitFor(() => /^My list/.test(doc.getElementById('list-heading').textContent) && rows().length > 0, 'my list');
    key(window, rows()[0], 'O');
    await waitFor(() => doc.getElementById('sort-dialog').hasAttribute('open'), 'sort dialog');
    await axeOk('sort-dialog');
    doc.getElementById('sort-dialog').removeAttribute('open');

    key(window, doc.body, '1');
    await waitFor(() => rows().length > 0 && /^All open|open/i.test(doc.getElementById('list-heading').textContent), 'open view');
    key(window, rows()[0], 'd');
    await waitFor(() => doc.getElementById('due-dialog').hasAttribute('open'), 'dates dialog');
    await axeOk('due-dialog');
    doc.getElementById('due-input').value = 'nov 20 2pm';
    doc.getElementById('checkin-input').value = 'nov 18';
    submit('due-form');
    await waitFor(() => /due/.test(live()) && /check in/.test(live()), 'dates saved');
    assert.match(fs.readFileSync(path.join(env.notes, 'a.txt'), 'utf8'), /due:2026-11-20 14:00/);
    await new Promise((r) => setTimeout(r, 300)); // let the follow-up view reload finish before the window closes
    window.close();
  } finally {
    env.close();
  }
});

test('notes expand under a collapsed task, Delete marks it with $, and Option+n opens a new list', async () => {
  const env = await boot({ 'a.txt': '@ Future\n  Jaws training\n@ old thing\n' });
  try {
    const { window } = await openPage(env);
    const doc = window.document;
    const tree = doc.getElementById('tree');
    const rows = () => [...tree.querySelectorAll('[role=option]')];
    await waitFor(() => rows().length === 2, 'tasks');
    assert.match(rows()[0].textContent, /Collapsed\./, 'a task with notes starts collapsed');
    key(window, doc.activeElement, 'ArrowRight');
    assert.equal(rows().length, 3);
    assert.match(rows()[1].textContent, /Jaws training\. .*Note\./);
    key(window, doc.activeElement, 'ArrowLeft');
    key(window, doc.activeElement, 'ArrowDown');
    assert.match(doc.activeElement.textContent, /old thing/);
    key(window, doc.activeElement, 'Delete');
    await waitFor(() => /Deleted: old thing/.test(doc.getElementById('live').textContent), 'deleted');
    assert.match(fs.readFileSync(path.join(env.notes, 'a.txt'), 'utf8'), /^\$ old thing$/m);
    await waitFor(() => rows().length === 1, 'task gone');

    doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'n', code: 'KeyN', altKey: true, bubbles: true, cancelable: true }));
    await waitFor(() => doc.getElementById('manage-dialog').hasAttribute('open'), 'manage dialog');
    assert.equal(doc.activeElement, doc.getElementById('manage-new'));
    await new Promise((r) => setTimeout(r, 300));
    window.close();
  } finally {
    env.close();
  }
});

test('buckets: y opens a bucket chooser that passes axe, hover focuses a choice, saving announces and shows the bucket, G opens the Buckets view', async () => {
  const env = await boot({ 'a.txt': '@ call Bob\n~ Partner network jira:label\n~ DERG work jira:label\n' });
  try {
    const { window } = await openPage(env);
    const doc = window.document;
    const tree = doc.getElementById('tree');
    const rows = () => [...tree.querySelectorAll('[role=option]')];
    const live = () => doc.getElementById('live').textContent;
    await waitFor(() => rows().length === 3, 'items');
    key(window, doc.activeElement, 'y');
    await waitFor(() => doc.getElementById('buckets-dialog').hasAttribute('open'), 'chooser opens');
    const boxes = () => [...doc.querySelectorAll('#buckets-choices input')];
    assert.deepEqual([...doc.querySelectorAll('#buckets-choices label')].map((l) => l.textContent), ['Partner network, 0 tasks', 'DERG work, 0 tasks']);
    assert.equal(doc.activeElement, boxes()[0]);
    window.eval(axe.source);
    const results = await window.axe.run(doc.getElementById('buckets-dialog'), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    assert.equal(results.violations.length, 0, results.violations.map((v) => v.id).join());

    // Moving the mouse over a choice focuses it, so VoiceOver reads it.
    doc.querySelectorAll('#buckets-choices label')[1].dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true }));
    assert.equal(doc.activeElement, boxes()[1]);
    key(window, boxes()[1], 'ArrowUp');
    assert.equal(doc.activeElement, boxes()[0]);
    boxes()[1].checked = true;
    key(window, boxes()[0], 'ArrowDown');
    assert.equal(doc.activeElement, boxes()[1]);
    key(window, boxes()[1], 'Enter');
    await waitFor(() => /Bucket: DERG work\. Task: call Bob/.test(live()), 'saved and announced');
    await waitFor(() => /Bucket: DERG work/.test(rows()[0].textContent), 'meta shows the bucket');
    assert.equal(doc.activeElement, rows()[0]);
    assert.match(fs.readFileSync(path.join(env.notes, 'a.txt'), 'utf8'), /^@ call Bob goal:derg-work\n~ Partner network jira:label\n~ DERG work jira:label goal:derg-work\n$/);

    key(window, doc.activeElement, 'G');
    await waitFor(() => /^Buckets/.test(doc.getElementById('list-heading').textContent) && rows().length === 3, 'buckets view');
    assert.deepEqual(rows().map((r) => /Level 2\./.test(r.textContent)), [false, false, true]);
    assert.match(rows()[1].textContent, /1 open, 0 done task/);
    window.close();
  } finally {
    env.close();
  }
});

test('Jira sync: shift and j opens a grouped preview that passes axe; Apply sends the chosen items with their signatures', async () => {
  const env = await boot({ 'a.txt': '@ call Bob\n' });
  let sent = null;
  const base = { taskId: 't1', task: 'call Bob', file: 'notes/a.txt', line: 1, raw: '@ call Bob' };
  env.app.syncPreview = async () => ({
    synced: ['notes/a.txt'],
    startedNotes: 1,
    info: [],
    items: [
      { ...base, id: 'A-1:status', key: 'A-1', group: 'conflict', label: 'Status differs (first sync)', choice: 'skip', choices: { file: 'Keep file: to do', jira: 'Take Jira: In Progress' }, sig: 's1' },
      { ...base, id: 'A-1:desc', key: 'A-1', group: 'push', label: 'Description: from the notes', checked: false, sig: 's2' },
      { ...base, taskId: 't2', task: 'new thing', line: 2, id: 'create:t2', key: null, group: 'create', label: 'Create Task in epic A-9, status To Do', checked: true, sig: 's3' },
    ],
  });
  env.app.syncApply = async (body) => { sent = body; return { message: 'Jira sync finished: 1 change sent to Jira.', results: [{ ok: true, text: 'Created A-2: new thing' }] }; };
  try {
    const { window } = await openPage(env);
    const doc = window.document;
    const live = () => doc.getElementById('live').textContent;
    await waitFor(() => doc.querySelectorAll('#tree [role=option]').length === 1, 'items');
    key(window, doc.activeElement, 'J');
    await waitFor(() => doc.getElementById('sync-dialog').hasAttribute('open') && !doc.getElementById('sync-form').hidden, 'preview shown');
    const legends = [...doc.querySelectorAll('#sync-sections > fieldset > legend')].map((l) => l.textContent);
    assert.deepEqual(legends, [
      'Conflicts: changed on both sides, or different on the first sync, 1 change. Section 1 of 3',
      'Create in Jira, 1 change. Section 2 of 3',
      'Update Jira, 1 change. Section 3 of 3',
    ]);
    assert.match(doc.getElementById('sync-status').textContent, /^3 changes found: 1 conflict, 1 to create in Jira, 1 to update in Jira\. Files checked: notes\/a\.txt\.$/);
    assert.equal(doc.getElementById('sync-count').textContent, '1 of 3 changes chosen.');
    assert.equal(doc.activeElement.id, 'sy-conflict-1-file');
    assert.equal(doc.getElementById('sync-started').hidden, false);
    window.eval(axe.source);
    const results = await window.axe.run(doc.getElementById('sync-dialog'), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    assert.equal(results.violations.length, 0, results.violations.map((v) => v.id).join());

    [...doc.querySelectorAll('#sync-sections button')].find((b) => b.textContent === 'Take Jira for all conflicts').click();
    assert.equal(doc.getElementById('sync-count').textContent, '2 of 3 changes chosen.');
    doc.getElementById('sync-apply').click();
    await waitFor(() => sent, 'apply sent');
    assert.deepEqual(sent.choices, {
      'A-1:status': { choice: 'jira', sig: 's1' },
      'A-1:desc': { choice: 'skip', sig: 's2' },
      'create:t2': { choice: 'apply', sig: 's3' },
    });
    await waitFor(() => /Jira sync finished/.test(live()), 'announced');
    assert.equal(doc.getElementById('sync-results').textContent, 'Done: Created A-2: new thing');
    assert.equal(doc.getElementById('sync-form').hidden, true);
    window.close();
  } finally {
    env.close();
  }
});

test('t picks for today, shift+p cycles priority, shift+b opens the blocked-by dialog (passes axe), shift+t and shift+a open the new views', async () => {
  const env = await boot({ 'a.txt': '@ one\n@ two\n' });
  try {
    const { window } = await openPage(env);
    const doc = window.document;
    const rows = () => [...doc.getElementById('tree').querySelectorAll('[role=option]')];
    const live = () => doc.getElementById('live').textContent;
    const file = () => fs.readFileSync(path.join(env.notes, 'a.txt'), 'utf8');
    await waitFor(() => rows().length === 2, 'items');
    key(window, doc.activeElement, 't');
    await waitFor(() => /picked for today/i.test(live()), 'pick announced');
    assert.match(file(), /^@ one today:2026-11-16\n/);
    key(window, doc.activeElement, 'P');
    await waitFor(() => /Priority high/i.test(live()), 'priority announced');
    await waitFor(() => /High priority/.test(rows()[0].textContent), 'row says High priority');
    assert.match(file(), /^@ one today:2026-11-16 p:high\n/);

    key(window, doc.activeElement, 'B');
    await waitFor(() => doc.getElementById('blockers-dialog').hasAttribute('open'), 'blockers dialog');
    assert.equal(doc.activeElement, doc.getElementById('blockers-filter'));
    assert.deepEqual([...doc.querySelectorAll('#blockers-choices label')].map((l) => l.textContent), ['two, list a, line 2']);
    assert.match(doc.getElementById('blockers-count').textContent, /0 ticked\. Showing 1 of 1/);
    window.eval(axe.source);
    const results = await window.axe.run(doc.getElementById('blockers-dialog'), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    assert.equal(results.violations.length, 0, results.violations.map((v) => v.id).join());
    const box = doc.querySelector('#blockers-choices input');
    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.match(doc.getElementById('blockers-count').textContent, /^1 ticked/);
    doc.getElementById('blockers-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => /Blocked by: two/.test(live()), 'blocked announced');
    assert.match(file(), /^@ one today:2026-11-16 p:high after:two\n@ two id:two\n$/);
    await waitFor(() => /Blocked/.test(rows()[0].textContent), 'row says Blocked');

    key(window, doc.activeElement, 'T');
    await waitFor(() => /My Day/.test(doc.getElementById('list-heading').textContent), 'my day');
    key(window, doc.activeElement, 'A');
    await waitFor(() => /Next actions/.test(doc.getElementById('list-heading').textContent), 'next actions');
    window.close();
  } finally {
    env.close();
  }
});

test('Manage lists and New list have a Not actionable checkbox that saves', async () => {
  const env = await boot({ 'a.txt': '@ one\n' });
  try {
    env.app.action({ op: 'listCreate', value: 'Ideas' });
    const { window } = await openPage(env);
    const doc = window.document;
    await waitFor(() => doc.querySelector('[role=option]'), 'items');
    key(window, doc.activeElement, 'M');
    await waitFor(() => doc.getElementById('manage-dialog').hasAttribute('open'), 'manage opens');
    assert.match(doc.querySelector('label[for=manage-notactionable]').textContent, /^Not actionable/);
    const cb = await waitFor(() => doc.getElementById('mna-1'), 'list checkbox');
    assert.match(doc.querySelector('label[for=mna-1]').textContent, /^Not actionable/);
    cb.checked = true;
    [...cb.closest('li').querySelectorAll('button')].find((b) => /^Save file settings for Ideas/.test(b.textContent)).click();
    await waitFor(() => env.app.summary().lists.some((l) => l.notActionable), 'saved');
    window.eval(axe.source);
    const results = await window.axe.run(doc.getElementById('manage-dialog'), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    assert.equal(results.violations.length, 0, results.violations.map((v) => v.id).join());
    window.close();
  } finally {
    env.close();
  }
});
