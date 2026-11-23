'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseText } = require('../src/parser');

const TODAY = new Date(2026, 10, 16);
const parse = (t, o = {}) => parseText(t, { today: TODAY, ...o });
const flagsOf = (i) => Object.keys(i.flags).filter((k) => i.flags[k]).sort();
const tasks = (r) => r.items.filter((i) => i.kind === 'task');

test('default markers map to flags, and combine', () => {
  const r = parse('+ done thing\n@ open thing\n< on me\n> on them\n~ ongoing\n* important\n% going\n+* both\n+% and\n+~ also\n');
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
  const r = parse('+Wayne thing\n+~top 5\n@call Sam\n<go through pages\n>Erin to send\n•check sites\n');
  assert.deepEqual(tasks(r).map((t) => t.text), ['Wayne thing', 'top 5', 'call Sam', 'go through pages', 'Erin to send', 'check sites']);
  assert.equal(tasks(r)[0].flags.done, true);
  assert.equal(tasks(r)[1].flags.ongoing, true);
  assert.equal(tasks(r)[5].flags.subtask, true);
});

test('~ needs a space unless joined to a strong marker, so paths, approximations and strikethrough stay plain', () => {
  const r = parse('~/Documents/notes.txt\n~5 min\n~~strike~~ text\n~~ also strike\n~ real outcome\n');
  assert.deepEqual(tasks(r).map((t) => t.text), ['real outcome']);
  assert.equal(tasks(r)[0].flags.ongoing, true);
});

