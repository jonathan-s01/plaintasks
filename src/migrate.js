'use strict';

// One-off migration from goals to buckets for a folder of task files.
// (a) A `~` line that is not a bucket loses its old own goal id when nothing links to it.
// (b) Each file with a title line gets the default buckets that save the most tokens, and tasks drop
//     bucket tokens that equal what they would now inherit.
// Every task's effective buckets (and so its Jira labels) must be the same before and after.

const fs = require('node:fs');
const path = require('node:path');
const { Index } = require('./indexer');
const { applyOp } = require('./ops');
const { decode, encode } = require('./writer');
const { GOAL_RE } = require('./parser');
const { NONE } = require('./buckets');

function indexFolder(folder, unmarked) {
  const index = new Index({ getConfig: () => ({ folders: [{ path: folder, unmarked, excluded: [], overrides: {} }] }) });
  index.refresh();
  return index;
}

/** file|lineIndex -> sorted effective buckets, for every indexed task. Lines never move in this migration. */
function effective(index) {
  const out = new Map();
  for (const t of index.tasks) out.set(`${t.file}|${t.lineIndex}`, t.isBucket ? 'BUCKET' : [...t.buckets].sort().join(' '));
  return out;
}

function diffEffective(a, b, root) {
  const out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(k) !== b.get(k)) {
      const [file, line] = k.split('|');
      out.push(`${path.relative(root, file)}:${Number(line) + 1}: ${a.get(k) ?? '(none)'} -> ${b.get(k) ?? '(none)'}`);
    }
  }
  return out;
}

/** Keep exactly `keep` goal: tokens. Removes others in place so the rest of the line keeps its order; appends only when it must. */
function setGoals(raw, keep, ctx) {
  const present = [];
  const out = raw.replace(new RegExp(GOAL_RE.source, 'g'), (m, pre, id) => {
    const x = id.toLowerCase();
    if (keep.includes(x) && !present.includes(x)) {
      present.push(x);
      return m;
    }
    return '';
  }).replace(/[ \t]+$/, '');
  const missing = keep.filter((x) => !present.includes(x));
  return missing.length ? applyOp(out, 'goals', { own: null, links: [...present, ...missing] }, ctx) : out;
}

const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** Plan every line change. Returns { changes: Map(file -> Map(lineIndex -> {expected, replacement})), report }. */
function plan(index) {
  const bx = index.buckets;
  const known = (ids) => ids.filter((x) => bx.byId.has(x));
  const byId = new Map(index.tasks.map((t) => [t.id, t]));
  const changes = new Map();
  const report = { idsRemoved: [], defaultsSet: [], tokensRemoved: 0, tokensAdded: 0, linesChanged: 0 };
  const lineOf = (file, lineIndex, raw) => {
    if (!changes.has(file)) changes.set(file, new Map());
    const m = changes.get(file);
    if (!m.has(lineIndex)) m.set(lineIndex, { expected: raw, replacement: raw });
    return m.get(lineIndex);
  };

  // (a) Old own ids on ~ lines that are not buckets, when nothing else refers to them.
  const refs = new Map();
  const ref = (id, who) => refs.set(id, (refs.get(id) || 0) + (who ? 1 : 0));
  for (const t of index.tasks) {
    for (const g of t.goalLinks || []) ref(g, true);
    for (const a of t.waitsFor || []) ref(a, true);
  }
  for (const f of index.files) for (const g of (f.title && f.title.buckets) || []) ref(g, true);
  for (const t of index.tasks) {
    if (t.isBucket || !t.flags.ongoing || !(t.goalLinks || []).length) continue;
    const own = t.goalLinks[0];
    if (bx.byId.has(own) || own === NONE || refs.get(own) > 1) continue;
    const c = lineOf(t.file, t.lineIndex, t.raw);
    const rest = t.goalLinks.slice(1);
    c.replacement = setGoals(c.replacement, rest, { symbols: t.symbols });
    t.goalLinks = rest;
    report.idsRemoved.push({ file: t.file, line: t.lineIndex + 1, id: own, text: t.text });
  }

  // (b) Per file: choose defaults, then write each task's tokens only where they differ from what it inherits.
  const tasksByFile = new Map();
  for (const t of index.tasks) {
    if (!tasksByFile.has(t.file)) tasksByFile.set(t.file, []);
    tasksByFile.get(t.file).push(t);
  }
  for (const f of index.files) {
    const tasks = tasksByFile.get(f.file) || [];
    const current = f.title ? known(f.title.buckets) : [];
    let defaults = current;
    if (f.title) {
      // Only top-level tasks depend on the defaults; deeper ones inherit from their parent, whose set does not change.
      const top = tasks.filter((t) => !t.isBucket && !t.parentId);
      const cost = (d) => d.length + top.reduce((n, t) => n + (same(t.buckets, d) ? 0 : Math.max(1, t.buckets.length)), 0);
      const candidates = [current, [], ...top.map((t) => t.buckets)];
      let best = cost(current);
      for (const c of candidates) {
        const n = cost(c);
        if (n < best) [best, defaults] = [n, c];
      }
      if (!same(defaults, current)) {
        const title = { raw: f.title.raw, lineIndex: f.title.lineIndex };
        const c = lineOf(f.file, title.lineIndex, title.raw);
        const unknown = f.title.buckets.filter((x) => !bx.byId.has(x));
        c.replacement = setGoals(c.replacement, [...defaults, ...unknown], { unmarkedMode: f.unmarkedMode });
        report.defaultsSet.push({ file: f.file, title: f.title.text, buckets: defaults, was: current });
        report.tokensAdded += defaults.length;
        report.tokensRemoved += current.filter((x) => !defaults.includes(x)).length;
      }
    }
    for (const t of tasks) {
      if (t.isBucket) continue;
      const p = t.parentId ? byId.get(t.parentId) : null;
      const inherited = p ? (p.isBucket ? (bx.byId.get(p.goalId) === p ? [p.goalId] : []) : p.buckets) : defaults;
      const links = t.goalLinks || [];
      const ownTokens = links.filter((x) => bx.byId.has(x) || x === NONE);
      const unknown = links.filter((x) => !bx.byId.has(x) && x !== NONE);
      let want;
      if (same(t.buckets, inherited)) want = [];
      else want = t.buckets.length ? t.buckets : [NONE];
      const wasExplicit = ownTokens.length > 0;
      if (wasExplicit && same(ownTokens, want)) continue;
      if (!wasExplicit && !want.length) continue;
      const c = lineOf(t.file, t.lineIndex, t.raw);
      c.replacement = setGoals(c.replacement, [...want, ...unknown], { symbols: t.symbols });
      report.tokensRemoved += ownTokens.filter((x) => !want.includes(x)).length;
      report.tokensAdded += want.filter((x) => !ownTokens.includes(x)).length;
    }
  }
  for (const [file, m] of changes) {
    for (const [i, c] of m) {
      if (c.replacement === c.expected) m.delete(i);
      else report.linesChanged += 1;
    }
    if (!m.size) changes.delete(file);
  }
  return { changes, report };
}

