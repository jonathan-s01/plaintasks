'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { App } = require('../src/app');

const NOW = () => new Date(2026, 10, 16, 9, 0, 0);

function setup(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-feat-'));
  const notes = path.join(root, 'notes');
  fs.mkdirSync(notes, { recursive: true });
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(notes, rel), body);
  const cfg = path.join(root, 'cfg');
  fs.mkdirSync(cfg);
  const app = new App({ dir: cfg, now: NOW, opener() {}, secretApi: { getJiraToken: () => null } });
  app.setFolders([{ path: notes }]);
  return { notes, app };
}

const items = (app, view = 'open', extra = {}) => app.view({ view, q: '', showCompleted: false, ...extra }).items;
const find = (app, text, view = 'open') => items(app, view).find((i) => i.text === text);
const read = (notes, f) => fs.readFileSync(path.join(notes, f), 'utf8');

test('a note goes under the last existing note, stamped, and undo removes it', async () => {
  const { notes, app } = setup({ 'a.txt': '@ call Sam\n  first note\n@ other\n' });
  await app.action({ id: find(app, 'call Sam').id, op: 'addNote', value: { text: 'second note' } });
  assert.equal(read(notes, 'a.txt'), '@ call Sam\n  first note\n  [2026-11-16] second note\n@ other\n');
  assert.deepEqual(find(app, 'call Sam').notes, ['first note', '[2026-11-16] second note']);
  app.undo();
  assert.equal(read(notes, 'a.txt'), '@ call Sam\n  first note\n@ other\n');
});

test('a note on a task with no notes goes directly below it, and the list name is stamped', async () => {
  const { notes, app } = setup({ 'a.txt': '@ call Sam' });
  const list = (await app.action({ op: 'listCreate', value: 'Agenda' })).listId;
  await app.action({ id: find(app, 'call Sam').id, op: 'addNote', value: { text: 'asked about budget' }, list });
  assert.equal(read(notes, 'a.txt'), '@ call Sam\n  [2026-11-16, Agenda] asked about budget');
  await assert.rejects(() => app.action({ id: find(app, 'call Sam').id, op: 'addNote', value: { text: '+ oops' } }), /task symbol/);
});

test('edit renames a task keeping its tokens, rewrites notes in place, and one undo reverses both', async () => {
  const { notes, app } = setup({ 'a.txt': '@ call Sam due:2026-12-01 p:high\n  first note\n  & amp note\n@ other\n' });
  const t = find(app, 'call Sam');
  assert.equal(t.fileNotes, 2);
  const res = await app.action({ id: t.id, op: 'edit', value: { text: 'phone Sam  today', notes: ['first, changed', 'amp changed'] } });
  assert.equal(read(notes, 'a.txt'), '@ phone Sam today due:2026-12-01 p:high\n  first, changed\n  & amp changed\n@ other\n');
  assert.equal(app.task(res.focusId).text, 'phone Sam today');
  assert.match(res.message, /Renamed to: phone Sam today\. 2 notes updated/);
  app.undo();
  assert.equal(read(notes, 'a.txt'), '@ call Sam due:2026-12-01 p:high\n  first note\n  & amp note\n@ other\n');
});

test('edit refuses empty names, symbol-led notes and changed note counts, and writes nothing', async () => {
  const { notes, app } = setup({ 'a.txt': '@ call Sam\n  first note\n' });
  const before = read(notes, 'a.txt');
  const id = find(app, 'call Sam').id;
  await assert.rejects(() => app.action({ id, op: 'edit', value: { text: '  ' } }), /cannot be empty/);
  await assert.rejects(() => app.action({ id, op: 'edit', value: { text: 'x', notes: ['+ oops'] } }), /task symbol/);
  await assert.rejects(() => app.action({ id, op: 'edit', value: { text: 'x', notes: [] } }), /notes changed/);
  await assert.rejects(() => app.action({ id, op: 'edit', value: { text: 'x', notes: [''] } }), /empty/);
  assert.equal(read(notes, 'a.txt'), before);
  const same = await app.action({ id, op: 'edit', value: { text: 'call Sam', notes: ['first note'] } });
  assert.match(same.message, /No change/);
});

test('Tab makes a subtask with its notes and children, Shift+Tab undoes it', async () => {
  const { notes, app } = setup({ 'a.txt': '@ parent\n@ child\n  note under child\n  @ grandchild\n@ other\n' });
  await app.action({ id: find(app, 'child').id, op: 'indent' });
  assert.equal(read(notes, 'a.txt'), '@ parent\n  @ child\n    note under child\n    @ grandchild\n@ other\n');
  assert.equal(find(app, 'child').level, 2);
  assert.equal(find(app, 'grandchild').level, 3);
  await app.action({ id: find(app, 'child').id, op: 'outdent' });
  assert.equal(read(notes, 'a.txt'), '@ parent\n@ child\n  note under child\n  @ grandchild\n@ other\n');
  app.undo();
  assert.equal(find(app, 'child').level, 2);
  await assert.rejects(() => app.action({ id: find(app, 'parent').id, op: 'indent' }), /no task above/);
  await assert.rejects(() => app.action({ id: find(app, 'other').id, op: 'outdent' }), /top level/);
});

test('Shift+Tab on a • subtask moves it up a level by removing the •, keeping its other markers', async () => {
  const { notes, app } = setup({ 'a.txt': '@ parent\n•% sub\n\t• deeper\n' });
  await app.action({ id: find(app, 'deeper').id, op: 'outdent' });
  assert.equal(read(notes, 'a.txt'), '@ parent\n•% sub\n• deeper\n');
  assert.equal(find(app, 'deeper').level, 2);
  await app.action({ id: find(app, 'sub').id, op: 'outdent' });
  assert.equal(read(notes, 'a.txt'), '@ parent\n% sub\n• deeper\n');
  assert.equal(find(app, 'sub').level, 1);
  app.undo();
  assert.equal(read(notes, 'a.txt'), '@ parent\n•% sub\n• deeper\n');
});

test('Tab on an unmarked line in triage makes it a subtask of the task above', async () => {
  const { notes, app } = setup({ 'a.txt': '@ parent\nstray idea\n' });
  const stray = items(app, 'triage').find((i) => i.text === 'stray idea');
  // directly under a task it is already a note, so it is not in triage
  assert.equal(stray, undefined);
  fs.writeFileSync(path.join(notes, 'b.txt'), '@ top\n\n@ lone\n');
  app.index.refresh(NOW());
  await assert.rejects(() => app.action({ id: find(app, 'lone').id, op: 'indent' }), /no task above|blank line/);
});

test('new task is appended to the master file, asks first if none is set, and joins a list', async () => {
  const { notes, app } = setup({ 'master.txt': '@ existing\n' });
  await assert.rejects(() => app.action({ op: 'newTask', value: { text: 'buy milk' } }), (e) => e.code === 'no-master');
  app.setMaster({ path: path.join(notes, 'master.txt') });
  const list = (await app.action({ op: 'listCreate', value: 'Errands' })).listId;
  const res = await app.action({ op: 'newTask', value: { text: 'buy milk' }, list });
  assert.equal(read(notes, 'master.txt'), '@ existing\n@ buy milk\n');
  assert.deepEqual(items(app, `list:${list}`).map((i) => i.text), ['buy milk']);
  assert.ok(res.focusId);
  assert.deepEqual(app.searchTasks('milk').results.map((r) => r.text), ['buy milk']);
  assert.throws(() => app.setMaster({ path: '/etc/hosts' }), /watched folders/);
});

test('creating a master file works and tasks can be added to a file with no trailing newline', async () => {
  const { notes, app } = setup({});
  app.setMaster({ create: { folder: notes, name: 'inbox' } });
  await app.action({ op: 'newTask', value: { text: 'first' } });
  await app.action({ op: 'newTask', value: { text: 'second' } });
  assert.equal(read(notes, 'inbox.txt'), '@ first\n@ second\n');
  fs.writeFileSync(path.join(notes, 'inbox.txt'), '@ first');
  await app.action({ op: 'newTask', value: { text: 'third' } });
  assert.equal(read(notes, 'inbox.txt'), '@ first\n@ third');
});

