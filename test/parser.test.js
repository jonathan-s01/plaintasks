'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseText } = require('../src/parser');

const TODAY = new Date(2026, 10, 16);
const parse = (t, o = {}) => parseText(t, { today: TODAY, ...o });
const flagsOf = (i) => Object.keys(i.flags).filter((k) => i.flags[k]).sort();
const tasks = (r) => r.items.filter((i) => i.kind === 'task');

test('default markers map to flags, and combine', () => {
  const r = parse('+ done thing\n@ open thing\n< on me\n> on them\n• ongoing\n* important\n% going\n+* both\n+% and\n+• also\n');
  const f = tasks(r).map(flagsOf);
  assert.deepEqual(f[0], ['done']);
  assert.deepEqual(f[1], ['todo']);
  assert.deepEqual(f[2], ['waitingOnMe']);
  assert.deepEqual(f[3], ['waitingOnOthers']);
  assert.deepEqual(f[4], ['ongoing']);
  assert.deepEqual(f[5], ['important']);
  assert.deepEqual(f[6], ['inProgress']);
  assert.deepEqual(f[7], ['done', 'important']);
  assert.deepEqual(f[8], ['done', 'inProgress']);
  assert.deepEqual(f[9], ['done', 'ongoing']);
});

test('markdown bold, "+1" and html tags are not tasks', () => {
  const r = parse('**bold** text\n+1 for that\n* \n<div>x</div>\n%percent\n');
  assert.equal(tasks(r).length, 0);
});

test('strong markers work without a following space', () => {
  const r = parse('+Wayne thing\n+•top 5\n@call Sam\n<go through pages\n>Erin to send\n•check sites\n');
  assert.deepEqual(tasks(r).map((t) => t.text), ['Wayne thing', 'top 5', 'call Sam', 'go through pages', 'Erin to send', 'check sites']);
  assert.equal(tasks(r)[0].flags.done, true);
  assert.equal(tasks(r)[1].flags.ongoing, true);
});

test('consecutive marked lines are separate tasks; blank line ends a block', () => {
  const r = parse('@ one\n@ two\n\nnote after blank\n');
  assert.equal(tasks(r).length, 2);
  assert.equal(tasks(r)[1].parent, -1);
  assert.equal(r.items.filter((i) => i.kind === 'unmarked').length, 1);
});

test('indentation under a task makes subtasks; unmarked lines after a task are notes', () => {
  const r = parse('@ parent\nplain note\n\t@ child\n\t\t@ grandchild\n  indented note\n@ sibling\n');
  const t = tasks(r);
  assert.equal(t[0].notes.length, 2);
  assert.equal(t[1].parent, t[0].index);
  assert.equal(t[2].parent, t[1].index);
  assert.equal(t[2].depth, 2);
  assert.equal(t[3].parent, -1);
});

test('unmarked line followed by tasks is a group, and groups scope what follows', () => {
  const r = parse('Project Alpha\n@ a1\n@ a2\n\nProject Beta:\n@ b1\n');
  const t = tasks(r);
  assert.deepEqual(t.map((x) => x.group), ['Project Alpha', 'Project Alpha', 'Project Beta']);
});

test('inline dates are extracted and stripped from text', () => {
  const r = parse('@ call vendor due:fri jira:abc-12\n+ done thing done:2026-11-01\n');
  const [a, b] = tasks(r);
  assert.equal(a.text, 'call vendor');
  assert.equal(a.due, '2026-11-20');
  assert.equal(a.jira, 'ABC-12');
  assert.equal(b.doneDate, '2026-11-01');
});

test('legend: symbols apply, legend lines are not tasks, and "nothing = to do" does not override the folder setting', () => {
  const text = 'Legend\n+ = done\nnothing = to do\n• and indenting = subtasks\n\nBuy milk\n• sub of milk\n\t• deeper\n+ Done thing\n';
  const plain = parse(text);
  assert.equal(plain.unmarkedMode, 'notes');
  assert.ok(!tasks(plain).some((x) => x.text === 'Buy milk'));
  const r = parse(text, { unmarked: 'tasks' });
  assert.equal(r.unmarkedMode, 'tasks');
  assert.equal(r.legend.hasLegend, true);
  const t = tasks(r);
  assert.deepEqual(t.map((x) => x.text), ['Buy milk', 'sub of milk', 'deeper', 'Done thing']);
  assert.equal(t[1].parent, t[0].index);
  assert.equal(t[1].flags.subtask, true);
  assert.equal(t[2].parent, t[1].index);
  assert.equal(t[3].parent, -1);
});

test('legend: • = ongoing and "% = inprogress" lines are skipped', () => {
  const r0 = parse('% = inprogress\n@ real\n');
  assert.deepEqual(tasks(r0).map((x) => x.text), ['real']);
  const r = parse('+ = done\n• = ongoing, major outcome\nnothing = notes\n\n• Big outcome\n\t@ step\n');
  assert.equal(r.unmarkedMode, 'notes');
  const t = tasks(r);
  assert.equal(t[0].flags.ongoing, true);
  assert.equal(t[1].parent, t[0].index);
});

test('folder-level unmarked mode applies when no legend is present', () => {
  const r = parse('Buy milk\nCall mum\n', { unmarked: 'tasks' });
  assert.equal(tasks(r).length, 2);
  const n = parse('Buy milk\nCall mum\n');
  assert.equal(tasks(n).length, 0);
  assert.equal(n.items.length, 2);
});

test('CRLF, CR and missing trailing newline are split without losing information', () => {
  const r = parse('@ a\r\n@ b\r@ c');
  assert.equal(tasks(r).length, 3);
  assert.deepEqual(r.eols, ['\r\n', '\r', '']);
});
