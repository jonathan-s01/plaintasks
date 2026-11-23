#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { migrate } = require('../src/migrate');

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const folder = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--unmarked');
if (!folder || args.includes('--help')) {
  console.log(`Usage: migrate-buckets <folder> [--unmarked notes|tasks] [--dry-run | --write] [--verbose]

Moves a folder of task files from goals to buckets:
  - removes old goal ids from ~ lines that are not buckets (jira:label) when nothing links to them
  - sets each file's default buckets on its title line and removes task bucket tokens that equal
    what the task would inherit
Every task's effective buckets (and so its Jira labels) are checked to be unchanged on a copy first.
Dry run is the default; nothing is written without --write. Back up or commit the folder first.`);
  process.exit(folder ? 0 : 2);
}
const unmarked = opt('unmarked') || 'notes';
if (!['notes', 'tasks'].includes(unmarked)) {
  console.error('--unmarked must be notes or tasks');
  process.exit(2);
}
const write = args.includes('--write');

const r = migrate(folder, { unmarked, write });
const rel = (f) => path.relative(path.resolve(folder), f);
console.log(`${write ? 'WRITE' : 'DRY RUN'}: ${path.resolve(folder)}`);
console.log(`Tasks checked: ${r.tasks}`);
console.log(`Old goal ids removed from ~ lines: ${r.idsRemoved.length}`);
for (const x of r.idsRemoved) console.log(`  ${rel(x.file)}:${x.line} goal:${x.id} (${x.text})`);
console.log(`Title-line defaults set: ${r.defaultsSet.length}`);
for (const x of r.defaultsSet) console.log(`  ${rel(x.file)}: ${x.title}: ${x.buckets.join(', ') || '(none)'}${x.was.length ? ` (was ${x.was.join(', ')})` : ''}`);
console.log(`Bucket tokens removed from tasks and title lines: ${r.tokensRemoved}; added: ${r.tokensAdded}`);
console.log(`Lines changed: ${r.linesChanged}`);
console.log(`Effective-bucket differences: ${r.diff.length}`);
for (const d of r.diff) console.log(`  ${d}`);
if (args.includes('--verbose')) for (const p of r.preview) console.log(`\n${p.file}:${p.line}\n  - ${p.from}\n  + ${p.to}`);
if (r.diff.length) {
  console.log('Not written: effective buckets would change.');
  process.exit(1);
}
console.log(r.written ? 'Written.' : write ? 'Nothing to write.' : 'Nothing written (dry run). Add --write to apply.');