test('list sorting changes order, manual reorder is only allowed in manual mode', async () => {
  const { app } = setup({ 'a.txt': '@ beta due:2026-11-20\n@ alpha due:2026-11-18\n@ gamma\n' });
  const list = 'mylist';
  for (const t of ['beta', 'alpha', 'gamma']) await app.action({ id: find(app, t).id, op: 'listAdd', list });
  const names = () => items(app, `list:${list}`).map((i) => i.text);
  assert.deepEqual(names(), ['beta', 'alpha', 'gamma']);
  await app.action({ op: 'listSort', list, value: 'due' });
  assert.deepEqual(names(), ['alpha', 'beta', 'gamma']);
  await app.action({ op: 'listSort', list, value: 'name' });
  assert.deepEqual(names(), ['alpha', 'beta', 'gamma']);
  await assert.rejects(() => app.action({ id: find(app, 'gamma', `list:${list}`).id, op: 'listMove', value: 'up', list }), /sorted automatically/);
  await app.action({ op: 'listSort', list, value: 'manual' });
  assert.deepEqual(names(), ['beta', 'alpha', 'gamma']);
  await assert.rejects(() => app.action({ op: 'listSort', list, value: 'nope' }), /Sort by/);
});

test('a list with a notes file takes notes that are not tasks, sorted last by type', async () => {
  const { notes, app } = setup({ 'a.txt': '@ talk budget\n' });
  const list = (await app.action({ op: 'listCreate', value: { name: 'Team meeting', folder: 'Meetings', notesFolder: notes } })).listId;
  const file = path.join(notes, 'Team meeting.txt');
  assert.equal(read(notes, 'Team meeting.txt'), 'Team meeting\nCreated 2026-11-16\n');
  assert.deepEqual(items(app, 'triage').filter((i) => i.type === 'unmarked' && !i.known), [], 'generated lines are not in triage');
  await app.action({ op: 'listNote', value: { text: 'remember to bring laptop' }, list });
  await app.action({ id: find(app, 'talk budget').id, op: 'listAdd', list });
  assert.match(read(notes, 'Team meeting.txt'), /\n\[2026-11-16\] remember to bring laptop\n$/);
  const view = items(app, `list:${list}`);
  assert.deepEqual(view.map((i) => [i.type, i.text]), [['note', '[2026-11-16] remember to bring laptop'], ['task', 'talk budget']]);
  assert.deepEqual(items(app, 'triage').filter((i) => i.type === 'unmarked' && !i.known), []);
  await app.action({ op: 'listSort', list, value: 'type' });
  assert.deepEqual(items(app, `list:${list}`).map((i) => i.type), ['task', 'note']);
  const all = items(app, 'lists');
  assert.deepEqual(all.map((i) => i.text), ['Meetings', 'Team meeting', 'No folder', 'My list']);
  assert.ok(fs.existsSync(file));
  app.undo();
  app.undo();
  app.undo();
});

test('a list note needs a notes file and refuses folders that treat plain lines as tasks', async () => {
  const { notes, app } = setup({});
  await assert.rejects(() => app.action({ op: 'listNote', value: { text: 'x' }, list: 'mylist' }), (e) => e.code === 'no-list-file');
  app.setFolders([{ path: notes, unmarked: 'tasks' }]);
  await assert.rejects(() => app.action({ op: 'listCreate', value: { name: 'Plan', notesFolder: notes } }), /every plain line as a task|treats every plain line/);
});

test('due and check-in dates take times and show on the schedule grouped by when', async () => {
  const { notes, app } = setup({ 'a.txt': '@ late\n@ today thing\n@ later thing\n@ no dates\n' });
  await app.action({ id: find(app, 'late').id, op: 'dates', value: { due: '2026-11-10' } });
  await app.action({ id: find(app, 'today thing').id, op: 'dates', value: { due: 'today 2pm', checkin: '2026-11-18 9am' } });
  await app.action({ id: find(app, 'later thing').id, op: 'checkin', value: '2026-12-25' });
  assert.equal(read(notes, 'a.txt'), '@ late due:2026-11-10\n@ today thing due:2026-11-16 14:00 checkin:2026-11-18 09:00\n@ later thing checkin:2026-12-25\n@ no dates\n');
  const sched = items(app, 'schedule');
  assert.deepEqual(sched.map((i) => i.text), ['Overdue', 'late', 'Today', 'today thing', 'Later', 'later thing']);
  const t = find(app, 'today thing');
  assert.equal(t.due.time, '14:00');
  assert.ok(t.meta.some((m) => /^Due .* at 2 pm/.test(m)));
  assert.ok(t.meta.some((m) => /^Check in .* at 9 am/.test(m)));
  await app.action({ id: t.id, op: 'dates', value: { due: '', checkin: '' } });
  assert.equal(read(notes, 'a.txt').split('\n')[1], '@ today thing');
  await assert.rejects(() => app.action({ id: find(app, 'today thing').id, op: 'due', value: 'whenever' }), /Could not understand/);
});

test('+ on an unmarked line in triage marks it done and > marks it waiting', async () => {
  const { notes, app } = setup({ 'a.txt': 'idea one\n\nidea two\n' });
  const tri = items(app, 'triage').filter((i) => i.type === 'unmarked');
  await app.action({ id: tri[0].id, op: 'done' });
  await app.action({ id: tri[1].id, op: 'waitingOnOthers' });
  assert.match(read(notes, 'a.txt'), /^\+ idea one done:2026-11-16\n\n> idea two\n$/);
});

test('a status with a note writes both, in triage too, and one undo reverses both', async () => {
  const { notes, app } = setup({ 'a.txt': '@ job\n@ other\n', 'b.txt': 'plain idea\n' });
  await app.action({ id: find(app, 'job').id, op: 'waitingOnOthers', value: { note: 'Sam' } });
  assert.equal(read(notes, 'a.txt'), '@> job\n  [2026-11-16] Waiting on others: Sam\n@ other\n');
  app.undo();
  assert.equal(read(notes, 'a.txt'), '@ job\n@ other\n');
  await app.action({ id: find(app, 'job').id, op: 'important', value: {} });
  assert.equal(read(notes, 'a.txt'), '@* job\n@ other\n');
  const tri = items(app, 'triage').filter((i) => i.type === 'unmarked');
  await app.action({ id: tri[0].id, op: 'inProgress', value: { note: 'started' } });
  assert.match(read(notes, 'b.txt'), /^% plain idea\n {2}\[2026-11-16\] In progress: started\n$/);
  app.undo();
  assert.equal(read(notes, 'b.txt'), 'plain idea\n');
});

test('delete marks the task and its subtasks with $, hides them everywhere, and undo restores them', async () => {
  const { notes, app } = setup({ 'a.txt': '@ keep\n@ gone\n  a note\n  @ sub\n@ last\n\nplain url\n' });
  const list = (await app.action({ op: 'listCreate', value: 'Agenda' })).listId;
  await app.action({ id: find(app, 'gone').id, op: 'listToggle', list });
  await app.action({ id: find(app, 'gone').id, op: 'exclude' });
  assert.equal(read(notes, 'a.txt'), '@ keep\n$ gone\n  a note\n  $ sub\n@ last\n\nplain url\n');
  assert.deepEqual(items(app).filter((i) => i.type === 'task').map((i) => i.text), ['keep', 'last']);
  assert.ok(!items(app, 'triage').some((i) => i.text === 'gone' || i.text === 'sub'));
  assert.ok(!items(app, 'list:' + list).some((i) => i.text === 'gone'));
  app.undo();
  assert.equal(read(notes, 'a.txt'), '@ keep\n@ gone\n  a note\n  @ sub\n@ last\n\nplain url\n');
  const tri = items(app, 'triage').find((i) => i.type === 'unmarked' && i.text === 'plain url');
  await app.action({ id: tri.id, op: 'exclude' });
  assert.match(read(notes, 'a.txt'), /\n\$ plain url\n$/);
  assert.ok(!items(app, 'triage').some((i) => i.text === 'plain url'));
});

