'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { App } = require('../src/app');

const NOW = () => new Date(2026, 10, 16, 9, 0, 0);

function setup(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-app-'));
  const notes = path.join(root, 'notes');
  fs.mkdirSync(path.join(notes, 'sub'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(notes, rel), body);
  const cfg = path.join(root, 'cfg');
  fs.mkdirSync(cfg);
  const memory = { token: null };
  const secretApi = { getJiraToken: () => memory.token, setJiraToken: (t) => { memory.token = t; }, clearJiraToken: () => { memory.token = null; } };
  const opened = [];
  const app = new App({ dir: cfg, now: NOW, opener: (f, l) => opened.push([f, l]), secretApi, trashDir: path.join(root, 'trash') });
  app.setFolders([{ path: notes }]);
  return { root, notes, cfg, app, opened, secretApi };
}

const items = (app, view = 'open', extra = {}) => app.view({ view, q: '', showCompleted: false, ...extra }).items;

test('complete, reopen and undo write only the targeted line', async () => {
  const { notes, app } = setup({ 'a.txt': 'Project\r\n@ write spec\r\n< reply to Sam\r\nplain note\r\n' });
  const before = fs.readFileSync(path.join(notes, 'a.txt'), 'utf8');
  const t = items(app).find((i) => i.text === 'write spec');
  const res = await app.action({ id: t.id, op: 'toggleDone' });
  assert.match(res.message, /Marked done/);
  const after = fs.readFileSync(path.join(notes, 'a.txt'), 'utf8').split('\r\n');
  assert.equal(after[0], 'Project');
  assert.match(after[1], /^\+.*write spec done:2026-11-16$/);
  assert.equal(after[2], '< reply to Sam');
  assert.equal(after[3], 'plain note');
  assert.ok(!items(app).some((i) => i.text === 'write spec'), 'completed task is hidden');
  assert.ok(items(app, 'open', { showCompleted: true }).some((i) => i.text === 'write spec'));
  app.undo();
  assert.equal(fs.readFileSync(path.join(notes, 'a.txt'), 'utf8'), before);
});

test('external edit makes the write fail safely instead of clobbering', async () => {
  const { notes, app } = setup({ 'a.txt': '@ one\n@ two\n' });
  const t = items(app).find((i) => i.text === 'two');
  fs.writeFileSync(path.join(notes, 'a.txt'), '@ one\n@ something else entirely\n');
  await assert.rejects(() => app.action({ id: t.id, op: 'toggleDone' }), (e) => e.status === 409 || e.status === 404);
  assert.equal(fs.readFileSync(path.join(notes, 'a.txt'), 'utf8'), '@ one\n@ something else entirely\n');
});

test('triage lists unmarked lines, marks them, and can skip them', async () => {
  const { notes, app } = setup({ 'a.txt': 'Alpha\n@ real task\n\nthought one\n\nthought two\n' });
  let tri = items(app, 'triage').filter((i) => i.type === 'unmarked');
  assert.deepEqual(tri.map((i) => i.text), ['thought one', 'thought two']);
  await app.action({ id: tri[0].id, op: 'todo' });
  assert.match(fs.readFileSync(path.join(notes, 'a.txt'), 'utf8'), /^@ thought one$/m);
  tri = items(app, 'triage').filter((i) => i.type === 'unmarked');
  await app.action({ id: tri[0].id, op: 'dismiss' });
  assert.equal(items(app, 'triage').filter((i) => i.type === 'unmarked').length, 0);
  assert.equal(fs.readFileSync(path.join(notes, 'a.txt'), 'utf8').includes('thought two'), true);
});

test('due dates accept friendly input and are written as ISO', async () => {
  const { notes, app } = setup({ 'a.txt': '@ ship it\n' });
  const t = items(app)[0];
  await app.action({ id: t.id, op: 'due', value: 'nov 20' });
  assert.equal(fs.readFileSync(path.join(notes, 'a.txt'), 'utf8'), '@ ship it due:2026-11-20\n');
  await assert.rejects(() => app.action({ id: items(app)[0].id, op: 'due', value: 'gibberish!!' }), (e) => e.status === 400);
});

test('per-folder "unmarked are tasks" setting and exclusions apply', () => {
  const { notes, app } = setup({ 'a.txt': 'buy milk\ncall mum\n', 'sub/skip.txt': '@ hidden\n' });
  assert.equal(items(app).length, 1);
  app.setFolders([{ path: notes, unmarked: 'tasks', excluded: ['sub'] }]);
  assert.deepEqual(items(app).map((i) => i.text).sort(), ['buy milk', 'call mum']);
});

test('open action asks the opener for the source file', async () => {
  const { app, opened } = setup({ 'a.txt': '@ one\n' });
  const res = await app.action({ id: items(app)[0].id, op: 'open' });
  assert.match(res.message, /line 1/);
  assert.equal(opened.length, 1);
});

test('rtf conversion needs confirmation and only touches listed files', () => {
  const { notes, app } = setup({ 'a.txt': '@ one\n' });
  fs.writeFileSync(path.join(notes, 'old.rtf'), '{\\rtf1 hi}');
  app.index.refresh(NOW());
  assert.deepEqual(app.rtfScan(0).files, ['old.rtf']);
  assert.throws(() => app.rtfConvert(0, ['old.rtf'], false), /confirmation/);
  app.rtfExec = (cmd, args) => {
    assert.equal(cmd, 'textutil');
    fs.writeFileSync(args[args.indexOf('-output') + 1], '@ converted task\n');
  };
  const { results } = app.rtfConvert(0, ['old.rtf', '../escape.rtf'], true);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'converted');
  assert.ok(fs.existsSync(path.join(notes, 'old.txt')));
  assert.ok(!fs.existsSync(path.join(notes, 'old.rtf')));
  assert.ok(items(app).some((i) => i.text === 'converted task'));
});

