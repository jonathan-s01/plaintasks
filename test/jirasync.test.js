'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { App } = require('../src/app');
const { toAdf, adfToText, parseTransitions } = require('../src/jirasync');

const NOW = () => new Date(2026, 10, 16, 9, 0, 0);

// His real site, as an example config. Nothing here talks to a real Jira: fetch is the mock below.
const SYNC = {
  project: 'A11Y',
  epic: 'A11Y-2108',
  taskType: '10002',
  subtaskType: '10003',
  startField: 'customfield_10035',
  dueField: 'duedate',
  reporter: '712020:0225302d-62d6-4dc9-ae6f-554569502d94',
  assignee: '712020:0225302d-62d6-4dc9-ae6f-554569502d94',
  transitions: 'In Discovery=3, To Do=11, In Progress=31, In Review=41, Resolved=61, Awaiting release=71, Reopen=2',
  resolutions: { done: '10000', deleted: '10001' },
};

const CATEGORY = { 'To Do': 'new', 'In Discovery': 'new', 'In Progress': 'indeterminate', 'In Review': 'indeterminate', 'Awaiting release': 'indeterminate', Resolved: 'done' };
const TRANSITIONS = { 3: 'In Discovery', 11: 'To Do', 31: 'In Progress', 41: 'In Review', 61: 'Resolved', 71: 'Awaiting release', 2: 'To Do' };
const RESOLUTIONS = { 10000: 'Done', 10001: "Won't Do" };
const status = (name) => ({ name, statusCategory: { key: CATEGORY[name] } });

function mockJira() {
  const issues = new Map();
  const calls = [];
  let next = 100;
  const add = (key, fields) => issues.set(key, { key, fields: { status: status('To Do'), resolution: null, labels: [], issuelinks: [], ...fields } });
  const reply = (code, j) => ({ ok: code < 300, status: code, json: async () => j, text: async () => (j == null ? '' : JSON.stringify(j)) });
  const fetch = async (url, opts) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const p = u.pathname.replace('/rest/api/3', '');
    calls.push({ method: opts.method, path: p, body });
    if (opts.method === 'GET' && p === '/field') return reply(200, [{ id: 'summary', name: 'Summary' }, { id: 'customfield_10021', name: 'Flagged' }]);
    if (opts.method === 'POST' && p === '/search/jql') {
      const keys = (/key in \(([^)]*)\)/.exec(body.jql) || [, ''])[1].split(',').filter(Boolean);
      return reply(200, { issues: keys.filter((k) => issues.has(k)).map((k) => structuredClone(issues.get(k))), isLast: true });
    }
    if (opts.method === 'POST' && p === '/issue') {
      const key = `A11Y-${next++}`;
      add(key, { ...body.fields });
      return reply(201, { id: '1', key });
    }
    let m = /^\/issue\/([^/]+)$/.exec(p);
    if (m && opts.method === 'PUT') {
      const is = issues.get(m[1]);
      Object.assign(is.fields, body.fields || {});
      for (const op of (body.update && body.update.labels) || []) {
        if (op.add) is.fields.labels = [...new Set([...is.fields.labels, op.add])];
        if (op.remove) is.fields.labels = is.fields.labels.filter((l) => l !== op.remove);
      }
      return reply(204, null);
    }
    m = /^\/issue\/([^/]+)\/transitions$/.exec(p);
    if (m && opts.method === 'POST') {
      const is = issues.get(m[1]);
      const name = TRANSITIONS[body.transition.id];
      is.fields.status = status(name);
      const r = body.fields && body.fields.resolution;
      is.fields.resolution = name === 'Resolved' ? { name: RESOLUTIONS[r.id] || r.name, id: r.id } : null;
      if (name === 'Resolved') is.fields.resolutiondate = '2026-11-16T09:00:00.000-0700';
      return reply(204, null);
    }
    if (opts.method === 'POST' && p === '/issueLink') {
      for (const [a, b] of [[body.inwardIssue.key, body.outwardIssue.key], [body.outwardIssue.key, body.inwardIssue.key]]) {
        issues.get(a).fields.issuelinks.push({ type: body.type, outwardIssue: { key: b } });
      }
      return reply(201, null);
    }
    return reply(404, { errorMessages: [`no mock for ${opts.method} ${p}`] });
  };
  return { issues, calls, add, fetch };
}