test('$5 and $ in the middle of a line are plain text', async () => {
  const { app } = setup({ 'a.txt': '@ pay\n\n$5 lunch\n' });
  assert.ok(items(app, 'triage').some((i) => i.text === '$5 lunch'));
});

test('a task with notes gets note rows under it, before its subtasks', async () => {
  const { app } = setup({ 'a.txt': '@ Future\n  Jaws training\n  @ sub\n' });
  const rows = items(app).map((i) => [i.type, i.text, i.hasChildren]);
  assert.deepEqual(rows, [['task', 'Future', true], ['tasknote', 'Jaws training', false], ['task', 'sub', false]]);
  assert.equal(items(app)[0].noteCount, 1);
});

test('deleting a line leaves the plain lines after it in triage', async () => {
  const { notes, app } = setup({ 'a.txt': '@ parent\n\nx\ny\nz\n' });
  const unmarked = () => items(app, 'triage').filter((i) => i.type === 'unmarked').map((i) => i.text);
  await app.action({ id: items(app, 'triage').find((i) => i.text === 'x').id, op: 'exclude' });
  assert.equal(read(notes, 'a.txt'), '@ parent\n\n$ x\ny\nz\n');
  assert.deepEqual(unmarked(), ['y', 'z']);
});

test('Tab on a plain line with other lines above it moves it under the task, and undo puts it back', async () => {
  const text = '@ parent\n  a note\n\njunk\nmore junk\nsub\nlast\n';
  const { notes, app } = setup({ 'a.txt': text });
  const sub = items(app, 'triage').find((i) => i.type === 'unmarked' && i.text === 'sub');
  await app.action({ id: sub.id, op: 'indent' });
  assert.equal(read(notes, 'a.txt'), '@ parent\n  a note\n  @ sub\n\njunk\nmore junk\nlast\n');
  assert.ok(find(app, 'sub'));
  app.undo();
  assert.equal(read(notes, 'a.txt'), text);
});

test('a line starting with & is a note of the nearest task above, across blank lines', async () => {
  const { app } = setup({ 'a.txt': '@ call Sam\n  first note\n\njunk\n& asked about budget\n&no space\n@ other\n\n&& not a note\n' });
  assert.deepEqual(find(app, 'call Sam').notes, ['first note', 'asked about budget', 'no space']);
  assert.deepEqual(find(app, 'other').notes, []);
  assert.deepEqual(items(app, 'triage').filter((i) => i.type === 'unmarked').map((i) => i.text), ['junk', '&& not a note']);
  const { app: none } = setup({ 'a.txt': '& first\nx\ny\n@ task\n' });
  assert.deepEqual(items(none, 'triage').filter((i) => i.type === 'unmarked').map((i) => i.text), ['& first', 'x']);
});

test('marking a triage line as a note writes & into the file, and undo restores it', async () => {
  const text = '@ task\n\njunk line\n  indented junk\nlast\n';
  const { notes, app } = setup({ 'a.txt': text, 'b.txt': 'alpha\nbeta\n' });
  const unmarked = (t) => items(app, 'triage').find((i) => i.type === 'unmarked' && i.text === t);
  await app.action({ id: unmarked('junk line').id, op: 'note' });
  assert.equal(read(notes, 'a.txt'), '@ task\n\n& junk line\n  indented junk\nlast\n');
  assert.deepEqual(find(app, 'task').notes, ['junk line']);
  app.undo();
  assert.equal(read(notes, 'a.txt'), text);
  await app.action({ id: unmarked('alpha').id, op: 'note' });
  assert.equal(read(notes, 'b.txt'), 'alpha\nbeta\n');
  assert.ok(unmarked('alpha').known);
  await app.action({ id: `f:${path.join(notes, 'a.txt')}`, op: 'dismissFile' });
  assert.equal(read(notes, 'a.txt'), '@ task\n\n& junk line\n  & indented junk\n& last\n');
  assert.deepEqual(find(app, 'task').notes, ['junk line', 'indented junk', 'last']);
  app.undo();
  assert.equal(read(notes, 'a.txt'), text);
});

test('triage todoList marks a line as a to-do and puts it on lists in one undoable step', async () => {
  const text = '@ task\n\njunk line\nlast\n';
  const { notes, app } = setup({ 'a.txt': text });
  const unmarked = (t) => items(app, 'triage').find((i) => i.type === 'unmarked' && i.text === t);
  const res = await app.action({ id: unmarked('junk line').id, op: 'todoList', value: { ids: ['mylist'], newName: 'Work' } });
  assert.equal(read(notes, 'a.txt'), '@ task\n\n@ junk line\nlast\n');
  const t = find(app, 'junk line');
  assert.equal(t.lists.length, 2);
  assert.ok(!unmarked('junk line'));
  assert.match(res.message, /Marked as to-do/);
  app.undo();
  assert.equal(read(notes, 'a.txt'), text);
  assert.equal(app.stateData.lists.some((l) => l.name === 'Work'), false);
});

test('triage lists only lines that are not tasks yet', () => {
  const { app } = setup({ 'a.txt': '+ finished\n@ open one\n\n\nstray line\n' });
  for (const showCompleted of [false, true]) {
    const texts = items(app, 'triage', { showCompleted }).filter((i) => i.type !== 'group').map((i) => i.text);
    assert.deepEqual(texts, ['stray line']);
  }
});

async function fileLists(app, notes) {
  const a = (await app.action({ op: 'listCreate', value: { name: 'Alpha', file: path.join(notes, 'a.txt'), fileTasks: true } })).listId;
  const b = (await app.action({ op: 'listCreate', value: { name: 'Beta', file: path.join(notes, 'b.txt'), fileTasks: true } })).listId;
  return { a, b };
}

test('a list that keeps its tasks in a file shows every task there, nested, in file order', async () => {
  const { notes, app } = setup({ 'a.txt': '@ one\n\t@ one sub\n•@ bullet sub\n+ done\n@ two\n', 'b.txt': '@ elsewhere\n' });
  const { a } = await fileLists(app, notes);
  const shown = items(app, `list:${a}`);
  assert.deepEqual(shown.map((i) => [i.text, i.level]), [['one', 1], ['one sub', 2], ['bullet sub', 2], ['two', 1]]);
  assert.equal(shown[0].hasChildren, true);
  assert.ok(find(app, 'two').meta.includes('On list: Alpha'));
  assert.equal(app.summary().lists.find((l) => l.id === a).fileTasks, true);
});

test('moving a task to another file list moves its lines, & notes and subtasks, and undo puts both files back', async () => {
  const A = '@ keep\n•@ parent\n  plain note\n\t@ child\n\t\t@ grandchild\n@ after\n& late note for after\n';
  const B = '@ existing\n  its note';
  const { notes, app } = setup({ 'a.txt': A, 'b.txt': B });
  const { b } = await fileLists(app, notes);
  const other = (await app.action({ op: 'listCreate', value: 'Errands' })).listId;
  await app.action({ id: find(app, 'parent').id, op: 'listToggle', list: other });
  const res = await app.action({ id: find(app, 'parent').id, op: 'listToggle', list: b });
  assert.match(res.message, /^Moved to Beta from Alpha, with 2 subtasks: parent\. Press u to undo$/);
  assert.equal(read(notes, 'a.txt'), '@ keep\n@ after\n& late note for after\n');
  assert.equal(read(notes, 'b.txt'), '@ existing\n  its note\n@ parent\n  plain note\n\t@ child\n\t\t@ grandchild');
  assert.equal(app.task(res.focusId).text, 'parent');
  assert.deepEqual(items(app, `list:${b}`).filter((i) => i.type === 'task').map((i) => [i.text, i.level]), [['existing', 1], ['parent', 1], ['child', 2], ['grandchild', 3]]);
  assert.ok(items(app, `list:${other}`).some((i) => i.text === 'parent'), 'stays on lists that store it by key');
  app.undo();
  assert.equal(read(notes, 'a.txt'), A);
  assert.equal(read(notes, 'b.txt'), B);
  assert.ok(items(app, `list:${other}`).some((i) => i.text === 'parent'));
});