test('jira: works unconfigured, links keys, shows status, creates issues (mock fetch)', async () => {
  const { notes, app, secretApi } = setup({ 'a.txt': '@ plan launch\n' });
  assert.equal(app.summary().jiraConfigured, false);
  const t = items(app)[0];
  await app.action({ id: t.id, op: 'jira', value: 'ABC-12' });
  assert.equal(fs.readFileSync(path.join(notes, 'a.txt'), 'utf8'), '@ plan launch jira:ABC-12\n');
  await assert.rejects(() => app.jiraIssue('ABC-12'), (e) => e.code === 'jira-unconfigured');

  const calls = [];
  app.fetch = async (url, opts) => {
    calls.push([url, opts]);
    if (opts.method === 'POST') return { ok: true, status: 201, json: async () => ({ key: 'ABC-99' }) };
    return { ok: true, status: 200, json: async () => ({ key: 'ABC-12', fields: { summary: 'Launch', status: { name: 'In Progress' } } }) };
  };
  app.setJira({ baseUrl: 'https://jira.example.test', type: 'datacenter', token: 'secret-pat', project: 'ABC' });
  assert.equal(secretApi.getJiraToken(), 'secret-pat');
  assert.equal(JSON.stringify(app.publicConfig()).includes('secret-pat'), false);
  assert.equal(fs.readFileSync(path.join(app.dir, 'config.json'), 'utf8').includes('secret-pat'), false);
  const issue = await app.jiraIssue('ABC-12');
  assert.equal(issue.status, 'In Progress');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer secret-pat');
  const t2 = items(app)[0];
  await app.action({ id: t2.id, op: 'jira', value: '' });
  const created = await app.jiraCreate({ id: items(app)[0].id });
  assert.equal(created.key, 'ABC-99');
  assert.match(fs.readFileSync(path.join(notes, 'a.txt'), 'utf8'), /jira:ABC-99/);
});

