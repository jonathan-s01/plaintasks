'use strict';

// Buckets: a task line marked jira:label is a bucket. Its first goal: token is the bucket's id, added from a slug of
// its text the first time something is put in it, so membership survives the bucket being reworded.
// A task's buckets are its own goal: tokens (only ids of known buckets count; goal:none means "no bucket"), else
// its parent task's buckets (a task nested under a bucket line is in that bucket), else the default buckets on its
// file's title line. An own set replaces what would be inherited. Installed onto App.prototype by app.js.

const NONE = 'none';

const isBucket = (t) => t.kind === 'task' && !!t.jiraLabel;

function slugOf(text) {
  const words = text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) || [];
  let out = '';
  for (const w of words) {
    if (out && out.length + w.length + 1 > 32) break;
    out = out ? `${out}-${w}` : w.slice(0, 32);
  }
  return !out || out === NONE ? 'bucket' : out;
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Works out every task's buckets. Sets on each task: isBucket, ownBuckets (known own ids, or null when it has none
 * of its own), buckets (effective ids), bucketSource ('own' | 'parent' | 'list' | null) and bucketFrom (id of the
 * task that holds the set, for 'parent'). Returns the bucket index.
 */
function computeBuckets(tasks, files) {
  const list = tasks.filter(isBucket);
  const byId = new Map();
  for (const b of list) if (b.goalId && b.goalId !== NONE && !byId.has(b.goalId)) byId.set(b.goalId, b);
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const fileOf = new Map(files.map((f) => [f.file, f]));
  const known = (ids) => [...new Set(ids)].filter((x) => byId.has(x));

  const fileDefaults = (file) => {
    const f = fileOf.get(file);
    return f && f.title ? known(f.title.buckets) : [];
  };

  /** What a task would get if it had no buckets of its own. */
  const inherit = (t) => {
    const p = t.parentId ? byTask.get(t.parentId) : null;
    if (p) {
      if (isBucket(p)) return { ids: byId.get(p.goalId) === p ? [p.goalId] : [], source: 'parent', from: p.id };
      resolve(p);
      // Report where the set really comes from: the list's title line, or the task up the tree that holds it.
      if (p.bucketSource === 'list') return { ids: p.buckets, source: 'list', from: null };
      return { ids: p.buckets, source: 'parent', from: p.bucketSource === 'parent' ? p.bucketFrom : p.id };
    }
    const ids = fileDefaults(t.file);
    return { ids, source: ids.length ? 'list' : null, from: null };
  };

  const done = new Set();
  function resolve(t) {
    if (done.has(t.id)) return;
    done.add(t.id);
    t.isBucket = isBucket(t);
    if (t.isBucket) {
      Object.assign(t, { ownBuckets: null, buckets: [], bucketSource: null, bucketFrom: null });
      return;
    }
    const tokens = t.goalLinks || [];
    const own = known(tokens);
    if (own.length || tokens.includes(NONE)) {
      Object.assign(t, { ownBuckets: own, buckets: own, bucketSource: 'own', bucketFrom: t.id });
      return;
    }
    const inh = inherit(t);
    Object.assign(t, { ownBuckets: null, buckets: inh.ids, bucketSource: inh.ids.length ? inh.source : null, bucketFrom: inh.ids.length ? inh.from : null });
  }
  for (const t of tasks) resolve(t);

  const members = new Map([...byId.keys()].map((k) => [k, []]));
  const none = [];
  for (const t of tasks) {
    if (t.isBucket) continue;
    if (!t.buckets.length) none.push(t);
    for (const b of t.buckets) members.get(b).push(t);
  }
  return { list, byId, members, none, inherit: (t) => (isBucket(t) ? { ids: [], source: null, from: null } : inherit(t)), fileDefaults };
}

/** The index's buckets, computing them when the index has not (tests that build an index by hand). */
function bucketIndex(index) {
  return index.buckets || (index.buckets = computeBuckets(index.tasks, index.files || []));
}

/** "inherited from parent: X" / "inherited from list: Y", or ''. */
function sourceText(index, t) {
  if (t.bucketSource === 'parent') {
    const p = index.get ? index.get(t.bucketFrom) : null;
    return p ? `inherited from parent: ${p.text}` : 'inherited from parent';
  }
  if (t.bucketSource === 'list') {
    const f = (index.files || []).find((x) => x.file === t.file);
    return f && f.title ? `inherited from list: ${f.title.text}` : 'inherited from list';
  }
  return '';
}