test('ticking another file list in the chooser moves the task, and its own file list cannot just be unticked', async () => {
  const { notes, app } = setup({ 'a.txt': '@ task\n@ stay\n', 'b.txt': '@ b1\n', 'c.txt': '@ c1\n' });
  const { a, b } = await fileLists(app, notes);
  const c = (await app.action({ op: 'listCreate', value: { name: 'Gamma', file: path.join(notes, 'c.txt'), fileTasks: true } })).listId;
  await assert.rejects(() => app.action({ id: find(app, 'task').id, op: 'listSet', value: { ids: [] } }), /stays on that list/);
  await assert.rejects(() => app.action({ id: find(app, 'task').id, op: 'listSet', value: { ids: [b, c] } }), /only be kept in one file/);
  await assert.rejects(() => app.action({ id: find(app, 'task').id, op: 'listToggle', list: a }), /press Delete to exclude/);
  const res = await app.action({ id: find(app, 'task').id, op: 'listSet', value: { ids: [a, b, 'mylist'] } });
  assert.match(res.message, /^Moved to Beta from Alpha: task\. task is on My list and Beta\. Press u to undo$/);
  assert.equal(read(notes, 'a.txt'), '@ stay\n');
  assert.equal(read(notes, 'b.txt'), '@ b1\n@ task\n');
  app.undo();
  assert.equal(read(notes, 'a.txt'), '@ task\n@ stay\n');
  assert.equal(read(notes, 'b.txt'), '@ b1\n');
  assert.ok(!items(app, 'list:mylist').some((i) => i.text === 'task'));
});

test('reordering a file list moves the block in the file, among siblings only, and refuses across headings', async () => {
  const A = '@ one\n\t@ one sub\n  & note\n@ two\n@ three\n\nHeading:\n@ four\n';
  const { notes, app } = setup({ 'a.txt': A, 'b.txt': '' });
  const { a } = await fileLists(app, notes);
  const res = await app.action({ id: find(app, 'one').id, op: 'listMove', value: 'down', list: a });
  assert.match(res.message, /^Moved down to position 2 of 4: one$/);
  assert.equal(read(notes, 'a.txt'), '@ two\n@ one\n\t@ one sub\n  & note\n@ three\n\nHeading:\n@ four\n');
  await app.action({ id: find(app, 'three').id, op: 'listMove', value: 'top', list: a });
  assert.equal(read(notes, 'a.txt'), '@ three\n@ two\n@ one\n\t@ one sub\n  & note\n\nHeading:\n@ four\n');
  app.undo();
  app.undo();
  assert.equal(read(notes, 'a.txt'), A);
  assert.match((await app.action({ id: find(app, 'one sub').id, op: 'listMove', value: 'up', list: a })).message, /^Already first under one/);
  await assert.rejects(() => app.action({ id: find(app, 'four').id, op: 'listMove', value: 'up', list: a }), /without changing other tasks/);
  assert.equal(read(notes, 'a.txt'), A);
});

test('file list moves refuse when a file changed on disk, and new tasks go into the list file', async () => {
  const { notes, app } = setup({ 'a.txt': '@ task\n', 'b.txt': '@ b1\n' });
  const { a, b } = await fileLists(app, notes);
  const t = find(app, 'task');
  fs.writeFileSync(path.join(notes, 'b.txt'), '@ b1\n@ added outside\n');
  await assert.rejects(() => app.action({ id: t.id, op: 'listToggle', list: b }), /changed/);
  assert.equal(read(notes, 'a.txt'), '@ task\n');
  assert.equal(read(notes, 'b.txt'), '@ b1\n@ added outside\n');
  const res = await app.action({ op: 'newTask', value: { text: 'fresh' }, list: a });
  assert.match(res.message, /Created task in Alpha, at the end of a: fresh/);
  assert.equal(read(notes, 'a.txt'), '@ task\n@ fresh\n');
});

test('a list using its file only for notes still keeps tasks by hand', async () => {
  const { notes, app } = setup({ 'a.txt': '@ task\n', 'n.txt': '@ in notes file\n' });
  const list = (await app.action({ op: 'listCreate', value: { name: 'Plain', file: path.join(notes, 'n.txt') } })).listId;
  assert.deepEqual(items(app, `list:${list}`), []);
  await app.action({ id: find(app, 'task').id, op: 'listToggle', list });
  assert.equal(read(notes, 'a.txt'), '@ task\n');
  assert.deepEqual(items(app, `list:${list}`).map((i) => i.text), ['task']);
  const edit = await app.action({ op: 'listEdit', list, value: { fileTasks: true } });
  assert.match(edit.message, /shows every task in n/);
  assert.deepEqual(items(app, `list:${list}`).map((i) => i.text), ['in notes file', 'task']);
  await app.action({ id: find(app, 'task').id, op: 'listToggle', list });
  assert.deepEqual(items(app, `list:${list}`).map((i) => i.text), ['in notes file']);
  assert.equal(read(notes, 'a.txt'), '@ task\n');
});

test('buckets: y puts a task in several buckets, the bucket gets an id from its text, unticking removes it, undo restores both files', async () => {
  const { notes, app } = setup({ 'buckets.txt': '~ Building partner network jira:label\n~ DERG work jira:label\n~ just ongoing\n', 'a.txt': '@ call Bob\n' });
  const id = (text) => find(app, text).id;
  const choices = app.bucketChoices({ id: id('call Bob') });
  assert.deepEqual(choices.buckets.map((g) => [g.text, g.checked, g.inherited]), [['Building partner network', false, false], ['DERG work', false, false]], 'only jira:label lines are buckets');
  const res = await app.action({ id: id('call Bob'), op: 'bucketSet', value: { ids: [id('Building partner network'), id('DERG work')] } });
  assert.match(res.message, /Buckets: Building partner network; DERG work\. Task: call Bob/);
  assert.equal(read(notes, 'buckets.txt'), '~ Building partner network jira:label goal:building-partner-network\n~ DERG work jira:label goal:derg-work\n~ just ongoing\n');
  assert.equal(read(notes, 'a.txt'), '@ call Bob goal:building-partner-network goal:derg-work\n');
  const bob = find(app, 'call Bob');
  assert.equal(bob.text, 'call Bob');
  assert.match(bob.meta[0], /^Buckets: Building partner network; DERG work$/);
  assert.equal(res.focusId, bob.id);

  // Untick one bucket.
  await app.action({ id: bob.id, op: 'bucketSet', value: { ids: [id('DERG work')] } });
  assert.equal(read(notes, 'a.txt'), '@ call Bob goal:derg-work\n');
  app.undo();
  assert.equal(read(notes, 'a.txt'), '@ call Bob goal:building-partner-network goal:derg-work\n');
  app.undo();
  assert.equal(read(notes, 'buckets.txt'), '~ Building partner network jira:label\n~ DERG work jira:label\n~ just ongoing\n');
  assert.equal(read(notes, 'a.txt'), '@ call Bob\n');
  await assert.rejects(() => app.action({ id: id('DERG work'), op: 'bucketSet', value: { ids: [id('DERG work')] } }), /is a bucket/);
  await assert.rejects(() => app.action({ id: id('call Bob'), op: 'bucketSet', value: { ids: [id('just ongoing')] } }), /Not a bucket/);
  // The old op name still works.
  await app.action({ id: id('call Bob'), op: 'goalSet', value: { ids: [id('DERG work')] } });
  assert.equal(read(notes, 'a.txt'), '@ call Bob goal:derg-work\n');
});