function readLines(file) {
  const { encoding, text } = decode(fs.readFileSync(file));
  const parts = text.split(/(\r\n|\r|\n)/);
  const lines = [];
  const eols = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i]);
    eols.push(parts[i + 1] || '');
  }
  return { encoding, lines, eols };
}

function writeChanges(changes) {
  for (const [file, m] of changes) {
    const { encoding, lines, eols } = readLines(file);
    for (const [i, c] of m) {
      if (lines[i] !== c.expected) throw new Error(`${file}:${i + 1} changed since it was read; nothing more was written`);
      lines[i] = c.replacement;
    }
    const tmp = `${file}.migrate-${process.pid}`;
    fs.writeFileSync(tmp, encode(lines.map((l, i) => l + eols[i]).join(''), encoding));
    fs.renameSync(tmp, file);
  }
}

/** Run the migration on `folder`. With write false, changes go to a temporary copy to check them. */
function migrate(folder, { unmarked = 'notes', write = false } = {}) {
  const root = path.resolve(folder);
  const beforeIndex = indexFolder(root, unmarked);
  const before = effective(beforeIndex);
  const { changes, report } = plan(beforeIndex);

  // Check on a copy first, always.
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pt-migrate-'));
  const copy = path.join(tmp, path.basename(root));
  fs.cpSync(root, copy, { recursive: true });
  const toCopy = (file) => path.join(copy, path.relative(root, file));
  writeChanges(new Map([...changes].map(([file, m]) => [toCopy(file), m])));
  const after = new Map([...effective(indexFolder(copy, unmarked))].map(([k, v]) => [k.replace(copy, root), v]));
  const diff = diffEffective(before, after, root);
  const preview = [];
  for (const [file, m] of changes) for (const [i, c] of [...m].sort((a, b) => a[0] - b[0])) preview.push({ file: path.relative(root, file), line: i + 1, from: c.expected, to: c.replacement });
  fs.rmSync(tmp, { recursive: true, force: true });

  report.tasks = before.size;
  report.diff = diff;
  report.preview = preview;
  report.written = false;
  if (write && !diff.length) {
    writeChanges(changes);
    report.written = true;
  }
  return report;
}

module.exports = { migrate, plan, effective, indexFolder };