function setup(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sync-'));
  const notes = path.join(root, 'notes');
  fs.mkdirSync(notes, { recursive: true });
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(notes, rel), body);
  const cfg = path.join(root, 'cfg');
  fs.mkdirSync(cfg);
  const memory = { token: null };
  const secretApi = { getJiraToken: () => memory.token, setJiraToken: (t) => { memory.token = t; }, clearJiraToken: () => { memory.token = null; } };
  const jira = mockJira();
  const app = new App({ dir: cfg, now: NOW, opener() {}, secretApi, fetch: jira.fetch });
  app.setFolders([{ path: notes }]);
  app.setJira({ baseUrl: 'https://alberta.atlassian.net', type: 'cloud', email: 'me@example.test', token: 'tok', sync: SYNC });
  return { notes, app, jira };
}

const read = (notes, f) => fs.readFileSync(path.join(notes, f), 'utf8');
const fileOf = (app, name) => app.publicConfig().files.find((f) => f.label.endsWith(name)).file;
async function syncedList(app, file, extra = {}) {
  return (await app.action({ op: 'listCreate', value: { name: 'Work', file: fileOf(app, file), fileTasks: true, jiraSync: true, ...extra } })).listId;
}
/** Choices for every item as the preview ticks it; `over` maps an item id to a choice. */
const choose = (plan, over = {}) => Object.fromEntries(plan.items.map((it) => [it.id, {
  sig: it.sig,
  choice: over[it.id] || (it.group === 'conflict' ? it.choice : it.checked ? 'apply' : 'skip'),
}]));

test('jira sync: ADF notes keep links, and transitions read from text', () => {
  const doc = toAdf('see https://x.test/doc, then call');
  assert.deepEqual(doc.content[0].content[1], { type: 'text', text: 'https://x.test/doc', marks: [{ type: 'link', attrs: { href: 'https://x.test/doc' } }] });
  assert.equal(adfToText(doc), 'see https://x.test/doc, then call');
  assert.equal(toAdf('  '), null);
  assert.deepEqual(parseTransitions('To Do=11, Resolved=61'), { 'To Do': '11', Resolved: '61' });
  assert.throws(() => parseTransitions('To Do'), /To Do=11/);
});

test('jira sync: lists sync only when ticked, and need a file', async () => {
  const { app } = setup({ 'a.txt': '@ one\n' });
  await assert.rejects(() => app.action({ op: 'listCreate', value: { name: 'X', jiraSync: true } }), /Choose a file/);
  const id = (await app.action({ op: 'listCreate', value: { name: 'Plain', file: fileOf(app, 'a.txt'), fileTasks: true } })).listId;
  const plan = await app.syncPreview();
  assert.equal(plan.items.length, 0);
  assert.match(plan.message, /Sync to Jira/);
  const res = await app.action({ op: 'listEdit', list: id, value: { jiraSync: true, jiraLabels: 'a11y, team', jiraStatus: 'In Discovery' } });
  assert.match(res.message, /syncs with Jira/);
  const l = app.summary().lists.find((x) => x.id === id);
  assert.deepEqual([l.jiraSync, l.jiraLabels, l.jiraStatus], [true, ['a11y', 'team'], 'In Discovery']);
});

