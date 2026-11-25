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
  priorities: { high: 'High', medium: 'Medium', low: 'Low' },
  blockType: 'Blocks',
};

const CATEGORY = { 'To Do': 'new', 'In Discovery': 'new', 'In Progress': 'indeterminate', 'In Review': 'indeterminate', 'Awaiting release': 'indeterminate', Resolved: 'done' };
const TRANSITIONS = { 3: 'In Discovery', 11: 'To Do', 31: 'In Progress', 41: 'In Review', 61: 'Resolved', 71: 'Awaiting release', 2: 'To Do' };
const RESOLUTIONS = { 10000: 'Done', 10001: "Won't Do" };
const status = (name) => ({ name, statusCategory: { key: CATEGORY[name] } });

function mockJira() {
  const issues = new Map();
  const calls = [];
  // Jira's search index can lag behind a create; while true, new issues are missing from /search/jql.
  const state = { lag: false, fresh: new Set() };
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
      return reply(200, { issues: keys.filter((k) => issues.has(k) && !(state.lag && state.fresh.has(k))).map((k) => structuredClone(issues.get(k))), isLast: true });
    }
    if (opts.method === 'POST' && p === '/issue') {
      const key = `A11Y-${next++}`;
      add(key, { ...body.fields });
      state.fresh.add(key);
      return reply(201, { id: '1', key });
    }
    let m = /^\/issue\/([^/]+)$/.exec(p);
    if (m && opts.method === 'GET') return issues.has(m[1]) ? reply(200, structuredClone(issues.get(m[1]))) : reply(404, { errorMessages: ['not found'] });
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
    if (m && opts.method === 'POST' && state.failTransitions) return reply(400, { errorMessages: ['Transition is not valid'] });
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
      const id = String(next++);
      issues.get(body.inwardIssue.key).fields.issuelinks.push({ id, type: body.type, outwardIssue: { key: body.outwardIssue.key } });
      issues.get(body.outwardIssue.key).fields.issuelinks.push({ id, type: body.type, inwardIssue: { key: body.inwardIssue.key } });
      return reply(201, null);
    }
    m = /^\/issueLink\/([^/]+)$/.exec(p);
    if (m && opts.method === 'DELETE') {
      for (const is of issues.values()) is.fields.issuelinks = is.fields.issuelinks.filter((l) => l.id !== m[1]);
      return reply(204, null);
    }
    return reply(404, { errorMessages: [`no mock for ${opts.method} ${p}`] });
  };
  return { issues, calls, add, fetch, state };
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
const fileOf = (app, name) => app.publicConfig().files.find((f) => f.file.endsWith(name)).file;
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