test('buckets: y on a ~ line without its own id never takes over the bucket id (regression)', async () => {
  const { notes, app } = setup({
    'b.txt': '~ Program operations goal:program-operations jira:label\n',
    'a.txt': '@~ Add hours each week\n@ other\n',
  });
  await app.action({ id: find(app, 'Add hours each week').id, op: 'bucketSet', value: { ids: [find(app, 'Program operations').id] } });
  assert.equal(read(notes, 'a.txt'), '@~ Add hours each week goal:program-operations\n@ other\n');
  const bx = app.index.buckets;
  assert.equal(bx.byId.get('program-operations').text, 'Program operations', 'the bucket keeps its id');
  assert.deepEqual(bx.list.map((b) => b.text), ['Program operations'], 'the ~ line did not become a second bucket');
  assert.equal(find(app, 'Add hours each week').goalId, undefined);
  assert.deepEqual(app.index.get(find(app, 'Add hours each week').id).buckets, ['program-operations']);
  // Saving again is no change, and the bucket still has exactly one task.
  const again = await app.action({ id: find(app, 'Add hours each week').id, op: 'bucketSet', value: { ids: [find(app, 'Program operations').id] } });
  assert.match(again.message, /^No change/);
  assert.equal(bx.members.get('program-operations').length, 1);
});

test('buckets: a task inherits from its parent, else from the list title line; an own set replaces it; ticking the inherited set removes the override', async () => {
  const { notes, app } = setup({
    'b.txt': 'Buckets\n~ Advisory goal:advisory jira:label\n~ Testing goal:testing jira:label\n\t@ under testing\n',
    'a.txt': 'Assessment system goal:testing\n\n@ top\n\t@ child\n\t\t@ grandchild\n@ own goal:advisory\n\t@ own child\n@ nothing goal:none\n',
  });
  const t = (text) => app.index.get(find(app, text).id);
  assert.deepEqual([t('top').buckets, t('top').bucketSource], [['testing'], 'list']);
  assert.deepEqual([t('grandchild').buckets, t('grandchild').bucketSource, t('grandchild').bucketFrom], [['testing'], 'list', null]);
  assert.deepEqual([t('own').buckets, t('own').bucketSource], [['advisory'], 'own']);
  assert.deepEqual([t('own child').buckets, t('own child').bucketSource, t('own child').bucketFrom], [['advisory'], 'parent', t('own').id]);
  assert.deepEqual([t('nothing').buckets, t('nothing').bucketSource], [[], 'own']);
  assert.deepEqual(t('under testing').buckets, ['testing'], 'a task under a bucket line is in it');
  assert.equal(find(app, 'top').meta[0], 'Bucket: Testing (inherited from list: Assessment system)');
  assert.equal(find(app, 'own child').meta[0], 'Bucket: Advisory (inherited from parent: own)');
  assert.equal(find(app, 'nothing').meta[0], 'No bucket (set on this task)');
  // The title line is still a group, its tokens hidden.
  assert.equal(app.index.get(find(app, 'top').id).group, 'Assessment system');

  // The chooser pre-ticks the effective set and marks the inherited ones.
  const c = app.bucketChoices({ id: find(app, 'child').id });
  assert.deepEqual(c.buckets.map((b) => [b.text, b.checked, b.inherited]), [['Advisory', false, false], ['Testing', true, true]]);
  assert.equal(c.inheritedFrom, 'list: Assessment system');

  // An own set replaces the inherited one, and its subtasks follow it.
  await app.action({ id: find(app, 'child').id, op: 'bucketSet', value: { ids: [find(app, 'Advisory').id] } });
  assert.match(read(notes, 'a.txt'), /\t@ child goal:advisory\n/);
  assert.deepEqual([t('grandchild').buckets, t('grandchild').bucketSource], [['advisory'], 'parent']);
  // Ticking exactly the inherited set again removes the override.
  let res = await app.action({ id: find(app, 'child').id, op: 'bucketSet', value: { ids: [find(app, 'Testing').id] } });
  assert.match(res.message, /Bucket: Testing \(inherited from list: Assessment system\)/);
  assert.match(read(notes, 'a.txt'), /\t@ child\n/);
  // Unticking everything while something is inherited writes goal:none.
  await app.action({ id: find(app, 'top').id, op: 'bucketSet', value: { ids: [] } });
  assert.match(read(notes, 'a.txt'), /\n@ top goal:none\n/);
  assert.deepEqual(t('grandchild').buckets, []);
  await app.action({ id: find(app, 'top').id, op: 'bucketSet', value: { ids: [find(app, 'Testing').id] } });
  assert.match(read(notes, 'a.txt'), /\n@ top\n/);

  // List defaults: set from a file row, written on the title line, and undoable.
  const before = read(notes, 'a.txt');
  res = await app.action({ id: `f:${path.join(notes, 'a.txt')}`, op: 'listBucketSet', value: { ids: [find(app, 'Advisory').id, find(app, 'Testing').id] } });
  assert.match(res.message, /Default buckets for Assessment system: Advisory; Testing/);
  assert.equal(read(notes, 'a.txt').split('\n')[0], 'Assessment system goal:advisory goal:testing');
  assert.deepEqual(t('top').buckets, ['advisory', 'testing']);
  assert.deepEqual(app.bucketChoices({ file: path.join(notes, 'a.txt') }).buckets.map((b) => b.checked), [true, true]);
  app.undo();
  assert.equal(read(notes, 'a.txt'), before);
  await app.action({ id: `f:${path.join(notes, 'a.txt')}`, op: 'listBucketSet', value: { ids: [] } });
  assert.equal(read(notes, 'a.txt').split('\n')[0], 'Assessment system');
  assert.deepEqual(t('top').buckets, []);
  // A file whose first line is a task has no title line.
  assert.throws(() => app.bucketChoices({ file: path.join(notes, 'b.txt').replace('b.txt', 'nope.txt') }), /no longer/);
});

test('buckets: a file without a title line refuses defaults; the By file row carries its defaults', async () => {
  const { notes, app } = setup({ 'b.txt': '~ Ops goal:ops jira:label\n', 'a.txt': 'Team goal:ops\n\n@ one\n' });
  await assert.rejects(() => app.action({ id: `f:${path.join(notes, 'b.txt')}`, op: 'listBucketSet', value: { ids: [] } }), /no title line/);
  const row = items(app, 'file').find((i) => i.type === 'group' && i.text === 'Team');
  assert.equal(row.file, path.join(notes, 'a.txt'));
  assert.ok(row.meta.includes('Default bucket: Ops'));
});

test('buckets: rewording keeps membership, ids stay unique, unknown tokens are kept, Buckets view nests and counts No bucket', async () => {
  const { notes, app } = setup({
    'g.txt': '~ Partner network goal:partner-network jira:label\n~ Partner network! jira:label\n',
    'a.txt': '@ call Bob goal:partner-network goal:gone\n\t@ bob sub\n+ sent email goal:partner-network\n@ plan day\n@ loose\n+ loose done\n',
  });
  fs.writeFileSync(path.join(notes, 'g.txt'), '~ Grow the partner network goal:partner-network jira:label\n~ Partner network! jira:label\n');
  app.index.refresh(NOW());
  const bucket = find(app, 'Grow the partner network');
  assert.equal(bucket.meta.at(-1), '3 tasks');
  assert.match(find(app, 'call Bob').meta[0], /^Bucket: Grow the partner network$/);

  await app.action({ id: find(app, 'plan day').id, op: 'bucketSet', value: { ids: [find(app, 'Partner network!').id] } });
  assert.equal(read(notes, 'g.txt'), '~ Grow the partner network goal:partner-network jira:label\n~ Partner network! jira:label goal:partner-network-2\n');
  await app.action({ id: find(app, 'call Bob').id, op: 'bucketSet', value: { ids: [find(app, 'Partner network!').id] } });
  assert.match(read(notes, 'a.txt'), /^@ call Bob goal:partner-network-2 goal:gone\n/);
  await app.action({ id: find(app, 'call Bob').id, op: 'bucketSet', value: { ids: [find(app, 'Grow the partner network').id] } });

  const view = items(app, 'buckets');
  assert.deepEqual(view.map((i) => [i.level, i.text]), [[1, 'Grow the partner network'], [2, 'call Bob'], [3, 'bob sub'], [1, 'Partner network!'], [2, 'plan day'], [1, 'No bucket'], [2, 'loose']]);
  assert.equal(view[0].meta[0], '2 open, 1 done tasks');
  assert.equal(view[5].meta[0], '1 open, 1 done tasks');
  assert.equal(view[5].id, 'g:nobucket');
  assert.equal(items(app, 'goals').length, view.length, 'the old view name still opens Buckets');
  const all = items(app, 'buckets', { showCompleted: true });
  assert.deepEqual(all.map((i) => i.text), ['Grow the partner network', 'call Bob', 'bob sub', 'sent email', 'Partner network!', 'plan day', 'No bucket', 'loose', 'loose done']);
  // A task row under a bucket acts on the task.
  await app.action({ id: view[4].id, op: 'toggleDone' });
  assert.equal(read(notes, 'a.txt').split('\n')[3], '+@ plan day goal:partner-network-2 done:2026-11-16');
});