test('jira sync: creates Tasks under the epic and Sub-tasks under their main task, writes jira: back, links goals', async () => {
  const { notes, app, jira } = setup({
    'a.txt': '~ Build partner network goal:partner-network\n@ Write scan due:2026-12-01 goal:partner-network\n\t& see https://x.test/doc\n\t& Started 2026-11-02\n\t@ sub step\n\t\t> deeper step\n+ Old thing done:2026-11-01\n',
  });
  await syncedList(app, 'a.txt', { jiraLabels: 'a11y' });
  const plan = await app.syncPreview();
  const creates = plan.items.filter((i) => i.group === 'create');
  assert.deepEqual(creates.map((i) => [i.task, i.checked]), [['Build partner network', true], ['Write scan', true], ['sub step', true], ['deeper step', true], ['Old thing', false]]);
  assert.ok(plan.items.some((i) => i.field === 'link' && i.task === 'Write scan'));
  const before = read(notes, 'a.txt');
  assert.equal(jira.calls.filter((c) => c.method !== 'GET' && c.path !== '/search/jql').length, 0, 'the preview sends nothing');

  const res = await app.syncApply({ choices: choose(plan) });
  assert.match(res.message, /Jira sync finished/);
  assert.ok(res.results.every((r) => r.ok), JSON.stringify(res.results));
  const text = read(notes, 'a.txt');
  assert.match(text, /^~ Build partner network goal:partner-network jira:A11Y-100$/m);
  assert.match(text, /^@ Write scan due:2026-12-01 goal:partner-network jira:A11Y-101$/m);
  assert.match(text, /^\t@ sub step jira:A11Y-102$/m);
  assert.match(text, /^\t\t> deeper step jira:A11Y-103$/m);
  assert.match(text, /^\+ Old thing done:2026-11-01$/m);

  const made = (key) => jira.issues.get(key).fields;
  assert.deepEqual(made('A11Y-100').parent, { key: 'A11Y-2108' });
  assert.deepEqual(made('A11Y-100').issuetype, { id: '10002' });
  assert.equal(made('A11Y-100').status.name, 'In Progress');
  assert.deepEqual(made('A11Y-100').labels.sort(), ['a11y', 'ongoing']);
  assert.deepEqual(made('A11Y-100').reporter, { accountId: SYNC.reporter });
  assert.equal(made('A11Y-101').duedate, '2026-12-01');
  assert.equal(made('A11Y-101').customfield_10035, '2026-11-02');
  assert.equal(adfToText(made('A11Y-101').description), 'see https://x.test/doc');
  assert.equal(made('A11Y-101').description.content[0].content[1].marks[0].attrs.href, 'https://x.test/doc');
  assert.deepEqual([made('A11Y-102').issuetype, made('A11Y-102').parent], [{ id: '10003' }, { key: 'A11Y-101' }]);
  // Jira cannot nest deeper: a sub-sub-task becomes a Sub-task of the top-level task.
  assert.deepEqual(made('A11Y-103').parent, { key: 'A11Y-101' });
  assert.ok(made('A11Y-103').labels.includes('waiting'));
  assert.deepEqual(made('A11Y-103').customfield_10021, [{ value: 'Impediment' }]);
  assert.ok(made('A11Y-101').issuelinks.some((l) => l.outwardIssue.key === 'A11Y-100'));

  // Everything is in sync now, so a second run has nothing but the done task that was left out.
  const again = await app.syncPreview();
  assert.deepEqual(again.items.map((i) => i.id), plan.items.filter((i) => i.task === 'Old thing').map((i) => i.id));

  app.undo();
  assert.equal(read(notes, 'a.txt'), before, 'undo takes the jira: keys back out of the file');
});

test('jira sync: existing keys update, never create; first-sync differences are conflicts; $ closes as Won\'t Do', async () => {
  const { notes, app, jira } = setup({
    'a.txt': '+ Jurisdictional scan jira:A11Y-2591 done:2026-11-10\n% Draft memo jira:A11Y-1\n\t& background notes\n@ Call Sam jira:A11Y-2\n$ Dropped idea jira:A11Y-3\n> Waiting on legal jira:A11Y-4\n',
  });
  jira.add('A11Y-2591', { summary: 'Jurisdictional scan' });
  jira.add('A11Y-1', { summary: 'Draft memo', status: status('In Review') });
  jira.add('A11Y-2', { summary: 'Phone Sam', status: status('Resolved'), resolution: { name: 'Done', id: '10000' }, resolutiondate: '2026-11-12T10:00:00.000-0700' });
  jira.add('A11Y-3', { summary: 'Dropped idea' });
  jira.add('A11Y-4', { summary: 'Waiting on legal', labels: ['legal'] });
  await syncedList(app, 'a.txt');
  const plan = await app.syncPreview();
  const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]));
  assert.equal(plan.items.filter((i) => i.group === 'create').length, 0);
  assert.equal(byId['A11Y-2591:status'].group, 'conflict');
  assert.equal(byId['A11Y-2591:status'].choice, 'skip');
  assert.equal(byId['A11Y-1:status'], undefined, 'In Review counts as in progress');
  assert.equal(byId['A11Y-1:desc'].checked, false, 'plaintasks did not create it, so the description is not ticked');
  assert.equal(byId['A11Y-2:summary'].group, 'conflict');
  assert.equal(byId['A11Y-3:status'].group, 'push');
  assert.equal(byId['A11Y-4:flagged'].checked, true);
  assert.deepEqual(byId['A11Y-4:labels'].to, { add: ['waiting'], remove: [] });

  const res = await app.syncApply({ choices: choose(plan, { 'A11Y-2591:status': 'file', 'A11Y-2:status': 'jira', 'A11Y-2:summary': 'jira' }) });
  assert.ok(res.results.every((r) => r.ok), JSON.stringify(res.results));
  assert.equal(jira.calls.filter((c) => c.method === 'POST' && c.path === '/issue').length, 0);
  const f = (k) => jira.issues.get(k).fields;
  assert.deepEqual([f('A11Y-2591').status.name, f('A11Y-2591').resolution.name, f('A11Y-2591').duedate], ['Resolved', 'Done', '2026-11-10']);
  assert.deepEqual([f('A11Y-3').status.name, f('A11Y-3').resolution.name], ['Resolved', "Won't Do"]);
  assert.deepEqual(f('A11Y-4').labels, ['legal', 'waiting']);
  assert.equal(f('A11Y-1').description, undefined);
  assert.match(read(notes, 'a.txt'), /^\+@ Phone Sam jira:A11Y-2 done:2026-11-12$/m);
  assert.match(res.message, /Press U to undo the file changes; Jira changes stay/);

  // Left: the unticked description, and the done date just pulled into the file, which goes to Jira as the due date.
  assert.deepEqual((await app.syncPreview()).items.map((i) => i.id), ['A11Y-1:desc', 'A11Y-2:due']);
  // Then each side changes once: Jira's change is pulled, the file's is pushed.
  f('A11Y-1').status = status('Resolved');
  f('A11Y-1').resolution = { name: 'Done', id: '10000' };
  fs.writeFileSync(path.join(notes, 'a.txt'), read(notes, 'a.txt').replace('> Waiting on legal', '> Waiting on legal team'));
  const plan2 = await app.syncPreview();
  const by2 = Object.fromEntries(plan2.items.map((i) => [i.id, i]));
  assert.deepEqual([by2['A11Y-1:status'].group, by2['A11Y-1:status'].checked], ['pull', true]);
  assert.deepEqual([by2['A11Y-4:summary'].group, by2['A11Y-4:summary'].checked], ['push', false]);

  // A change after the preview is not applied.
  fs.writeFileSync(path.join(notes, 'a.txt'), read(notes, 'a.txt').replace('% Draft memo', '% Draft memo v2'));
  const stale = await app.syncApply({ choices: choose(plan2) });
  assert.ok(stale.results.some((r) => !r.ok && /changed since the preview/.test(r.text)));
  assert.match(read(notes, 'a.txt'), /^% Draft memo v2 jira:A11Y-1$/m);
});