test('My list: add, reorder, undo, survive done, and never touch the files', async () => {
  const { notes, app } = setup({ 'a.txt': '@ alpha\n@ beta\n', 'b.txt': '@ gamma\n' });
  const before = { a: fs.readFileSync(path.join(notes, 'a.txt'), 'utf8'), b: fs.readFileSync(path.join(notes, 'b.txt'), 'utf8') };
  const byText = (t) => items(app).find((i) => i.text === t);
  for (const t of ['alpha', 'beta', 'gamma']) await app.action({ id: byText(t).id, op: 'listToggle' });
  const order = () => items(app, 'mylist').map((i) => i.text);
  assert.deepEqual(order(), ['alpha', 'beta', 'gamma']);
  assert.ok(byText('beta').meta.includes('On My list'));

  let res = await app.action({ id: byText('gamma').id, op: 'listMove', value: 'up' });
  assert.match(res.message, /position 2 of 3/);
  assert.deepEqual(order(), ['alpha', 'gamma', 'beta']);
  await app.action({ id: byText('beta').id, op: 'listMove', value: 'top' });
  assert.deepEqual(order(), ['beta', 'alpha', 'gamma']);
  res = await app.action({ id: byText('beta').id, op: 'listMove', value: 'up' });
  assert.match(res.message, /Already first/);
  app.undo();
  assert.deepEqual(order(), ['alpha', 'gamma', 'beta']);

  await app.action({ id: byText('alpha').id, op: 'toggleDone' });
  assert.deepEqual(order(), ['gamma', 'beta'], 'done tasks leave the visible list');
  assert.equal(fs.readFileSync(path.join(notes, 'b.txt'), 'utf8'), before.b);

  const app2 = new App({ dir: app.dir, now: NOW, opener() {}, secretApi: { getJiraToken: () => null } });
  assert.deepEqual(items(app2, 'mylist').map((i) => i.text), ['gamma', 'beta'], 'order is persisted');
  await app.action({ id: byText('gamma').id, op: 'listToggle' });
  assert.deepEqual(order(), ['beta']);
});

test('a single text file can be added as a source and RTF files are refused', () => {
  const { notes, app } = setup({ 'a.txt': '@ one\n', 'b.txt': '@ two\n', 'c.rtf': '{\\rtf1 hi}' });
  app.setFolders([{ path: path.join(notes, 'b.txt') }]);
  assert.deepEqual(items(app).map((i) => i.text), ['two']);
  assert.throws(() => app.setFolders([{ path: path.join(notes, 'c.rtf') }]), /converted/);
  app.setFolders([{ path: notes }, { path: path.join(notes, 'sub') }]);
  assert.equal(app.browse(notes).files.includes('a.txt'), true);
});

test('triage: context, progress, flags on unmarked lines, and reviewed-file filtering', async () => {
  const { notes, app } = setup({ 'a.txt': 'Heading\nfirst thought\nsecond thought\n\nlast thought\n', 'b.txt': 'other idea\n' });
  const tri = () => items(app, 'triage', { changedOnly: true });
  const lines = tri().filter((i) => i.type === 'unmarked');
  const second = lines.find((i) => i.text === 'second thought');
  assert.ok(second.meta.some((m) => /3 of 4 to review in this file/.test(m)));
  assert.deepEqual(second.context.before, ['Heading', 'first thought']);

  await app.action({ id: second.id, op: 'important' });
  assert.match(fs.readFileSync(path.join(notes, 'a.txt'), 'utf8'), /^\*.*second thought$/m);

  const group = tri().find((i) => i.type === 'group' && /b\.txt/.test(i.text));
  await app.action({ id: group.id, op: 'reviewFile' });
  assert.ok(!tri().some((i) => /b\.txt/.test(i.text)), 'reviewed file is hidden in changed-only');
  assert.ok(items(app, 'triage').some((i) => /b\.txt/.test(i.text)), 'but still listed without the filter');
  fs.appendFileSync(path.join(notes, 'b.txt'), 'new idea\n');
  app.index.refresh(NOW());
  assert.ok(tri().some((i) => /b\.txt/.test(i.text)), 'a changed file returns');
  app.undo();
});