test('My Day and Next actions: picks roll over, overdue and due today join, priority sorts, blocked and exclusions stay out', async () => {
  const { app } = setup({
    'a.txt': [
      '~ goal thing',
      '@ picked today today:2026-11-16',
      '@ picked old today:2026-11-13',
      '@ picked high today:2026-11-16 p:high',
      '@ overdue one due:2026-11-10',
      '@ due now due:2026-11-16',
      '@ blocked pick today:2026-11-16 after:first-step',
      '@ first step id:first-step',
      '> waiting on x today:2026-11-16',
      '% doing',
      '@ parent',
      '\t@ child one',
      '\t+ child done',
      '+ finished today:2026-11-16',
      '',
    ].join('\n'),
    'ideas.txt': '@ idea one due:2026-11-10\n@ idea two\n',
  });
  const day = app.view({ view: 'myday', q: '', showCompleted: false });
  assert.equal(day.summary, 'Picked 3, Overdue 2, Due today 1');
  assert.deepEqual(day.items.filter((i) => i.type === 'task').map((i) => i.text), ['picked high', 'picked old', 'picked today', 'overdue one', 'idea one', 'due now']);
  assert.ok(find(app, 'picked old', 'myday').words.includes('Carried over'));
  assert.match(find(app, 'picked old', 'myday').meta[0], /carried over to today/);
  assert.deepEqual(find(app, 'blocked pick').words, ['Open', 'Blocked']);

  const next = app.view({ view: 'next', q: '', showCompleted: false });
  const tasks = next.items.filter((i) => i.type === 'task').map((i) => i.text);
  assert.equal(tasks[0], 'picked high', 'High priority first, then in progress');
  assert.equal(tasks[1], 'doing');
  assert.ok(tasks.includes('child one') && !tasks.includes('parent'), 'subtasks stand in for their parent');
  assert.ok(tasks.includes('first step'));
  for (const hidden of ['goal thing', 'blocked pick', 'waiting on x', 'finished', 'child done']) assert.ok(!tasks.includes(hidden), hidden);
  assert.deepEqual(next.items.filter((i) => i.type === 'group').map((i) => i.text), ['a', 'ideas']);
});

test('t picks for today and unpicks', async () => {
  const { notes, app } = setup({ 'a.txt': '@ one\n@ two\n+ done one\n' });
  const id = (n) => find(app, n).id;
  let res = await app.action({ id: id('one'), op: 'today' });
  assert.match(res.message, /picked for today/i);
  assert.equal(read(notes, 'a.txt').split('\n')[0], '@ one today:2026-11-16');
  assert.deepEqual(items(app, 'myday').filter((i) => i.type === 'task').map((i) => i.text), ['one']);
  res = await app.action({ id: id('one'), op: 'today' });
  assert.equal(read(notes, 'a.txt').split('\n')[0], '@ one');
  await assert.rejects(() => app.action({ id: items(app, 'open', { showCompleted: true }).find((i) => i.text === 'done one').id, op: 'today' }), /done/i);
});

test('priority cycles medium, high, low, medium, shows in details and speech, and undoes', async () => {
  const { notes, app } = setup({ 'a.txt': '@ one due:2026-11-20\n' });
  const id = () => find(app, 'one').id;
  let res = await app.action({ id: id(), op: 'priority' });
  assert.match(res.message, /Priority high/);
  assert.equal(read(notes, 'a.txt'), '@ one due:2026-11-20 p:high\n');
  assert.ok(find(app, 'one').meta.includes('Priority: High'));
  assert.ok(find(app, 'one').words.includes('High priority'));
  await app.action({ id: id(), op: 'priority' });
  assert.equal(read(notes, 'a.txt'), '@ one due:2026-11-20 p:low\n');
  assert.ok(find(app, 'one').meta.includes('Priority: Low'));
  await app.action({ id: id(), op: 'priority' });
  assert.equal(read(notes, 'a.txt'), '@ one due:2026-11-20\n');
  assert.ok(!find(app, 'one').meta.some((m) => /^Priority/.test(m)));
  await app.action({ id: id(), op: 'priority', value: 'high' });
  app.undo();
  assert.equal(read(notes, 'a.txt'), '@ one due:2026-11-20\n');
  await assert.rejects(() => app.action({ id: id(), op: 'priority', value: 'urgent' }), /high, medium or low/i);
});

test('Blocked by: blockSet writes id: and after:, keeps ids unique, rejects cycles, and unblocks when the blocker is done', async () => {
  const { notes, app } = setup({ 'a.txt': '~ Ship it goal:ship-it jira:label\n@ Ship it\n@ write code\n@ review code\n@ release\n' });
  const id = (n) => find(app, n).id;
  const choices = app.blockChoices(id('release'));
  assert.deepEqual(choices.tasks.map((c) => c.text), ['Ship it', 'write code', 'review code']);
  assert.ok(!choices.tasks.some((c) => c.text === 'release'));

  let res = await app.blockSet(app.task(id('release')), { ids: [id('write code'), id('review code')] });
  assert.match(res.message, /Blocked by: write code; review code/);
  assert.equal(read(notes, 'a.txt'), '~ Ship it goal:ship-it jira:label\n@ Ship it\n@ write code id:write-code\n@ review code id:review-code\n@ release after:write-code after:review-code\n');
  const rel = find(app, 'release');
  assert.deepEqual(rel.words, ['Open', 'Blocked']);
  assert.ok(rel.meta.includes('Blocked by: write code; review code'));
  assert.ok(find(app, 'write code').meta.includes('Blocks 1 task'));
  assert.ok(!items(app, 'next').some((i) => i.text === 'release'));

  // A bucket's own id is a valid target, and the task's own slug never clashes with it.
  res = await app.blockSet(app.task(id('write code')), { ids: [id('Ship it')] });
  assert.equal(read(notes, 'a.txt').split('\n')[2], '@ write code id:write-code after:ship-it');

  await assert.rejects(async () => app.blockSet(app.task(id('write code')), { ids: [id('release')] }), /already waits/);
  await assert.rejects(async () => app.blockSet(app.task(id('write code')), { ids: [id('write code')] }), /itself/);

  // One undo step per action, and unblocking when the blockers are done.
  app.undo();
  assert.equal(read(notes, 'a.txt').split('\n')[2], '@ write code id:write-code');
  await app.action({ id: id('write code'), op: 'toggleDone' });
  assert.ok(find(app, 'release').words.includes('Blocked'), 'one blocker is still open');
  await app.action({ id: id('review code'), op: 'toggleDone' });
  assert.ok(!find(app, 'release').words.includes('Blocked'));
  assert.ok(items(app, 'next').some((i) => i.text === 'release'));

  // Clearing the blockers removes the after: tokens but keeps ids.
  res = await app.blockSet(app.task(id('release')), { ids: [] });
  assert.match(res.message, /Not blocked/);
  assert.equal(read(notes, 'a.txt').split('\n')[4], '@ release');
});