test('jira sync: a list can send open tasks as another status, and Started notes convert to start:', async () => {
  const { notes, app, jira } = setup({ 'ideas.txt': '@ Try a thing\n\t& Started 2026-10-01\n' });
  await syncedList(app, 'ideas.txt', { jiraStatus: 'In Discovery' });
  const plan = await app.syncPreview();
  assert.equal(plan.startedNotes, 1);
  const res = app.convertStarted();
  assert.match(res.message, /Converted 1/);
  assert.equal(read(notes, 'ideas.txt'), '@ Try a thing start:2026-10-01\n');
  const t = app.view({ view: 'open', q: '', showCompleted: false }).items[0];
  assert.equal(t.text, 'Try a thing');
  assert.ok(t.meta.some((m) => /^Started /.test(m)));
  app.undo();
  assert.equal(read(notes, 'ideas.txt'), '@ Try a thing\n\t& Started 2026-10-01\n');
  app.convertStarted();

  const p2 = await app.syncPreview();
  await app.syncApply({ choices: choose(p2) });
  const is = jira.issues.get('A11Y-100').fields;
  assert.deepEqual([is.status.name, is.customfield_10035], ['In Discovery', '2026-10-01']);
  assert.equal((await app.syncPreview()).items.length, 0);
});

test('jira sync: settings are validated, stored without the token, and needed before a sync', async () => {
  const { app } = setup({ 'a.txt': '@ one\n' });
  assert.equal(app.publicConfig().jira.sync.epic, 'A11Y-2108');
  assert.equal(app.publicConfig().jira.sync.transitions['In Discovery'], '3');
  assert.throws(() => app.setJira({ baseUrl: 'https://alberta.atlassian.net', type: 'cloud', email: 'me@example.test', sync: { epic: 'nope' } }), /epic key/);
  app.setJira({ baseUrl: 'https://alberta.atlassian.net', type: 'cloud', email: 'me@example.test', sync: { taskType: '' } });
  await assert.rejects(() => app.syncPreview(), /Task issue type id/);
});

