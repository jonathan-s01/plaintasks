'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyOp } = require('../src/ops');
const { DEFAULT_SYMBOLS } = require('../src/parser');
const { replaceLine, ConflictError, UnsupportedFileError, readTextFile } = require('../src/writer');

const TODAY = new Date(2026, 10, 16);
const ctx = { symbols: DEFAULT_SYMBOLS, unmarkedMode: 'notes', today: TODAY };
const op = (line, name, arg, c = ctx) => applyOp(line, name, arg, c);

test('done adds + and a done date; reopen restores @ in notes mode', () => {
  assert.equal(op('@ call vendor', 'done'), '+@ call vendor done:2026-11-16');
  assert.equal(op('  @ sub', 'done'), '  +@ sub done:2026-11-16');
  assert.equal(op('+@ call vendor done:2026-11-16', 'reopen'), '@ call vendor');
  assert.equal(op('+ call vendor done:2026-11-16', 'reopen'), '@ call vendor');
  assert.equal(op('+* big done:2026-11-01', 'reopen'), '* big');
});

test('done in tasks mode on an unmarked line, and reopen back to unmarked', () => {
  const c = { ...ctx, unmarkedMode: 'tasks' };
  assert.equal(op('Buy milk', 'done', null, c), '+ Buy milk done:2026-11-16');
  assert.equal(op('+ Buy milk done:2026-11-16', 'reopen', null, c), 'Buy milk');
});

test('toggling flags keeps other markers; waiting markers are exclusive', () => {
  assert.equal(op('@ x', 'important'), '@* x');
  assert.equal(op('@* x', 'important'), '@ x');
  assert.equal(op('< x', 'waitingOnOthers'), '> x');
  assert.equal(op('@ x', 'waitingOnMe'), '@< x');
  assert.equal(op('< x', 'waitingOnMe'), '@ x');
  assert.equal(op('plain line', 'inProgress'), '% plain line');
});

test('ongoing writes ~, and done/reopen on a • subtask keep the •', () => {
  assert.equal(applyOp('@ big thing', 'ongoing', null, ctx), '@~ big thing');
  assert.equal(applyOp('~ big thing', 'ongoing', null, ctx), '@ big thing');
  assert.equal(applyOp('• sub', 'done', null, ctx), '+• sub done:2026-11-16');
  assert.equal(applyOp('+• sub done:2026-11-16', 'reopen', null, ctx), '• sub');
});

test('todo (triage) prefixes @ and keeps indentation; marked lines unchanged', () => {
  assert.equal(op('\tsend email', 'todo'), '\t@ send email');
  assert.equal(op('+ done', 'todo'), '+ done');
});

test('due set, replace and clear', () => {
  assert.equal(op('@ x', 'due', '2026-11-20'), '@ x due:2026-11-20');
  assert.equal(op('@ x due:fri', 'due', '2026-12-01'), '@ x due:2026-12-01');
  assert.equal(op('@ x due:2026-11-20 more', 'due', null), '@ x more');
});

test('jira link validates keys', () => {
  assert.equal(op('@ x', 'jira', 'abc-12'), '@ x jira:ABC-12');
  assert.throws(() => op('@ x', 'jira', 'nope'));
});

test('legend symbols are respected when writing', () => {
  const c = { symbols: { ...DEFAULT_SYMBOLS, '✓': 'done' }, unmarkedMode: 'notes', today: TODAY };
  const noPlus = { ...c, symbols: { '✓': 'done', '@': 'todo' } };
  assert.equal(op('@ x', 'done', null, noPlus), '✓@ x done:2026-11-16');
});

const tmpFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-writer-'));
  const f = path.join(dir, 'n.txt');
  fs.writeFileSync(f, content);
  return f;
};

test('replaceLine changes only the target line and preserves CRLF/CR/no-final-newline bytes', () => {
  const original = 'a\r\n@ b\r\nc\r@ d';
  const f = tmpFile(original);
  replaceLine(f, { lineIndex: 1, expected: '@ b', replacement: '+ b done:2026-11-16' });
  assert.equal(fs.readFileSync(f, 'utf8'), 'a\r\n+ b done:2026-11-16\r\nc\r@ d');
});

test('replaceLine preserves UTF-8 BOM and UTF-16 encodings', () => {
  const bom = tmpFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('@ é\n', 'utf8')]));
  replaceLine(bom, { lineIndex: 0, expected: '@ é', replacement: '+ é' });
  assert.deepEqual([...fs.readFileSync(bom).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(readTextFile(bom).text, '+ é\n');

  const u16 = tmpFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('@ x\n', 'utf16le')]));
  replaceLine(u16, { lineIndex: 0, expected: '@ x', replacement: '+ x' });
  const bytes = fs.readFileSync(u16);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(bytes.subarray(2).toString('utf16le'), '+ x\n');
});

test('replaceLine follows a unique shifted line, refuses ambiguous or vanished ones', () => {
  const f = tmpFile('new first line\n@ b\n');
  replaceLine(f, { lineIndex: 0, expected: '@ b', replacement: '+ b' });
  assert.equal(fs.readFileSync(f, 'utf8'), 'new first line\n+ b\n');

  const dup = tmpFile('@ b\n@ b\n');
  assert.throws(() => replaceLine(dup, { lineIndex: 5, expected: '@ b', replacement: '+ b' }), ConflictError);
  assert.equal(fs.readFileSync(dup, 'utf8'), '@ b\n@ b\n');

  const gone = tmpFile('something else\n');
  assert.throws(() => replaceLine(gone, { lineIndex: 0, expected: '@ b', replacement: '+ b' }), ConflictError);
});

test('replaceLine leaves no temp files and keeps file mode', () => {
  const f = tmpFile('@ a\n');
  fs.chmodSync(f, 0o640);
  replaceLine(f, { lineIndex: 0, expected: '@ a', replacement: '+ a' });
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['n.txt']);
  assert.equal(fs.statSync(f).mode & 0o777, 0o640);
});

test('non-UTF-8 and binary files are refused, not corrupted', () => {
  const latin = tmpFile(Buffer.from([0x40, 0x20, 0xe9, 0x0a]));
  assert.throws(() => replaceLine(latin, { lineIndex: 0, expected: '@ é', replacement: '+ é' }), UnsupportedFileError);
  assert.deepEqual([...fs.readFileSync(latin)], [0x40, 0x20, 0xe9, 0x0a]);
});

test('replacement must be a single line', () => {
  const f = tmpFile('@ a\n');
  assert.throws(() => replaceLine(f, { lineIndex: 0, expected: '@ a', replacement: 'x\ny' }));
});

test('text rewords a task and keeps its tokens; done takes the date it was done', () => {
  const raw = '\t% call bob due:2026-11-20 jira:ABC-1 goal:x start:2026-11-01';
  assert.equal(applyOp(raw, 'text', 'phone  Bob', ctx), '\t% phone Bob due:2026-11-20 jira:ABC-1 goal:x start:2026-11-01');
  assert.throws(() => applyOp(raw, 'text', ' ', ctx), /empty/);
  assert.equal(applyOp('@ a', 'done', '2026-10-01', ctx), '+@ a done:2026-10-01');
  assert.equal(applyOp('@ a', 'done', null, ctx), '+@ a done:2026-11-16');
  assert.equal(applyOp('@ a start:2026-01-01', 'start', '2026-02-02', ctx), '@ a start:2026-02-02');
});