test('Blocked by: unresolved after: tokens are kept and ignored, and a deleted blocker stops blocking', async () => {
  const { notes, app } = setup({ 'a.txt': '@ one after:ghost\n@ two id:two-id\n@ three after:two-id\n' });
  const id = (n) => find(app, n).id;
  assert.ok(!find(app, 'one').words.includes('Blocked'));
  assert.ok(find(app, 'three').words.includes('Blocked'));
  await app.blockSet(app.task(id('one')), { ids: [id('two')] });
  assert.equal(read(notes, 'a.txt').split('\n')[0], '@ one after:two-id after:ghost');
  await app.action({ id: id('two'), op: 'delete' }).catch(() => app.action({ id: id('two'), op: 'exclude' }));
  assert.ok(!items(app, 'open').some((i) => i.text === 'two'));
  assert.ok(!find(app, 'three').words.includes('Blocked'), 'a deleted blocker no longer blocks');
});

test('Not actionable lists keep their tasks out of My Day and Next, and still show in the open view', async () => {
  const { notes, app } = setup({ 'a.txt': '@ real work due:2026-11-10\n', 'meet.txt': '@ team lunch due:2026-11-10\n' });
  const file = path.join(notes, 'meet.txt');
  const list = (await app.action({ op: 'listCreate', value: { name: 'Meetings', file, fileTasks: true, notActionable: true } })).listId;
  assert.equal(app.summary().lists.find((l) => l.id === list).notActionable, true);
  assert.deepEqual(items(app, 'myday').filter((i) => i.type === 'task').map((i) => i.text), ['real work']);
  assert.deepEqual(items(app, 'next').filter((i) => i.type === 'task').map((i) => i.text), ['real work']);
  assert.ok(find(app, 'team lunch'));
  const res = await app.action({ op: 'listEdit', list, value: { notActionable: false } });
  assert.match(res.message, /actionable/i);
  assert.deepEqual(items(app, 'next').filter((i) => i.type === 'task').map((i) => i.text).sort(), ['real work', 'team lunch']);
  await app.action({ op: 'listEdit', list, value: { notActionable: true } });
  assert.equal(items(app, 'myday').filter((i) => i.type === 'task').length, 1);
});

test('lists show their title or file name, not the path, and rows carry a type word', async () => {
  const { notes, app } = setup({
    'org.txt': 'Assessment system\n\n~ Ops goal:ops jira:label\n\t@ under bucket\n@ top\n\t@ sub\n\t\t@ deep\n\t\t\t@ deeper\n',
    'plain.txt': '@ one\n',
  });
  fs.mkdirSync(path.join(notes, 'x'));
  fs.writeFileSync(path.join(notes, 'x', 'plain.txt'), '@ two\n');
  app.index.refresh(NOW());
  const word = (text, view = 'open') => find(app, text, view).typeWord;
  assert.deepEqual(['under bucket', 'top', 'sub', 'deep', 'deeper'].map((t) => word(t)), ['task', 'task', 'subtask', 'level 2 subtask', 'level 3 subtask']);
  assert.equal(word('Ops'), 'bucket');
  const groups = items(app, 'file').filter((i) => i.type === 'group');
  assert.deepEqual(groups.map((g) => [g.text, g.typeWord]), [['Assessment system', 'list'], ['plain (notes)', 'list'], ['plain (notes/x)', 'list']]);
  assert.ok(!items(app, 'file').some((i) => /\.txt/.test(i.text)));
  assert.deepEqual(items(app, 'next').filter((i) => i.type === 'group').map((i) => [i.text, i.typeWord]), [['Assessment system', 'list'], ['plain (notes)', 'list'], ['plain (notes/x)', 'list']]);
  assert.ok(items(app, 'open').find((i) => i.text === 'one').meta.includes('List plain (notes), line 1'));
  assert.equal(items(app, 'group').find((i) => i.type === 'group').typeWord, 'group');
  assert.ok(app.view({ view: 'myday', q: '', showCompleted: false }).items.every((i) => i.type !== 'group' || i.typeWord === 'section'));
});

test('q toggles the question marker, combining with other markers, and rename keeps ask:', async () => {
  const { notes, app } = setup({ 'a.txt': '@ confirm venue ask:cory\n' });
  await app.action({ id: find(app, 'confirm venue').id, op: 'question' });
  assert.equal(read(notes, 'a.txt'), '@? confirm venue ask:cory\n');
  const t = find(app, 'confirm venue');
  assert.equal(t.typeWord, 'question');
  assert.ok(t.words.includes('ask Cory'), JSON.stringify(t.words));
  await app.action({ id: t.id, op: 'edit', value: { text: 'confirm the venue', notes: [] } });
  assert.equal(read(notes, 'a.txt'), '@? confirm the venue ask:cory\n');
});

test('Questions view groups by person, a question shows under each person, No person is last, and search filters', () => {
  const { app } = setup({ 'Budget.txt': 'Budget\n? which code ask:leanne ask:cory\n@? venue ask:Cory\n? loose one\n+? old ask:cory done:2026-11-01\n@ not a question\n' });
  const v = app.view({ view: 'questions', q: '', showCompleted: false });
  const shape = v.items.map((i) => (i.type === 'group' ? `# ${i.text}` : i.text));
  assert.deepEqual(shape, ['# Cory', 'which code', 'venue', '# Leanne', 'which code', '# No person', 'loose one']);
  assert.equal(v.count, 3);
  const g = v.items.find((i) => i.type === 'group');
  assert.equal(g.typeWord, 'person');
  const row = v.items.find((i) => i.text === 'venue');
  assert.ok(row.words.some((w) => /^from Budget/.test(w)), JSON.stringify(row.words));
  assert.equal(app.summary().views.find((x) => x.id === 'questions').count, 3);
  const s = app.view({ view: 'questions', q: 'leanne', showCompleted: false });
  assert.deepEqual(s.items.filter((i) => i.type !== 'group').map((i) => i.text), ['which code', 'which code']);
});

test('answering a bare ? writes a dated Answer note and makes it an open to-do; one undo restores it', async () => {
  const { notes, app } = setup({ 'a.txt': '? which code ask:cory\n@ other\n' });
  const res = await app.action({ id: find(app, 'which code').id, op: 'question', value: { answer: 'use 4410' } });
  assert.match(res.message, /Answered, now a to-do/);
  assert.equal(read(notes, 'a.txt'), '@ which code ask:cory\n  [2026-11-16] Answer: use 4410\n@ other\n');
  app.undo();
  assert.equal(read(notes, 'a.txt'), '? which code ask:cory\n@ other\n');
});

test('answering with done ticked completes the line, bare or with other markers', async () => {
  const { notes, app } = setup({ 'a.txt': '? which code\n>? Sam on dates\n' });
  const res = await app.action({ id: find(app, 'which code').id, op: 'question', value: { answer: 'use 4410', done: true } });
  assert.match(res.message, /Answered and marked done/);
  await app.action({ id: find(app, 'Sam on dates').id, op: 'question', value: { answer: '', done: true } });
  assert.equal(read(notes, 'a.txt'), '+@ which code done:2026-11-16\n  [2026-11-16] Answer: use 4410\n+> Sam on dates done:2026-11-16\n');
});

test('answering @? keeps the other marker; an empty answer writes no note', async () => {
  const { notes, app } = setup({ 'a.txt': '>? Sam on dates\n' });
  await app.action({ id: find(app, 'Sam on dates').id, op: 'question', value: { answer: '  ' } });
  assert.equal(read(notes, 'a.txt'), '> Sam on dates\n');
});

test('in a tasks-mode file an answer is written as an & note', async () => {
  const { notes, app } = setup({ 'a.txt': 'which code\n' });
  app.setFolders([{ path: notes, unmarked: 'tasks' }]);
  await app.action({ id: find(app, 'which code').id, op: 'question' });
  assert.equal(read(notes, 'a.txt'), '? which code\n');
  await app.action({ id: find(app, 'which code').id, op: 'question', value: { answer: 'ask finance' } });
  assert.equal(read(notes, 'a.txt'), 'which code\n  & [2026-11-16] Answer: ask finance\n');
  assert.ok(find(app, 'which code'), 'still an open task');
});