test('jira sync: label goals (jira:label) are never issues; linked tasks get prefix+id labels, and unlinking removes them', async () => {
  const { notes, app, jira } = setup({
    'a.txt': [
      '~ Advisory services goal:advisory-services jira:label',
      '\t@ Under the bucket',
      '~ Partner network goal:partner-network',
      '@ Review site goal:advisory-services goal:partner-network',
      '+ Jurisdictional scan jira:A11Y-2591 goal:advisory-services done:2026-11-10',
      '@ Other thing jira:A11Y-5',
      '',
    ].join('\n'),
  });
  jira.add('A11Y-2591', { summary: 'Jurisdictional scan', labels: ['legal'] });
  jira.add('A11Y-5', { summary: 'Other thing', labels: ['bucket-old', 'keep'] });
  await syncedList(app, 'a.txt');
  const plan = await app.syncPreview();
  const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]));
  const creates = plan.items.filter((i) => i.group === 'create');
  assert.deepEqual(creates.map((i) => i.task), ['Under the bucket', 'Partner network', 'Review site']);
  assert.equal(creates[0].parentTaskId, null, 'a task under a label goal is a main task');
  assert.match(creates[2].label, /, label bucket-advisory-services$/);
  assert.deepEqual(plan.items.filter((i) => i.field === 'link').map((i) => i.to), ['Partner network']);
  assert.deepEqual([byId['A11Y-2591:labels'].to, byId['A11Y-2591:labels'].checked], [{ add: ['bucket-advisory-services'], remove: [] }, true]);
  assert.deepEqual(byId['A11Y-5:labels'].to, { add: [], remove: ['bucket-old'] });

  const res = await app.syncApply({ choices: choose(plan) });
  assert.ok(res.results.every((r) => r.ok), JSON.stringify(res.results));
  const made = jira.calls.filter((c) => c.method === 'POST' && c.path === '/issue').map((c) => c.body.fields);
  assert.ok(!made.some((f) => /Advisory/.test(f.summary)));
  assert.deepEqual(made.find((f) => f.summary === 'Review site').labels, ['bucket-advisory-services']);
  assert.equal(jira.calls.filter((c) => c.path === '/issueLink').length, 1);
  const f = (k) => jira.issues.get(k).fields;
  assert.deepEqual(f('A11Y-2591').labels, ['legal', 'bucket-advisory-services']);
  assert.deepEqual(f('A11Y-5').labels, ['keep']);
  assert.match(read(notes, 'a.txt'), /^~ Advisory services goal:advisory-services jira:label$/m);
  assert.ok(!plan.items.some((i) => i.task === 'Advisory services'));

  fs.writeFileSync(path.join(notes, 'a.txt'), read(notes, 'a.txt').replace('jira:A11Y-2591 goal:advisory-services', 'jira:A11Y-2591'));
  const plan2 = await app.syncPreview();
  assert.deepEqual(plan2.items.find((i) => i.id === 'A11Y-2591:labels').to, { add: [], remove: ['bucket-advisory-services'] });
});

test('jira sync: Later tasks get the later label, removing later: removes it, today: is never pushed', async () => {
  const { notes, app, jira } = setup({
    'a.txt': '@ Park me later: today:2026-11-16\n@ Linked one jira:A11Y-7 later:2027-01-15\n+ Finished later: jira:A11Y-8 done:2026-11-10\n',
  });
  jira.add('A11Y-7', { summary: 'Linked one', labels: ['keep'] });
  jira.add('A11Y-8', { summary: 'Finished', labels: [] });
  await syncedList(app, 'a.txt');
  const plan = await app.syncPreview();
  const create = plan.items.find((i) => i.group === 'create' && i.task === 'Park me');
  assert.match(create.label, /, label later$/);
  const upd = plan.items.find((i) => i.id === 'A11Y-7:labels');
  assert.deepEqual([upd.to, upd.checked], [{ add: ['later'], remove: [] }, true]);
  assert.ok(!plan.items.some((i) => i.id === 'A11Y-8:labels'), 'done tasks are not labelled Later');
  const res = await app.syncApply({ choices: choose(plan) });
  assert.ok(res.results.every((r) => r.ok), JSON.stringify(res.results));
  const made = jira.calls.filter((c) => c.method === 'POST' && c.path === '/issue').map((c) => c.body);
  assert.deepEqual(made[0].fields.labels, ['later']);
  assert.ok(!JSON.stringify(jira.calls).includes('today'), 'today: is never sent');
  assert.deepEqual(jira.issues.get('A11Y-7').fields.labels, ['keep', 'later']);

  fs.writeFileSync(path.join(notes, 'a.txt'), read(notes, 'a.txt').replace(' later:2027-01-15', ''));
  const plan2 = await app.syncPreview();
  assert.deepEqual(plan2.items.find((i) => i.id === 'A11Y-7:labels').to, { add: [], remove: ['later'] });
});