function install(App, HttpError) {
  const conflict = () => new HttpError(409, 'A bucket changed since the list was shown. Nothing was written. The list has been refreshed.', 'conflict');

  /** Buckets for the chooser, for a task (id) or a file's default buckets (file). Open buckets plus done ones already chosen. */
  App.prototype.bucketChoices = function bucketChoices({ id, file } = {}) {
    const bx = bucketIndex(this.index);
    let checked;
    let inherited = [];
    let inheritedFrom = '';
    let target;
    if (file) {
      const f = this.index.files.find((x) => x.file === file);
      if (!f) throw new HttpError(404, 'That file is no longer in the list. The list has been refreshed.', 'gone');
      if (!f.title) throw new HttpError(400, `${f.label} has no title line, so it cannot have default buckets. Add a plain first line naming the list, then try again.`);
      checked = bx.fileDefaults(f.file);
      target = { file: f.file, text: f.title.text, label: f.label };
    } else {
      const t = this.task(id);
      if (t.kind !== 'task') throw new HttpError(400, 'Only tasks go in buckets. Mark this line as a to-do first.');
      if (isBucket(t)) throw new HttpError(400, `${t.text} is a bucket. Buckets do not go in other buckets.`);
      const inh = bx.inherit(t);
      checked = t.buckets;
      inherited = inh.ids;
      inheritedFrom = inh.source === 'parent' ? `parent: ${(this.index.get(inh.from) || {}).text || ''}` : inh.source === 'list' ? `list: ${(this.index.files.find((x) => x.file === t.file).title || {}).text}` : '';
      target = { id: t.id, text: t.text, source: t.bucketSource, sourceText: sourceText(this.index, t) };
    }
    return {
      target,
      task: target.text,
      inherited,
      inheritedFrom,
      buckets: bx.list
        .filter((b) => !b.flags.done || (b.goalId && checked.includes(b.goalId)))
        .map((b) => ({
          id: b.id,
          bucketId: b.goalId,
          text: b.text,
          done: b.flags.done,
          checked: !!(b.goalId && checked.includes(b.goalId)),
          inherited: !!(b.goalId && inherited.includes(b.goalId)),
          count: b.goalId && bx.byId.get(b.goalId) === b ? bx.members.get(b.goalId).length : 0,
        })),
    };
  };

  /** Bucket ids for the chosen bucket task ids, giving a bucket an id first when it has none. Writes go on the caller's undo collection. */
  App.prototype.bucketIdsFor = function bucketIdsFor(value) {
    const wanted = [...new Set(Array.isArray(value && value.ids) ? value.ids.map(String) : [])];
    const chosen = wanted.map((bid) => {
      const b = this.index.get(bid);
      if (!b) throw conflict();
      if (!isBucket(b)) throw new HttpError(400, `Not a bucket: ${b.text}. Buckets are lines marked jira:label.`);
      return b;
    });
    const ids = [];
    for (const b0 of chosen) {
      let b = b0;
      if (!b.goalId) {
        const taken = new Set([NONE]);
        for (const x of this.index.tasks) {
          for (const v of [x.goalId, x.refId, ...(x.goalLinks || []), ...(x.waitsFor || [])]) if (v) taken.add(v);
        }
        const base = slugOf(b.text);
        let slug = base;
        for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
        const r = this.lineWrite(b, 'goals', { own: slug, links: b.goalLinks || [] });
        b = r ? this.index.get(r.focusId) : b;
        if (!b || b.goalId !== slug) throw new HttpError(500, `Could not give the bucket an id: ${b0.text}`);
      }
      ids.push(b.goalId);
    }
    return { ids, names: chosen.map((b) => b.text) };
  };

  /** Runs fn with its line writes collected into one undo step; rolls them back if fn throws. */
  App.prototype.oneUndo = function oneUndo(label, fn) {
    const saved = this.undoStack;
    this.undoStack = [];
    const finish = () => {
      const steps = this.undoStack;
      this.undoStack = saved;
      if (steps.length) this.pushUndo(steps.length === 1 ? steps[0] : { type: 'multi', steps, text: label });
      return steps.length;
    };
    try {
      const res = fn();
      return { res, wrote: finish() };
    } catch (err) {
      if (finish()) {
        try { this.undo(); } catch { /* the error below explains the first failure */ }
      }
      throw err;
    }
  };

  /**
   * Sets a task's buckets. value.ids: the bucket task ids it should be in. When that equals what it would inherit,
   * its own tokens are removed so it inherits again; an empty choice over a non-empty inherited set writes goal:none.
   */
  App.prototype.bucketSet = function bucketSet(t, value) {
    if (t.kind !== 'task') throw new HttpError(400, 'Only tasks go in buckets. Mark this line as a to-do first.');
    if (isBucket(t)) throw new HttpError(400, `${t.text} is a bucket. Buckets do not go in other buckets.`);
    const fileOf = t.file;
    const lineOf = t.lineIndex;
    let names = [];
    let r = null;
    const { wrote } = this.oneUndo(t.text, () => {
      const picked = this.bucketIdsFor(value);
      names = picked.names;
      // Re-read the task: giving a bucket an id may have changed its line (when the bucket sits in the same file).
      const cur = this.index.get(this.idAt(fileOf, lineOf)) || this.index.get(t.id);
      if (!cur || cur.text !== t.text) throw new HttpError(409, 'The file changed since the list was shown. Nothing was written. The list has been refreshed.', 'conflict');
      const bx = bucketIndex(this.index);
      // Keep tokens that point at no known bucket, so a bucket in a file that is not indexed right now is not lost.
      const unknown = (cur.goalLinks || []).filter((x) => x !== NONE && !bx.byId.has(x));
      const inherited = bx.inherit(cur).ids;
      let links;
      if (sameSet(picked.ids, inherited)) links = unknown;
      else if (!picked.ids.length) links = [NONE, ...unknown];
      else links = [...picked.ids, ...unknown.filter((x) => !picked.ids.includes(x))];
      r = this.lineWrite(cur, 'goals', { own: null, links });
    });
    const now = this.index.get(r ? r.focusId : this.idAt(fileOf, lineOf));
    const how = now && now.bucketSource !== 'own' ? sourceText(this.index, now) : '';
    const message = names.length
      ? `${names.length > 1 ? 'Buckets' : 'Bucket'}: ${names.join('; ')}${how ? ` (${how})` : ''}. Task: ${t.text}`
      : `No bucket: ${t.text}`;
    if (!wrote) return { ok: true, message: `No change. ${message}` };
    return { ok: true, message, undo: true, focusId: r ? r.focusId : this.idAt(fileOf, lineOf) };
  };

  /** Sets a file's default buckets, written on its title line. value.ids: bucket task ids. */
  App.prototype.listBucketSet = function listBucketSet(file, value) {
    const f0 = this.index.files.find((x) => x.file === file);
    if (!f0) throw new HttpError(404, 'That file is no longer in the list. The list has been refreshed.', 'gone');
    if (!f0.title) throw new HttpError(400, `${f0.label} has no title line, so it cannot have default buckets. Add a plain first line naming the list, then try again.`);
    let names = [];
    let title = f0.title.text;
    const { wrote } = this.oneUndo(`Default buckets of ${f0.label}`, () => {
      const picked = this.bucketIdsFor(value);
      names = picked.names;
      const f = this.index.files.find((x) => x.file === file);
      if (!f || !f.title || f.title.lineIndex !== f0.title.lineIndex) throw conflict();
      title = f.title.text;
      const bx = bucketIndex(this.index);
      const unknown = f.title.buckets.filter((x) => x !== NONE && !bx.byId.has(x));
      const links = [...picked.ids, ...unknown.filter((x) => !picked.ids.includes(x))];
      const line = { file, lineIndex: f.title.lineIndex, raw: f.title.raw, text: f.title.text, symbols: {}, unmarkedMode: f.unmarkedMode };
      const before = (this.index.unmarked.find((x) => x.file === file && x.lineIndex === line.lineIndex) || {}).textHash;
      this.lineWrite(line, 'goals', { own: null, links });
      // A title line the user marked as a note in triage stays a note after its tokens change.
      const after = (this.index.unmarked.find((x) => x.file === file && x.lineIndex === line.lineIndex) || {}).textHash;
      const dismissed = this.stateData.dismissed[file] || [];
      if (before && after && before !== after && dismissed.includes(before) && !dismissed.includes(after)) {
        dismissed.push(after);
        this.saveState();
        this.index.refresh(this.now());
      }
    });
    const message = names.length
      ? `Default ${names.length > 1 ? 'buckets' : 'bucket'} for ${title}: ${names.join('; ')}. Tasks without buckets of their own inherit ${names.length > 1 ? 'them' : 'it'}.`
      : `No default bucket for ${title}.`;
    if (!wrote) return { ok: true, message: `No change. ${message}` };
    return { ok: true, message, undo: true };
  };
}

module.exports = { install, isBucket, slugOf, computeBuckets, bucketIndex, sourceText, NONE };