test('jira sync: creates Tasks under the epic and Sub-tasks under their main task, writes jira: back, and a ~ line is an ordinary task with no Relates links', async () => {
  const { notes, app, jira } = setup({
    'a.txt': '~ Build partner network goal:partner-network jira:yes\n@ Write scan due:2026-12-01 goal:partner-network jira:yes\n\t& see https://x.test/doc\n\t& Started 2026-11-02\n\t> sub step\n\t\t& ask legal\n\t\t@ deeper step p:high\n\t\t\t+ deepest done:2026-11-10\n+ Old thing done:2026-11-01 jira:yes\n',
  });
  await syncedList(app, 'a.txt', { jiraLabels: 'a11y' });
  const plan = await app.syncPreview();
  const creates = plan.items.filter((i) => i.group === 'create');
  assert.deepEqual(creates.map((i) => [i.task, i.checked]), [['Build partner network', true], ['Write scan', true], ['sub step', true], ['Old thing', true]]);
  assert.match(creates[2].label, /^Create Sub-task of Write scan, .*includes 2 checklist items$/);
  assert.ok(!plan.info.some((i) => /deeper|deepest/.test(i.task)), 'checklist items are not listed as not synced');
  assert.ok(!plan.items.some((i) => i.field === 'link'), 'no Relates links: ~ is only a status');
  const before = read(notes, 'a.txt');
  assert.equal(jira.calls.filter((c) => c.method !== 'GET' && c.path !== '/search/jql').length, 0, 'the preview sends nothing');

  const oldThing = creates.find((i) => i.task === 'Old thing').id;
  const res = await app.syncApply({ choices: choose(plan, { [oldThing]: 'skip' }) });
  assert.match(res.message, /Jira sync finished/);
  assert.ok(res.results.every((r) => r.ok), JSON.stringify(res.results));
  const text = read(notes, 'a.txt');
  assert.match(text, /^~ Build partner network goal:partner-network jira:A11Y-100$/m);
  assert.match(text, /^@ Write scan due:2026-12-01 goal:partner-network jira:A11Y-101$/m);
  assert.match(text, /^\t> sub step jira:A11Y-102$/m);
  assert.match(text, /^\t\t@ deeper step p:high$/m, 'the third level is not an issue');
  assert.match(text, /^\+ Old thing done:2026-11-01 jira:yes$/m, 'not created, so it keeps its mark');

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
  assert.ok(made('A11Y-102').labels.includes('waiting'));
  assert.deepEqual(made('A11Y-102').customfield_10021, [{ value: 'Impediment' }]);
  // Two levels only: deeper tasks are the Sub-task's checklist, after its notes, nested as in the file.
  assert.ok(!jira.issues.has('A11Y-103'));
  const desc = made('A11Y-102').description;
  assert.deepEqual(desc.content.map((n) => n.type), ['paragraph', 'taskList']);
  const tl = desc.content[1].content;
  assert.deepEqual([tl[0].type, tl[0].attrs.state, tl[0].content[0].text], ['taskItem', 'TODO', 'deeper step']);
  assert.deepEqual([tl[1].type, tl[1].content[0].attrs.state, tl[1].content[0].content[0].text], ['taskList', 'DONE', 'deepest']);
  assert.equal(adfToText(desc), 'ask legal\n[ ] deeper step\n- [x] deepest');
  assert.ok(!jira.calls.some((c) => c.path === '/issueLink'));

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
  const { notes, app, jira } = setup({ 'ideas.txt': '@ Try a thing jira:yes\n\t& Started 2026-10-01\n' });
  await syncedList(app, 'ideas.txt', { jiraStatus: 'In Discovery' });
  const plan = await app.syncPreview();
  assert.equal(plan.startedNotes, 1);
  const res = app.convertStarted();
  assert.match(res.message, /Converted 1/);
  assert.equal(read(notes, 'ideas.txt'), '@ Try a thing jira:yes start:2026-10-01\n');
  const t = app.view({ view: 'open', q: '', showCompleted: false }).items[0];
  assert.equal(t.text, 'Try a thing');
  assert.ok(t.meta.some((m) => /^Started /.test(m)));
  app.undo();
  assert.equal(read(notes, 'ideas.txt'), '@ Try a thing jira:yes\n\t& Started 2026-10-01\n');
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

test('jira sync: buckets (jira:label) are never issues; tasks and sub-tasks get prefix+id labels from their effective buckets, and unlinking removes them', async () => {
  const { notes, app, jira } = setup({
    'a.txt': [
      '~ Advisory services goal:advisory-services jira:label',
      '\t@ Under the bucket jira:yes',
      '~ Partner network goal:partner-network jira:yes',
      '@ Review site goal:advisory-services goal:partner-network jira:yes',
      '\t@ Review sub',
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
  assert.deepEqual(creates.map((i) => i.task), ['Under the bucket', 'Partner network', 'Review site', 'Review sub']);
  assert.equal(creates[0].parentTaskId, null, 'a task under a bucket is a main task');
  assert.match(creates[0].label, /, label bucket-advisory-services$/);
  assert.doesNotMatch(creates[1].label, /label bucket/);
  assert.match(creates[2].label, /, label bucket-advisory-services$/);
  assert.match(creates[3].label, /, label bucket-advisory-services$/, 'a sub-task inherits its parent bucket');
  assert.equal(plan.items.filter((i) => i.field === 'link').length, 0);
  assert.deepEqual([byId['A11Y-2591:labels'].to, byId['A11Y-2591:labels'].checked], [{ add: ['bucket-advisory-services'], remove: [] }, true]);
  assert.deepEqual(byId['A11Y-5:labels'].to, { add: [], remove: ['bucket-old'] });

  const res = await app.syncApply({ choices: choose(plan) });
  assert.ok(res.results.every((r) => r.ok), JSON.stringify(res.results));
  const made = jira.calls.filter((c) => c.method === 'POST' && c.path === '/issue').map((c) => c.body.fields);
  assert.ok(!made.some((f) => /Advisory/.test(f.summary)));
  assert.deepEqual(made.find((f) => f.summary === 'Review site').labels, ['bucket-advisory-services']);
  assert.equal(jira.calls.filter((c) => c.path === '/issueLink').length, 0);
  assert.deepEqual(made.find((f) => f.summary === 'Review sub').labels, ['bucket-advisory-services']);
  const f = (k) => jira.issues.get(k).fields;
  assert.deepEqual(f('A11Y-2591').labels, ['legal', 'bucket-advisory-services']);
  assert.deepEqual(f('A11Y-5').labels, ['keep']);
  assert.match(read(notes, 'a.txt'), /^~ Advisory services goal:advisory-services jira:label$/m);
  assert.ok(!plan.items.some((i) => i.task === 'Advisory services'));

  fs.writeFileSync(path.join(notes, 'a.txt'), read(notes, 'a.txt').replace('jira:A11Y-2591 goal:advisory-services', 'jira:A11Y-2591'));
  const plan2 = await app.syncPreview();
  assert.deepEqual(plan2.items.find((i) => i.id === 'A11Y-2591:labels').to, { add: [], remove: ['bucket-advisory-services'] });
});

test('jira sync: priority is sent on create and update, pulled back, and an unknown Jira name is not ticked', async () => {
  const { notes, app, jira } = setup({
    'a.txt': '@ Urgent thing p:high jira:yes\n@ Normal thing jira:yes\n@ Linked jira:A11Y-7 p:low\n@ Other jira:A11Y-8\n@ Odd jira:A11Y-9\n',
  });
  jira.add('A11Y-7', { summary: 'Linked', priority: { name: 'Medium' } });
  jira.add('A11Y-8', { summary: 'Other', priority: { name: 'High' } });
  jira.add('A11Y-9', { summary: 'Odd', priority: { name: 'Highest' } });
  await syncedList(app, 'a.txt');
  const plan = await app.syncPreview();
  const by = Object.fromEntries(plan.items.map((i) => [i.id, i]));
  assert.match(plan.items.find((i) => i.group === 'create' && i.task === 'Urgent thing').label, /priority High/);
  assert.equal(by['A11Y-7:priority'].group, 'conflict', 'first sync with different values is a conflict');
  assert.deepEqual([by['A11Y-9:priority'].group, by['A11Y-9:priority'].checked], ['push', false]);
  const res = await app.syncApply({ choices: choose(plan, { 'A11Y-7:priority': 'file', 'A11Y-8:priority': 'jira' }) });
  assert.ok(res.results.every((r) => r.ok), JSON.stringify(res.results));
  const made = jira.calls.filter((c) => c.method === 'POST' && c.path === '/issue').map((c) => c.body.fields);
  assert.deepEqual(made[0].priority, { name: 'High' });
  assert.equal(made[1].priority, undefined, 'Medium is the default and is not sent');
  assert.deepEqual(jira.issues.get('A11Y-7').fields.priority, { name: 'Low' });
  assert.match(read(notes, 'a.txt'), /^@ Other jira:A11Y-8 p:high$/m);

  // Afterwards each side changes once: three-way compare pushes the file, pulls Jira.
  fs.writeFileSync(path.join(notes, 'a.txt'), read(notes, 'a.txt').replace('Linked jira:A11Y-7 p:low', 'Linked jira:A11Y-7'));
  jira.issues.get('A11Y-8').fields.priority = { name: 'Low' };
  const plan2 = await app.syncPreview();
  const by2 = Object.fromEntries(plan2.items.map((i) => [i.id, i]));
  assert.deepEqual([by2['A11Y-7:priority'].group, by2['A11Y-7:priority'].to], ['push', 'medium']);
  assert.deepEqual([by2['A11Y-8:priority'].group, by2['A11Y-8:priority'].to], ['pull', 'low']);
  await app.syncApply({ choices: choose(plan2) });
  assert.equal(jira.issues.get('A11Y-7').fields.priority.name, 'Medium');
  assert.match(read(notes, 'a.txt'), /^@ Other jira:A11Y-8 p:low$/m);
  assert.ok(!JSON.stringify(jira.calls).includes('today'), 'today: is never sent');
});

test('jira sync: Blocks links are added when a task waits, removed only when plaintasks made them', async () => {
  const { notes, app, jira } = setup({
    'a.txt': '@ Write code id:write-code jira:A11Y-7\n@ Release after:write-code jira:A11Y-8\n@ New dependent after:write-code jira:yes\n@ Stray after:nobody jira:A11Y-9\n',
  });
  jira.add('A11Y-7', { summary: 'Write code' });
  jira.add('A11Y-8', { summary: 'Release' });
  jira.add('A11Y-9', { summary: 'Stray', issuelinks: [{ id: '900', type: { name: 'Blocks' }, inwardIssue: { key: 'A11Y-1' } }] });
  await syncedList(app, 'a.txt');
  const plan = await app.syncPreview();
  const blocks = plan.items.filter((i) => i.field === 'block');
  assert.deepEqual(blocks.map((i) => [i.task, i.checked]), [['Release', true], ['New dependent', true]]);
  assert.ok(!plan.items.some((i) => i.field === 'unblock'), 'a link plaintasks did not make is left alone');
  const res = await app.syncApply({ choices: choose(plan) });
  assert.ok(res.results.every((r) => r.ok), JSON.stringify(res.results));
  const link = jira.calls.find((c) => c.path === '/issueLink' && c.body.outwardIssue.key === 'A11Y-8');
  assert.deepEqual([link.body.type, link.body.inwardIssue.key], [{ name: 'Blocks' }, 'A11Y-7']);
  const newKey = read(notes, 'a.txt').match(/New dependent after:write-code jira:(A11Y-\d+)/)[1];
  assert.ok(jira.issues.get(newKey).fields.issuelinks.some((l) => l.inwardIssue.key === 'A11Y-7'));
  assert.equal((await app.syncPreview()).items.filter((i) => i.field === 'block').length, 0);

  // Dropping the after: token removes the link plaintasks made.
  fs.writeFileSync(path.join(notes, 'a.txt'), read(notes, 'a.txt').replace('Release after:write-code', 'Release'));
  const plan2 = await app.syncPreview();
  const un = plan2.items.filter((i) => i.field === 'unblock');
  assert.deepEqual(un.map((i) => [i.task, i.blockerKey]), [['Release', 'A11Y-7']]);
  await app.syncApply({ choices: choose(plan2) });
  assert.ok(jira.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/issueLink/')));
  assert.equal(jira.issues.get('A11Y-8').fields.issuelinks.filter((l) => l.type.name === 'Blocks').length, 0);
});

test('jira sync: open questions without a key are not created, nor their subtasks; linked questions still sync', async () => {
  const { app, jira } = setup({ 'a.txt': '? which code jira:yes\n\t@ sub of question\n@? linked question jira:A11Y-7\n@ normal jira:yes\n' });
  jira.add('A11Y-7', { summary: 'Linked question renamed' });
  await syncedList(app, 'a.txt');
  const plan = await app.syncPreview();
  assert.deepEqual(plan.items.filter((i) => i.group === 'create').map((i) => i.task), ['normal']);
  assert.ok(plan.items.some((i) => i.key === 'A11Y-7'), 'the linked question is still compared');
  assert.ok(plan.info.some((i) => /open question\.$/.test(i.text) && i.task === 'which code'), JSON.stringify(plan.info));
  assert.ok(plan.info.some((i) => /main task, which code, is an open question/.test(i.text)), JSON.stringify(plan.info));
});

test('jira sync: two levels only; deeper tasks are the Sub-task checklist, changes to them update its description, and a linked deep task still syncs', async () => {
  const { notes, app, jira } = setup({
    'a.txt': '@ Main jira:yes\n\t@ Sub\n\t\t@ step one\n\t\t@ linked deep jira:A11Y-3\n\t\t\t@ under linked\n\t\t? open q\n\t\t\t@ under q\n',
  });
  jira.add('A11Y-3', { summary: 'linked deep, renamed in Jira' });
  await syncedList(app, 'a.txt');
  const plan = await app.syncPreview();
  const creates = plan.items.filter((i) => i.group === 'create');
  assert.deepEqual(creates.map((i) => i.task), ['Main', 'Sub']);
  assert.match(creates[1].label, /includes 2 checklist items$/);
  assert.equal(plan.items.find((i) => i.id === 'A11Y-3:summary').group, 'conflict', 'a deep line already in Jira keeps syncing');
  assert.deepEqual(plan.info.map((i) => i.task), [], 'deeper unlinked lines and questions are not listed as not synced');
  await app.syncApply({ choices: choose(plan) });
  assert.equal(adfToText(jira.issues.get('A11Y-101').fields.description), '[ ] step one\n[ ] under linked');

  const file = path.join(notes, 'a.txt');
  fs.writeFileSync(file, read(notes, 'a.txt').replace('\t\t@ step one', '\t\t+ step one done:2026-11-16') + '\t\t@ step two\n');
  const again = await app.syncPreview();
  const desc = again.items.find((i) => i.id === 'A11Y-101:desc');
  assert.deepEqual([desc.group, desc.checked, desc.label], ['push', true, 'Description: 3 checklist items']);
  assert.ok(!again.items.some((i) => i.group === 'create'));
  await app.syncApply({ choices: choose(again) });
  assert.equal(adfToText(jira.issues.get('A11Y-101').fields.description), '[x] step one\n[ ] under linked\n[ ] step two');
  assert.ok(!(await app.syncPreview()).items.some((i) => i.id === 'A11Y-101:desc'), 'in sync after the update');
});

test('jira sync: jira:skip keeps a line and everything under it out; a linked one is reported and its issue left alone', async () => {
  const { app, jira } = setup({
    'a.txt': '@ Keep me jira:yes\n@ Admin stuff id:adm jira:skip jira:yes\n\t@ child admin\n\t@ linked child jira:A11Y-5\n@ Blocked thing after:adm jira:yes\n',
    'b.txt': 'Personal jira:skip\n@ errand jira:yes\n',
  });
  jira.add('A11Y-5', { summary: 'something else' });
  await syncedList(app, 'a.txt');
  await app.action({ op: 'listCreate', value: { name: 'Home', file: fileOf(app, 'b.txt'), fileTasks: true, jiraSync: true } });
  const plan = await app.syncPreview();
  assert.deepEqual(plan.items.filter((i) => i.group === 'create').map((i) => i.task), ['Keep me', 'Blocked thing']);
  assert.ok(!plan.items.some((i) => i.field === 'block' || i.key === 'A11Y-5'));
  assert.deepEqual(plan.info.map((i) => [i.task, i.text]), [['linked child', 'Not synced: skipped (jira:skip); linked issue A11Y-5 left in Jira.']]);
  await app.syncApply({ choices: choose(plan) });
  assert.ok(!jira.calls.some((c) => c.method !== 'GET' && c.path.includes('A11Y-5')));
  assert.equal(jira.issues.get('A11Y-5').fields.summary, 'something else');

  const meta = (text) => app.view({ view: 'open', q: '', showCompleted: false }).items.find((i) => i.text === text).meta;
  assert.ok(meta('Admin stuff').includes('Not synced to Jira (jira:skip)'));
  assert.ok(meta('child admin').includes('Not synced to Jira (jira:skip, inherited from parent: Admin stuff)'));
  assert.ok(meta('errand').includes('Not synced to Jira (jira:skip, inherited from list: Personal)'));
});

test('jira sync: opt-in; only main tasks marked jira:yes are created, subtasks of marked or linked tasks go along, and j toggles the mark', async () => {
  const { notes, app, jira } = setup({
    'a.txt': '@ Unmarked\n\t@ unmarked child\n@ Marked jira:yes\n\t@ auto child\n\t\t@ deep\n@ Linked jira:A11Y-7\n\t@ new under linked\n? q unmarked\n',
  });
  jira.add('A11Y-7', { summary: 'Linked' });
  await syncedList(app, 'a.txt');
  const items = () => app.view({ view: 'open', q: '', showCompleted: false }).items;
  const item = (text) => items().find((i) => i.text === text);
  assert.ok(item('Marked').meta.includes('Goes to Jira (jira:yes)'));
  assert.ok(item('auto child').meta.includes('Goes to Jira as a Sub-task of Marked'));
  assert.ok(item('deep').meta.includes('Goes to Jira as a checklist item in auto child'));
  assert.ok(item('new under linked').meta.includes('Goes to Jira as a Sub-task of Linked'));
  assert.ok(!item('Unmarked').meta.some((m) => /Jira/.test(m)), 'unmarked lines stay quiet');
  assert.equal(item('Marked').text, 'Marked', 'the token is hidden');

  const plan = await app.syncPreview();
  assert.deepEqual(plan.items.filter((i) => i.group === 'create').map((i) => i.task), ['Marked', 'auto child', 'new under linked']);
  assert.deepEqual(plan.info, [], 'unmarked main tasks and their subtasks are not listed');
  await app.syncApply({ choices: choose(plan) });
  const text = read(notes, 'a.txt');
  assert.match(text, /^@ Marked jira:A11Y-100$/m, 'jira:yes is dropped once the line has a key');
  assert.match(text, /^\t@ new under linked jira:A11Y-\d+$/m);
  assert.match(text, /^@ Unmarked$/m);

  const before = read(notes, 'a.txt');
  const on = await app.action({ id: item('Unmarked').id, op: 'jiraYes' });
  assert.equal(on.message, 'Will go to Jira: Unmarked');
  assert.match(read(notes, 'a.txt'), /^@ Unmarked jira:yes$/m);
  const off = await app.action({ id: item('Unmarked').id, op: 'jiraYes' });
  assert.equal(off.message, "Won't go to Jira: Unmarked");
  await app.action({ id: item('Unmarked').id, op: 'jiraYes' });
  app.undo();
  app.undo();
  app.undo();
  assert.equal(read(notes, 'a.txt'), before, 'each toggle is undoable');
  assert.match((await app.action({ id: item('unmarked child').id, op: 'jiraYes' })).message, /Press j on the main task instead: Unmarked$/);
  assert.match((await app.action({ id: item('Linked').id, op: 'jiraYes' })).message, /^Already in Jira as A11Y-7/);
  assert.equal(read(notes, 'a.txt'), before, 'refusals write nothing');
});

test('jira sync: a done task created in Jira ends up resolved even when search lags, and a first-sync status conflict on an issue plaintasks made keeps the file', async () => {
  const { notes, app, jira } = setup({ 'a.txt': '+ Finished audit done:2026-11-10 jira:yes\n' });
  await syncedList(app, 'a.txt');
  jira.state.lag = true;
  const plan = await app.syncPreview();
  const res = await app.syncApply({ choices: choose(plan, { [plan.items[0].id]: 'apply' }) });
  assert.ok(res.results.every((r) => r.ok), JSON.stringify(res.results));
  assert.match(read(notes, 'a.txt'), /jira:A11Y-100/);
  const f = jira.issues.get('A11Y-100').fields;
  assert.deepEqual([f.status.name, f.resolution.name, f.duedate], ['Resolved', 'Done', '2026-11-10']);
  const creates = jira.calls.findIndex((c) => c.method === 'POST' && c.path === '/issue');
  assert.ok(jira.calls.slice(creates).some((c) => c.path === '/issue/A11Y-100/transitions' && c.body.fields.resolution.id === '10000'), 'resolved in the same apply');

  // An issue plaintasks created that is still To Do with no status snapshot: the file side is preselected.
  jira.state.lag = false;
  f.status = status('To Do');
  f.resolution = null;
  delete app.stateData.jira.synced['A11Y-100'];
  const again = await app.syncPreview();
  const conflict = again.items.find((i) => i.id === 'A11Y-100:status');
  assert.deepEqual([conflict.group, conflict.choice], ['conflict', 'file']);
});

test('jira sync: when the status transition after a create fails, the result says the issue was created and its status was not set', async () => {
  const { notes, app, jira } = setup({ 'a.txt': '+ Finished audit done:2026-11-10 jira:yes\n' });
  await syncedList(app, 'a.txt');
  jira.state.failTransitions = true;
  const plan = await app.syncPreview();
  const res = await app.syncApply({ choices: choose(plan, { [plan.items[0].id]: 'apply' }) });
  assert.deepEqual(res.results.map((r) => r.ok), [false]);
  assert.match(res.results[0].text, /^Created A11Y-100: Finished audit, but could not set its status to Resolved: .*Transition is not valid/);
  assert.match(read(notes, 'a.txt'), /jira:A11Y-100/, 'the key is still written, so it is not created twice');
});
