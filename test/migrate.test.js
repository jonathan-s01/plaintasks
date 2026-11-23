'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate } = require('../src/migrate');

test('migrate-buckets: dry run writes nothing; --write drops unlinked ~ ids, sets title defaults, trims inherited tokens, keeps effective buckets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-mig-'));
  const files = {
    'b.txt': 'Buckets\n~ Ops goal:ops jira:label\n~ Test goal:test jira:label\n',
    'a.txt': 'Team\n\n@ one goal:ops jira:A-1\n\t@ sub\n+ two goal:ops done:2026-11-01\n~ ongoing goal:ongoing-thing goal:ops\n~ linked goal:linked-thing\n@ waits after:linked-thing\n@ other goal:test\n@ three goal:ops\n',
  };
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);

  const dry = migrate(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), files['a.txt'], 'dry run writes nothing');
  assert.deepEqual(dry.idsRemoved.map((x) => x.id), ['ongoing-thing'], 'an id something waits on is kept');
  assert.deepEqual(dry.defaultsSet.map((x) => [x.title, x.buckets]), [['Team', ['ops']]]);
  assert.deepEqual(dry.diff, []);

  const r = migrate(dir, { write: true });
  assert.ok(r.written);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'Team goal:ops\n\n@ one jira:A-1\n\t@ sub\n+ two done:2026-11-01\n~ ongoing\n~ linked goal:linked-thing goal:none\n@ waits after:linked-thing goal:none\n@ other goal:test\n@ three\n');
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), files['b.txt']);
  assert.equal(migrate(dir).linesChanged, 0, 'running again changes nothing');
});