test('triage: q marks an unmarked line as a question', async () => {
  const { notes, app } = setup({ 'a.txt': '@ task\n\nloose thought\n' });
  const line = items(app, 'triage').find((i) => i.type === 'unmarked');
  await app.action({ id: line.id, op: 'question' });
  assert.equal(read(notes, 'a.txt'), '@ task\n\n? loose thought\n');
});

test('jiraSkip toggles the token (kept through a rename), says when a parent still skips it, and undo reverses it', async () => {
  const { notes, app } = setup({ 'a.txt': '@ admin p:high\n\t@ expenses\n' });
  let res = await app.action({ id: find(app, 'admin').id, op: 'jiraSkip' });
  assert.match(res.message, /^Kept out of Jira, with everything under it: admin$/);
  assert.equal(read(notes, 'a.txt'), '@ admin p:high jira:skip\n\t@ expenses\n');
  assert.equal(find(app, 'expenses').jiraSkip, 'inherited');
  await app.action({ id: find(app, 'admin').id, op: 'edit', value: { text: 'admin work' } });
  assert.equal(read(notes, 'a.txt'), '@ admin work p:high jira:skip\n\t@ expenses\n');
  app.undo();
  res = await app.action({ id: find(app, 'expenses').id, op: 'jiraSkip' });
  res = await app.action({ id: find(app, 'expenses').id, op: 'jiraSkip' });
  assert.match(res.message, /still not synced to Jira \(jira:skip, inherited from parent: admin\)/);
  res = await app.action({ id: find(app, 'admin').id, op: 'jiraSkip' });
  assert.equal(res.message, 'Syncs to Jira again: admin');
  assert.equal(read(notes, 'a.txt'), '@ admin p:high\n\t@ expenses\n');
  app.undo();
  assert.equal(read(notes, 'a.txt'), '@ admin p:high jira:skip\n\t@ expenses\n');
});

test('mylistSetup creates mylist.txt with jira:skip, keeps old My list tasks, undoes, and reuses an existing file', async () => {
  const { notes, app } = setup({ 'a.txt': '@ call bank\n@ other\n' });
  assert.equal(app.summary().mylistAsk, true);
  await app.action({ id: find(app, 'call bank').id, op: 'listToggle', value: 'mylist' });
  await assert.rejects(() => app.action({ op: 'mylistSetup', value: { folder: os.tmpdir() } }), /inside one of your watched folders/);
  const res = await app.action({ op: 'mylistSetup', value: { folder: notes } });
  assert.match(res.message, /^Created mylist\.txt\. My list keeps its tasks there\. Nothing in it goes to Jira\. The task you added from another file stays on My list\./);
  assert.equal(read(notes, 'mylist.txt'), 'My list jira:skip\n');
  assert.equal(app.summary().mylistAsk, false);
  const list = app.stateData.lists.find((l) => l.id === 'mylist');
  assert.equal(list.file, path.join(notes, 'mylist.txt'));
  assert.deepEqual(items(app, 'list:mylist').filter((i) => i.type === 'task').map((i) => i.text), ['call bank']);
  assert.equal(items(app, 'triage').filter((i) => i.type === 'unmarked').length, 0, 'the title line is not left in triage');

  app.undo();
  assert.ok(!app.stateData.lists.find((l) => l.id === 'mylist').fileTasks);
  assert.ok(fs.existsSync(path.join(notes, 'mylist.txt')), 'undo keeps the file');
  const again = await app.action({ op: 'mylistSetup', value: { folder: notes } });
  assert.match(again.message, /now uses the existing/);
  assert.equal(read(notes, 'mylist.txt'), 'My list jira:skip\n');
});

test('mylistLater stops the first-run question', async () => {
  const { app } = setup({ 'a.txt': '@ x\n' });
  await app.action({ op: 'mylistLater' });
  assert.equal(app.summary().mylistAsk, false);
});

test('a new task takes every option at once, writes them in one go, and one undo removes it all', async () => {
  const { notes, app } = setup({ 'master.txt': '@ existing id:ex\n', 'b.txt': '~ Partners jira:label\n' });
  app.setMaster({ path: path.join(notes, 'master.txt') });
  const ex = find(app, 'existing');
  const partners = app.newTaskChoices().buckets[0];
  const res = await app.action({
    op: 'newTask',
    value: { text: 'call Sam', start: '2026-11-16', due: 'nov 20 2pm', checkin: '+3d', priority: 'high', flags: ['important', 'waitingOnOthers'], today: true, jira: 'yes', buckets: [partners.id], blockedBy: [ex.id], notes: ['Waiting on others: Wayne'] },
  });
  const line = read(notes, 'master.txt').split('\n')[1];
  assert.match(line, /^@[*>]{2} call Sam /);
  for (const tok of ['start:2026-11-16', 'due:2026-11-20 14:00', 'checkin:2026-11-19', 'p:high', 'today:2026-11-16', 'jira:yes', 'goal:partners', 'after:ex']) assert.ok(line.includes(tok), tok);
  assert.match(read(notes, 'master.txt'), /\n {2}\[2026-11-16\] Waiting on others: Wayne\n/);
  assert.ok(res.undo);
  app.undo();
  assert.equal(read(notes, 'master.txt'), '@ existing id:ex\n');
  assert.equal(read(notes, 'b.txt'), '~ Partners jira:label\n');
});

test('a new task with a bad option writes nothing', async () => {
  const { notes, app } = setup({ 'master.txt': '@ existing\n' });
  app.setMaster({ path: path.join(notes, 'master.txt') });
  await assert.rejects(() => app.action({ op: 'newTask', value: { text: 'x', due: 'blorp' } }), /Could not understand/);
  await assert.rejects(() => app.action({ op: 'newTask', value: { text: 'x', priority: 'huge' } }), /Priority/);
  await assert.rejects(() => app.action({ op: 'newTask', value: { text: 'x', blockedBy: ['nothing like this'] } }), /No task matches/);
  assert.equal(read(notes, 'master.txt'), '@ existing\n');
});

test('a new task can be an open question for someone', async () => {
  const { notes, app } = setup({ 'master.txt': '@ existing\n' });
  app.setMaster({ path: path.join(notes, 'master.txt') });
  await app.action({ op: 'newTask', value: { text: 'which budget code', flags: ['question'], asks: ['Cory'] } });
  assert.equal(read(notes, 'master.txt'), '@ existing\n@? which budget code ask:cory\n');
  const q = items(app, 'questions').find((i) => /which budget code/.test(i.text));
  assert.ok(q);
});

test('the ; shorthand in the name sets options, with full words or three letters', async () => {
  const { notes, app } = setup({ 'master.txt': '@ existing\n', 'b.txt': '~ Partners jira:label\n' });
  app.setMaster({ path: path.join(notes, 'master.txt') });
  const res = await app.action({ op: 'newTask', value: { text: 'call sam; > wayne; due oct 14 2027; sta nov 10 2026; pri h; *; inp; che fri; buc part; blo existing; jir skip; not bring notes; today' } });
  const lines = read(notes, 'master.txt').split('\n');
  const line = lines[1];
  assert.match(line, /^@[>%*]{3} call sam /);
  for (const tok of ['due:2027-10-14', 'start:2026-11-10', 'p:high', 'checkin:2026-11-20', 'goal:partners', 'after:', 'jira:skip', 'today:2026-11-16']) assert.ok(line.includes(tok), tok);
  assert.ok(lines.some((l) => /Waiting on others: wayne/.test(l)));
  assert.ok(lines.some((l) => /bring notes/.test(l)));
  assert.match(res.message, /Set: /);
  await assert.rejects(() => app.action({ op: 'newTask', value: { text: 'x; flurb' } }), /Did not understand "flurb"/);
  await assert.rejects(() => app.action({ op: 'newTask', value: { text: 'x; due' } }), /needs a date/);
});