test('• marks a subtask of the task above, combines with status markers, and indenting nests deeper', () => {
  const r = parse('@ parent\n• open sub\n•+ done sub\n•% doing sub\n\t•> waiting deeper\n• back up\n@ next top\n');
  const t = tasks(r);
  const by = (x) => t.find((i) => i.text === x);
  assert.equal(by('open sub').parent, by('parent').index);
  assert.deepEqual(flagsOf(by('open sub')), ['subtask']);
  assert.equal(by('open sub').flags.done, false);
  assert.deepEqual(flagsOf(by('done sub')), ['done', 'subtask']);
  assert.deepEqual(flagsOf(by('doing sub')), ['inProgress', 'subtask']);
  assert.equal(by('done sub').parent, by('parent').index);
  assert.equal(by('doing sub').parent, by('parent').index);
  assert.equal(by('waiting deeper').parent, by('doing sub').index);
  assert.equal(by('waiting deeper').depth, 2);
  assert.deepEqual(flagsOf(by('waiting deeper')), ['subtask', 'waitingOnOthers']);
  assert.equal(by('back up').parent, by('parent').index);
  assert.equal(by('next top').parent, -1);
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

test('legend: a file can still define • = ongoing, and "% = inprogress" lines are skipped', () => {
  const r0 = parse('% = inprogress\n@ real\n');
  assert.deepEqual(tasks(r0).map((x) => x.text), ['real']);
  const r = parse('+ = done\n• = ongoing, major outcome\nnothing = notes\n\n• Big outcome\n\t@ step\n');
  assert.equal(r.unmarkedMode, 'notes');
  const t = tasks(r);
  assert.equal(t[0].flags.ongoing, true);
  assert.equal(t[1].parent, t[0].index);
  const tl = parse('~ = ongoing\n\n~ Outcome\n');
  assert.deepEqual(tl.legend.lines, [0]);
  assert.equal(tasks(tl)[0].flags.ongoing, true);
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

test('goal: tokens: first on a bucket (jira:label) line is its id, others are links; a plain ~ line never claims an id; stripped from text; not inside words', () => {
  const [g, t, u, o] = tasks(parse('~ Partner network goal:partner-network goal:Big-1 jira:label\n@ call Bob goal:partner-network goal:derg goal:derg\n@ see mygoal:x and goal:-bad\n~ Add hours goal:program-operations\n'));
  assert.equal(g.text, 'Partner network');
  assert.equal(g.goalId, 'partner-network');
  assert.deepEqual(g.goalLinks, ['big-1']);
  assert.equal(t.text, 'call Bob');
  assert.equal(t.goalId, null);
  assert.deepEqual(t.goalLinks, ['partner-network', 'derg']);
  assert.equal(u.text, 'see mygoal:x and goal:-bad');
  assert.deepEqual(u.goalLinks, []);
  assert.equal(o.goalId, null);
  assert.deepEqual(o.goalLinks, ['program-operations']);
});

test('the first plain line is the title line: its goal: tokens are the list defaults and are hidden', () => {
  const r = parse('\nAssessment system goal:testing goal:Ops\n\n@ one goal:x\n', { unmarked: 'notes' });
  assert.deepEqual([r.title.lineIndex, r.title.buckets, r.title.text], [1, ['testing', 'ops'], 'Assessment system']);
  assert.deepEqual(tasks(r)[0].goalLinks, ['x']);
  assert.equal(parse('@ first task goal:x\nTitle goal:y\n').title, null, 'a task first means no title line');
});

test('jira:label marks a label goal and is hidden; other jira: words are not it', () => {
  const [g, t] = tasks(parse('~ Advisory services goal:advisory-services jira:label\n@ read jira:labels\n'));
  assert.deepEqual([g.text, g.jiraLabel, g.goalId], ['Advisory services', true, 'advisory-services']);
  assert.deepEqual([t.text, t.jiraLabel], ['read jira:labels', false]);
});

test('start: is read and hidden like due:', () => {
  const [t] = tasks(parse('@ write report start:2026-11-02 due:2026-12-01\n'));
  assert.equal(t.text, 'write report');
  assert.equal(t.start, '2026-11-02');
  assert.equal(t.due, '2026-12-01');
});

test('today:, p:, id: and after: tokens are hidden and parsed', () => {
  const t = (line) => tasks(parse(`${line}\n`))[0];
  const a = t('@ call Sam today:2026-11-16 p:high id:call-sam due:2026-11-20');
  assert.deepEqual([a.text, a.picked, a.priority, a.refId, a.due], ['call Sam', '2026-11-16', 'high', 'call-sam', '2026-11-20']);
  const b = t('@ file report P:Low after:call-sam after:budget after:call-sam');
  assert.deepEqual([b.text, b.priority, b.waitsFor], ['file report', 'low', ['call-sam', 'budget']]);
  const c = t('@ plain task');
  assert.deepEqual([c.priority, c.refId, c.waitsFor], ['medium', null, []]);
  const d = t('@ talk about p:high-level plans and after: lunch');
  assert.deepEqual([d.text, d.priority, d.waitsFor], ['talk about p:high-level plans and after: lunch', 'medium', []]);
  const e = t('@ rating p:medium');
  assert.deepEqual([e.text, e.priority], ['rating', 'medium']);
});

test('? marks an open question only as a leading marker; ??, ?foo, URLs and trailing ? stay plain', () => {
  const r = parse('? which budget code\n@? confirm venue\n>? Sam on dates\n?? huh\n??? what\n?foo\n?q=1&x=2\nwhy is this?\na ? b\nhttps://x.test/?q=1\n+? answered already\n');
  const t = tasks(r);
  assert.deepEqual(t.map((i) => i.text), ['which budget code', 'confirm venue', 'Sam on dates', 'answered already']);
  assert.deepEqual(t.map(flagsOf), [['question'], ['question', 'todo'], ['question', 'waitingOnOthers'], ['done', 'question']]);
});

test('ask: tokens are hidden from text, deduped case-insensitively, and not matched inside words or URLs', () => {
  const r = parse('? which code ask:cory ask:Leanne ask:Cory.\n@ task:ask:no flask:x\n');
  const [a, b] = tasks(r);
  assert.equal(a.text, 'which code .');
  assert.deepEqual(a.asks, ['cory', 'Leanne']);
  assert.deepEqual(b.asks, []);
});

test('legend can define ? as question', () => {
  const r = parse('? = question\n@ = todo\n? who owns it\n');
  assert.equal(tasks(r).length, 1);
  assert.equal(tasks(r)[0].flags.question, true);
});
