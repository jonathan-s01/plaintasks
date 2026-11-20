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

test('triage hides completed tasks unless show completed is on', () => {
  const { app } = setup({ 'a.txt': '+ finished\n@ open one\n\n\nstray line\n' });
  const texts = (showCompleted) => items(app, 'triage', { showCompleted }).map((i) => i.text);
  assert.ok(!texts(false).includes('finished'));
  assert.ok(texts(false).includes('open one'));
  assert.ok(texts(true).includes('finished'));
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
  assert.match(res.message, /Created task in Alpha, at the end of notes\/a\.txt: fresh/);
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
  assert.match(edit.message, /shows every task in notes\/n\.txt/);
  assert.deepEqual(items(app, `list:${list}`).map((i) => i.text), ['in notes file', 'task']);
  await app.action({ id: find(app, 'task').id, op: 'listToggle', list });
  assert.deepEqual(items(app, `list:${list}`).map((i) => i.text), ['in notes file']);
  assert.equal(read(notes, 'a.txt'), '@ task\n');
});
