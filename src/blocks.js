'use strict';

// Blocked by: any task can carry an id:slug token, and others wait for it with after:slug (several allowed).
// A bucket's own goal: id is a valid target too. A task is blocked while any task it waits for is open; a done task,
// or a $ (deleted) one that is no longer indexed, no longer blocks. Unresolved after: tokens are left alone.
// Installed onto App.prototype by app.js; link() is called by the indexer after every scan.

const { slugOf, isBucket } = require('./buckets');

/** Map from target id (id: or a bucket's own goal: id) to the task that carries it. First one wins. */
function targetMap(tasks) {
  const map = new Map();
  for (const t of tasks) if (t.refId && !map.has(t.refId)) map.set(t.refId, t);
  for (const t of tasks) if (t.goalId && !map.has(t.goalId)) map.set(t.goalId, t);
  return map;
}

/** Sets blockedBy (ids of tasks it waits for), blocked, and blocksCount (open tasks waiting for it) on every task. */
function link(tasks) {
  const map = targetMap(tasks);
  for (const t of tasks) {
    t.blockedBy = [];
    t.blocksCount = 0;
  }
  for (const t of tasks) {
    const seen = new Set();
    for (const a of t.waitsFor || []) {
      const b = map.get(a);
      if (!b || b === t || seen.has(b.id)) continue;
      seen.add(b.id);
      t.blockedBy.push(b.id);
      if (!t.flags.done) b.blocksCount += 1;
    }
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    t.blocked = !t.flags.done && t.blockedBy.some((id) => !byId.get(id).flags.done);
    t.blockerNames = t.blockedBy.map((id) => { const b = byId.get(id); return b.flags.done ? `${b.text} (done)` : b.text; });
  }
}

function install(App, HttpError) {
  /** Open tasks a task could wait for, plus ones it already waits for. Tasks that wait for it, directly or not, are left out. */
  App.prototype.blockChoices = function blockChoices(id) {
    const t = this.task(id);
    const byId = this.index.byId;
    const mine = new Set(t.blockedBy || []);
    const waitsForMe = (c, seen = new Set()) => {
      if (c.id === t.id) return true;
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return (c.blockedBy || []).some((b) => waitsForMe(byId.get(b), seen));
    };
    return {
      task: t.text,
      tasks: this.index.tasks
        .filter((c) => c.id !== t.id && (mine.has(c.id) || (!c.flags.done && !isBucket(c) && !waitsForMe(c))))
        .map((c) => ({ id: c.id, text: c.text, done: c.flags.done, file: c.fileLabel, line: c.line, linked: mine.has(c.id), blocked: !!c.blocked })),
    };
  };

  /** Sets what a task waits for. value.ids: task ids to wait for; any other blocker is dropped. */
  App.prototype.blockSet = function blockSet(t, value) {
    const wanted = [...new Set(Array.isArray(value && value.ids) ? value.ids.map(String) : [])];
    if (wanted.includes(t.id)) throw new HttpError(400, 'A task cannot wait for itself.');
    const byId = this.index.byId;
    const blockers = wanted.map((bid) => {
      const b = this.index.get(bid);
      if (!b || b.kind !== 'task') throw new HttpError(409, 'A task changed since the list was shown. Nothing was written. The list has been refreshed.', 'conflict');
      return b;
    });
    const waitsForMe = (c, seen = new Set()) => {
      if (c.id === t.id) return true;
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return (c.blockedBy || []).some((b) => waitsForMe(byId.get(b), seen));
    };
    for (const b of blockers) if (!(t.blockedBy || []).includes(b.id) && waitsForMe(b)) throw new HttpError(400, `${b.text} already waits for this task, directly or through others, so it cannot block it.`);
    const fileOf = t.file;
    const lineOf = t.lineIndex;
    const saved = this.undoStack;
    this.undoStack = [];
    const finish = () => {
      const steps = this.undoStack;
      this.undoStack = saved;
      if (steps.length) this.pushUndo(steps.length === 1 ? steps[0] : { type: 'multi', steps, text: t.text });
      return steps.length;
    };
    const ids = [];
    try {
      for (const b0 of blockers) {
        let b = b0;
        let target = b.refId || b.goalId;
        if (!target) {
          const taken = new Set();
          for (const x of this.index.tasks) {
            for (const v of [x.refId, x.goalId, ...(x.goalLinks || []), ...(x.waitsFor || [])]) if (v) taken.add(v);
          }
          const base = slugOf(b.text) === 'bucket' ? 'task' : slugOf(b.text);
          target = base;
          for (let n = 2; taken.has(target); n += 1) target = `${base}-${n}`;
          const r = this.lineWrite(b, 'refId', target);
          b = r ? this.index.get(r.focusId) : b;
          if (!b || b.refId !== target) throw new HttpError(500, `Could not give the task an id: ${b0.text}`);
        }
        ids.push(target);
      }
      const cur = this.index.get(this.idAt(fileOf, lineOf)) || this.index.get(t.id);
      if (!cur || cur.text !== t.text) throw new HttpError(409, 'The file changed since the list was shown. Nothing was written. The list has been refreshed.', 'conflict');
      const known = targetMap(this.index.tasks);
      const unknown = (cur.waitsFor || []).filter((x) => !known.has(x));
      const after = [...ids, ...unknown.filter((x) => !ids.includes(x))];
      const r = this.lineWrite(cur, 'after', after);
      const wrote = finish();
      const names = blockers.map((b) => b.text);
      const message = names.length ? `Blocked by: ${names.join('; ')}. Task: ${t.text}` : `Not blocked by anything: ${t.text}`;
      if (!wrote) return { ok: true, message: `No change. ${message}` };
      return { ok: true, message, undo: true, focusId: r ? r.focusId : this.idAt(fileOf, lineOf) };
    } catch (err) {
      if (this.undoStack !== saved && finish()) {
        try { this.undo(); } catch { /* the error below explains the first failure */ }
      }
      throw err;
    }
  };
}

module.exports = { install, link, targetMap };
