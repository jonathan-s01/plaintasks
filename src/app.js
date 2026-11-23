'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const cfgMod = require('./config');
const { DEFAULT_LIST } = cfgMod;
const { Index, walk, isExcluded, modeFor, TEXT_EXT } = require('./indexer');
const { applyOp, OpError } = require('./ops');
const { markerInfo, ampNote, parseText } = require('./parser');
const { replaceLine, replaceLines, removeLines, moveLine, ConflictError } = require('./writer');
const { formatDate, toISO } = require('./dates');
const { allViews, buildView, viewCounts, untriaged, listTasks, fileBacked } = require('./views');
const { convertRtfFiles } = require('./rtf');
const { JiraClient, JiraError, KEY_RE } = require('./jira');
const { cleanSync } = require('./jirasync');
const secrets = require('./secrets');

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const FLAG_LABELS = {
  waitingOnMe: 'Waiting on me',
  waitingOnOthers: 'Waiting on others',
  important: 'Important',
  inProgress: 'In progress',
  ongoing: 'Ongoing',
};

const FLAG_MESSAGES = {
  waitingOnMe: ['Marked waiting on me', 'No longer waiting on me'],
  waitingOnOthers: ['Marked waiting on someone else', 'No longer waiting on someone else'],
  important: ['Marked important', 'No longer important'],
  inProgress: ['Marked in progress', 'No longer in progress'],
  ongoing: ['Marked ongoing', 'No longer ongoing'],
};

function defaultOpener(file) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-t', file]] : ['xdg-open', [file]];
  execFile(cmd, args, () => {});
}

class App {
  constructor({ dir = cfgMod.configDir(), now = () => new Date(), opener = defaultOpener, rtfExec, trashDir, fetch, secretApi = secrets } = {}) {
    this.dir = dir;
    this.now = now;
    this.opener = opener;
    this.rtfExec = rtfExec;
    this.trashDir = trashDir;
    this.fetch = fetch;
    this.secrets = secretApi;
    this.config = cfgMod.loadConfig(dir);
    this.stateData = cfgMod.loadState(dir);
    this.index = new Index({ getConfig: () => this.config, getNoteLinks: (file) => this.stateData.noteOf[file] || {}, getDismissed: (file) => this.stateData.dismissed[file] || [] });
    this.undoStack = [];
    this.lastWriteAt = 0;
    this.index.refresh(this.now());
  }

  start() {
    this.index.watch();
  }

  stop() {
    this.index.unwatch();
  }

  // ---- reading ----

  summary() {
    const today = this.now();
    this.stampCreated();
    const counts = viewCounts(this.index, this.stateData, today);
    return {
      rev: this.index.rev,
      views: allViews(this.stateData).map((v) => ({ id: v.id, title: v.title, count: counts[v.id] })),
      lists: this.stateData.lists.map((l) => ({ id: l.id, name: l.name, count: counts[`list:${l.id}`], folder: l.folder, sort: l.sort, file: l.file || '', fileTasks: fileBacked(l), notActionable: !!l.notActionable, jiraSync: !!l.jiraSync, jiraLabels: l.jiraLabels || [], jiraStatus: l.jiraStatus || '', notesFile: l.file ? (this.fileEntry(l.file) || {}).label || null : null })),
      lastList: this.stateData.lastList,
      folders: this.config.folders.length,
      files: this.index.files.length,
      problems: this.index.problems,
      rtfPending: this.index.rtf.length,
      jiraConfigured: !!this.jiraClientOrNull(),
      masterFile: this.config.masterFile ? this.masterLabel() : null,
      recentlyWrote: Date.now() - this.lastWriteAt < 3000,
    };
  }

  view(opts) {
    this.stampCreated();
    return buildView(this.index, this.stateData, { ...opts, today: this.now() });
  }

  task(id) {
    const t = this.index.get(id);
    if (!t) throw new HttpError(404, 'That item is no longer in the list. The list has been refreshed.', 'gone');
    return t;
  }

  detail(id) {
    const t = this.task(id);
    return { id: t.id, text: t.text, notes: t.notes, file: t.fileLabel, line: t.line, group: t.group, jira: t.jira, raw: t.raw, kind: t.kind, flags: t.flags, due: t.due };
  }

  // ---- writing ----

  lineWrite(t, op, arg) {
    const today = this.now();
    const steps = Array.isArray(op) ? op : [[op, arg]];
    let next = t.raw;
    try {
      for (const [o, a] of steps) next = applyOp(next, o, a, { symbols: t.symbols, unmarkedMode: t.unmarkedMode, today });
    } catch (err) {
      if (err instanceof OpError) throw new HttpError(400, err.message);
      throw err;
    }
    if (next === t.raw) return null;
    let res;
    try {
      res = replaceLine(t.file, { lineIndex: t.lineIndex, expected: t.raw, replacement: next });
      this.undoStack.push({ type: 'line', file: t.file, lineIndex: res.lineIndex, before: t.raw, after: next, text: t.text });
      if (this.undoStack.length > 100) this.undoStack.shift();
    } catch (err) {
      this.index.refresh(today);
      if (err instanceof ConflictError) throw new HttpError(409, err.message, 'conflict');
      throw new HttpError(500, `Could not write the file: ${err.message}`);
    }
    this.lastWriteAt = Date.now();
    this.index.refresh(today);
    return { focusId: this.idAt(t.file, res.lineIndex) };
  }

  idAt(file, lineIndex) {
    const hit = [...this.index.tasks, ...this.index.unmarked].find((x) => x.file === file && x.lineIndex === lineIndex);
    return hit ? hit.id : null;
  }

  saveState() {
    cfgMod.saveState(this.dir, this.stateData);
  }

  restoreTask(t) {
    const parentKey = (this.stateData.noteOf[t.file] || {})[t.textHash] || null;
    this.stateData.dismissed[t.file] = (this.stateData.dismissed[t.file] || []).filter((h) => h !== t.textHash);
    if (this.stateData.noteOf[t.file]) delete this.stateData.noteOf[t.file][t.textHash];
    this.saveState();
    this.index.refresh(this.now());
    this.undoStack.push({ type: 'restore', file: t.file, hash: t.textHash, parentKey });
    this.index.emit('change', this.index.rev);
  }

  /** The nearest task above an unmarked line in the same file, or null. */
  taskAbove(u) {
    let best = null;
    for (const t of this.index.tasks) if (t.file === u.file && t.lineIndex < u.lineIndex && (!best || t.lineIndex > best.lineIndex)) best = t;
    return best;
  }

  /** Mark unmarked lines as notes (stored in state, never in the file). Each attaches to the task above it, if any. */
  dismiss(items, { silent = false } = {}) {
    for (const t of items) {
      const list = (this.stateData.dismissed[t.file] = this.stateData.dismissed[t.file] || []);
      if (!list.includes(t.textHash)) list.push(t.textHash);
      const parent = this.taskAbove(t);
      if (parent) {
        const links = (this.stateData.noteOf[t.file] = this.stateData.noteOf[t.file] || {});
        links[t.textHash] = parent.listKey;
      }
    }
    this.saveState();
    const entry = { type: 'dismiss', items: items.map((t) => ({ file: t.file, hash: t.textHash })) };
    if (!silent) this.undoStack.push(entry);
    this.index.refresh(this.now());
    this.index.emit('change', this.index.rev);
    return entry;
  }

  /**
   * Marks unmarked lines as notes. A line with a task above it gets "& " written into the file, so it is a note of that
   * task for good; any other line is remembered as a note in state. Returns how many lines were written to files.
   */
  markNotes(items, what) {
    const byFile = new Map();
    for (const t of items) byFile.set(t.file, [...(byFile.get(t.file) || []), t]);
    const steps = [];
    const rest = [];
    let written = 0;
    for (const [file, list] of byFile) {
      const parsed = this.parsedFor(file);
      const changes = [];
      for (const t of list) {
        const me = parsed.items.find((i) => i.lineIndex === t.lineIndex);
        const hasHost = parsed.items.some((i) => i.kind === 'task' && i.lineIndex < t.lineIndex);
        if (!me || me.kind !== 'unmarked' || !hasHost || !ampNote(`& ${t.text}`) || /^\s*&/.test(me.raw)) {
          rest.push(t);
          continue;
        }
        changes.push({ lineIndex: me.lineIndex, expected: me.raw, replacement: `${/^[ \t]*/.exec(me.raw)[0]}& ${me.raw.trim()}`, item: t });
      }
      const lines = [...parsed.lines];
      for (const c of changes) lines[c.lineIndex] = c.replacement;
      const after = parseText(lines.join('\n'), { unmarked: list[0].unmarkedMode, today: this.now() });
      const attached = new Set();
      for (const it of after.items) for (const n of it.notes) if (n.amp) attached.add(n.lineIndex);
      const ok = changes.filter((c) => attached.has(c.lineIndex));
      for (const c of changes) if (!attached.has(c.lineIndex)) rest.push(c.item);
      if (!ok.length) continue;
      try {
        replaceLines(file, ok.map(({ lineIndex, expected, replacement }) => ({ lineIndex, expected, replacement })));
      } catch (err) {
        this.writeFailed(err, 'mark these lines as notes');
      }
      this.lastWriteAt = Date.now();
      written += ok.length;
      steps.push({ type: 'lines', file, changes: ok.map((c) => ({ lineIndex: c.lineIndex, before: c.expected, after: c.replacement })), text: what });
    }
    if (rest.length) steps.push(this.dismiss(rest, { silent: true }));
    else this.index.refresh(this.now());
    if (steps.length === 1) this.undoStack.push(steps[0]);
    else if (steps.length) this.undoStack.push({ type: 'multi', steps, text: what });
    return written;
  }

  async action({ id, op, value, list }) {
    const today = this.now();
    if (op === 'listCreate' || op === 'listRename' || op === 'listDelete') return this.listManage(op, list, value);
    if (op === 'listSort') return this.listSort(list, value);
    if (op === 'listEdit') return this.listEdit(list, value);
    if (op === 'listNote') return this.listNote(value, list);
    if (op === 'newTask') return this.newTask(value, list);
    if (op === 'dismissFile') {
      const file = String(id).replace(/^f:/, '');
      const list = untriaged(this.index, this.stateData).filter((u) => u.file === file);
      if (!list.length) throw new HttpError(404, 'Nothing left to skip in that file');
      this.markNotes(list, `${list.length} notes`);
      const entry = this.index.files.find((x) => x.file === file);
      this.stateData.reviewed[file] = entry ? entry.mtimeMs : list[0].fileMtime;
      this.saveState();
      return { ok: true, message: `Marked ${list.length} ${list.length === 1 ? 'line' : 'lines'} as notes in ${list[0].fileLabel}`, undo: true };
    }
    if (op === 'reviewFile') {
      const file = String(id).startsWith('f:') ? String(id).slice(2) : (this.index.get(id) || {}).file;
      const f = this.index.files.find((x) => x.file === file);
      if (!f) throw new HttpError(404, 'That file is no longer in the list. The list has been refreshed.', 'gone');
      const prev = this.stateData.reviewed[file];
      this.stateData.reviewed[file] = f.mtimeMs;
      this.saveState();
      this.undoStack.push({ type: 'reviewed', file, prev });
      this.touchList();
      return { ok: true, message: `Marked ${f.label} as reviewed. It returns to the new and changed filter when the file changes.`, undo: true };
    }
    if (op === 'listBucketSet') return this.listBucketSet(String(id || '').replace(/^f:/, ''), value);
    if (op === 'refresh') {
      this.index.refresh(today);
      return { ok: true, message: 'List refreshed' };
    }
    const t = this.task(id);
    const done = (r, message) => (r ? { ok: true, message, undo: true, focusId: r.focusId } : { ok: true, message: `No change: ${t.text}` });
    switch (op) {
      case 'dismiss':
      case 'note': {
        if (t.kind === 'task' && t.childIds.length) throw new HttpError(400, 'This task has subtasks, so it cannot become a note.');
        const parent = this.taskAbove(t);
        if (t.kind === 'unmarked') this.markNotes([t], t.text);
        else this.dismiss([t]);
        return { ok: true, message: parent ? `Marked as a note, attached to: ${parent.text}` : `Marked as a note: ${t.text}`, undo: true };
      }
      case 'listToggle':
        return this.listToggle(t, list);
      case 'listSet':
        return this.listSet(t, value);
      case 'todoList':
        return this.todoList(t, value);
      case 'listMove':
        return this.listMove(t, value, list);
      case 'open':
        this.opener(t.file, t.line);
        return { ok: true, message: `Opening ${t.fileLabel}. The task is on line ${t.line}.` };
      case 'done':
      case 'toggleDone': {
        const reopen = t.flags.done && op === 'toggleDone';
        const res = done(this.lineWrite(t, reopen ? 'reopen' : 'done'), `${reopen ? 'Reopened' : 'Marked done'}: ${t.text}`);
        return reopen ? res : this.withStatusNote(t, res, value, 'Done', list);
      }
      case 'todo':
        if (t.kind === 'unmarked' && (this.stateData.dismissed[t.file] || []).includes(t.textHash) && (markerInfo(t.raw) || t.unmarkedMode === 'tasks')) {
          this.restoreTask(t);
          return { ok: true, message: `Back to a task: ${t.text}`, undo: true };
        }
        return done(this.lineWrite(t, 'todo'), `Marked as to-do: ${t.text}`);
      case 'due':
        return this.setDates(t, { due: value == null ? '' : value });
      case 'checkin':
        return this.setDates(t, { checkin: value == null ? '' : value });
      case 'dates':
        return this.setDates(t, value);
      case 'addNote':
        return this.addNote(t, value, list);
      case 'exclude':
        return this.exclude(t);
      case 'indent':
        return this.reindent(t, 'in');
      case 'outdent':
        return this.reindent(t, 'out');
      case 'listAdd':
        return this.listAdd(t, list);
      case 'today':
        return this.pickToday(t);
      case 'priority':
        return this.setPriority(t, value);
      case 'blockSet':
        return this.blockSet(t, value);
      case 'bucketSet':
      case 'goalSet':
        return this.bucketSet(t, value);
      case 'jira': {
        const key = value ? String(value).trim() : '';
        if (key && !KEY_RE.test(key)) throw new HttpError(400, 'Jira keys look like ABC-123');
        return done(this.lineWrite(t, 'jira', key || null), key ? `Linked to Jira ${key.toUpperCase()}: ${t.text}` : `Jira link removed: ${t.text}`);
      }
      default:
        if (FLAG_MESSAGES[op]) {
          const had = t.flags[op];
          const res = done(this.lineWrite(t, op), `${FLAG_MESSAGES[op][had ? 1 : 0]}: ${t.text}`);
          return had ? res : this.withStatusNote(t, res, value, FLAG_LABELS[op], list);
        }
        throw new HttpError(400, `Unknown action: ${op}`);
    }
  }

  /** Adds the optional note typed with a status key, so one undo reverses both writes. */
  withStatusNote(t, res, value, label, listId) {
    const text = value && typeof value.note === 'string' ? value.note.trim() : '';
    if (!text || !res.focusId) return res;
    const before = this.undoStack.length;
    try {
      const noted = this.addNote(this.task(res.focusId), { text: `${label}: ${text}` }, listId);
      const steps = this.undoStack.splice(before - 1);
      this.pushUndo({ type: 'multi', steps, text: t.text });
      return { ...res, message: `${res.message}. Note added`, focusId: noted.focusId || res.focusId };
    } catch (err) {
      if (this.undoStack.length === before && res.undo) this.undo();
      throw err;
    }
  }

  touchList() {
    this.lastWriteAt = Date.now();
    this.index.emit('change', this.index.rev);
  }

  snapshot() {
    return { lists: JSON.parse(JSON.stringify(this.stateData.lists)), lastList: this.stateData.lastList };
  }

  /** Applies a change to the lists, saves it, and records one undo step. */
  mutateLists(fn, text, id, { silent = false } = {}) {
    const before = this.snapshot();
    fn(this.stateData.lists);
    this.saveState();
    const entry = { type: 'lists', before, id, text };
    if (!silent) this.pushUndo(entry);
    this.touchList();
    return entry;
  }

  getList(listId) {
    const l = this.stateData.lists.find((x) => x.id === (listId || this.stateData.lastList));
    if (!l) throw new HttpError(404, 'That list no longer exists.', 'gone');
    return l;
  }

  cleanName(name, exceptId) {
    const n = String(name || '').replace(/\s+/g, ' ').trim();
    if (!n) throw new HttpError(400, 'Enter a name for the list.');
    if (n.length > 60) throw new HttpError(400, 'List names can be at most 60 characters.');
    if (this.stateData.lists.some((l) => l.id !== exceptId && l.name.toLowerCase() === n.toLowerCase())) throw new HttpError(400, `A list called "${n}" already exists.`);
    return n;
  }

  newListId() {
    const taken = new Set(this.stateData.lists.map((l) => l.id));
    let id;
    do id = `l${Math.random().toString(36).slice(2, 8)}`;
    while (taken.has(id));
    return id;
  }

  openCount(listId) {
    return listTasks(this.index, this.stateData, listId).filter((x) => !x.flags.done).length;
  }

  requireTask(t) {
    if (t.kind !== 'task') throw new HttpError(400, 'Only tasks can go on a list. Mark this line as a to-do first.');
  }

  listToggle(t, listId) {
    const target = this.getList(listId);
    // A task that was on the list before the list kept its tasks in a file is added and removed as usual.
    if (fileBacked(target) && !target.keys.includes(t.listKey)) {
      if (t.kind === 'task' && t.file === target.file) {
        throw new HttpError(400, `${t.text} is kept in the file for ${target.name}. To take it off, move it to another list that has a file, or press Delete to exclude it.`);
      }
      return this.moveToListFile(t, target);
    }
    const had = target.keys.includes(t.listKey);
    if (!had) this.requireTask(t);
    this.mutateLists((lists) => {
      const l = lists.find((x) => x.id === target.id);
      if (had) l.keys = l.keys.filter((k) => k !== t.listKey);
      else l.keys.push(t.listKey);
      this.stateData.lastList = target.id;
    }, t.text, t.id);
    const n = this.openCount(target.id);
    return { ok: true, message: had ? `Removed from ${target.name}: ${t.text}` : `Added to ${target.name}, position ${n} of ${n}: ${t.text}`, undo: true, focusId: t.id };
  }

  /** Sets exactly which lists a task is on; optionally creates a new list first. */
  listSet(t, value) {
    this.requireTask(t);
    const wanted = new Set(Array.isArray(value && value.ids) ? value.ids : []);
    const newName = value && value.newName && String(value.newName).trim() ? this.cleanName(value.newName) : null;
    for (const id of wanted) this.getList(id);
    const fileLists = [...wanted].map((id) => this.getList(id)).filter((l) => fileBacked(l) && l.file !== t.file && !l.keys.includes(t.listKey));
    const files = new Set(fileLists.map((l) => l.file));
    if (files.size > 1) throw new HttpError(400, `A task can only be kept in one file. Choose just one of ${fileLists.map((l) => l.name).join(', ')}.`);
    const home = this.fileListsOf(t);
    if (home.length && !home.some((l) => wanted.has(l.id)) && !files.size) {
      throw new HttpError(400, `${t.text} is kept in the file for ${home[0].name}, so it stays on that list. To move it, tick another list that has a file.`);
    }
    // Lists that keep their tasks in a file show everything in it, so they never store keys.
    for (const l of this.stateData.lists) if (fileBacked(l) && l.file === t.file) wanted.delete(l.id);
    if (files.size) {
      // Ticking a list that keeps its tasks in another file moves the task there, then sets the other lists.
      const before = this.undoStack.length;
      const moved = this.moveToListFile(t, fileLists[0]);
      const others = [...wanted].some((id) => id !== fileLists[0].id) || newName;
      try {
        const res = this.listSet(this.task(moved.focusId), { ...value, ids: [...wanted] });
        const steps = this.undoStack.splice(before);
        this.pushUndo({ type: 'multi', steps, text: t.text });
        return { ...res, message: moved.message.replace(/\. Press u to undo$/, '') + (others ? `. ${res.message}` : '') + '. Press u to undo' };
      } catch (err) {
        while (this.undoStack.length > before) this.undo();
        throw err;
      }
    }
    let createdId = null;
    this.mutateLists((lists) => {
      if (newName) {
        createdId = this.newListId();
        lists.push({ id: createdId, name: newName, keys: [], folder: '', file: '', sort: 'manual' });
        wanted.add(createdId);
      }
      for (const l of lists) {
        if (fileBacked(l) && l.file === t.file) continue;
        const has = l.keys.includes(t.listKey);
        if (wanted.has(l.id) && !has) l.keys.push(t.listKey);
        else if (!wanted.has(l.id) && has) l.keys = l.keys.filter((k) => k !== t.listKey);
      }
      const last = createdId || [...wanted].pop();
      if (last) this.stateData.lastList = last;
    }, t.text, t.id);
    const names = this.stateData.lists.filter((l) => wanted.has(l.id) || (fileBacked(l) && l.file === t.file)).map((l) => l.name);
    return { ok: true, message: names.length ? `${t.text} is on ${names.join(' and ')}` : `${t.text} is on no lists`, undo: true, focusId: t.id, listId: createdId };
  }

  /** Triage: marks an unmarked line as a to-do and puts it on the chosen lists, as one undoable step. */
  todoList(t, value) {
    if (t.kind !== 'unmarked') return this.listSet(t, value);
    for (const id of Array.isArray(value && value.ids) ? value.ids : []) this.getList(id);
    const before = this.undoStack.length;
    let id;
    if ((this.stateData.dismissed[t.file] || []).includes(t.textHash) && (markerInfo(t.raw) || t.unmarkedMode === 'tasks')) {
      this.restoreTask(t);
      id = this.idAt(t.file, t.lineIndex);
    } else {
      const r = this.lineWrite(t, 'todo');
      if (!r) throw new HttpError(400, `Could not mark as to-do: ${t.text}`);
      id = r.focusId;
    }
    try {
      const res = this.listSet(this.task(id), value);
      const steps = this.undoStack.splice(before);
      this.pushUndo({ type: 'multi', steps, text: t.text });
      return { ...res, message: `Marked as to-do. ${res.message}` };
    } catch (err) {
      if (this.undoStack.length === before + 1) this.undo();
      throw err;
    }
  }

  listMove(t, how, listId) {
    const target = this.getList(listId);
    if (target.sort !== 'manual') throw new HttpError(400, `${target.name} is sorted automatically. Press Shift+O and choose manual order to move things by hand.`);
    if (fileBacked(target)) return this.fileListMove(t, how, target);
    const open = listTasks(this.index, this.stateData, target.id).filter((x) => !x.flags.done);
    const cur = open.findIndex((x) => x.listKey === t.listKey);
    if (cur < 0) throw new HttpError(400, `That task is not on ${target.name}. Press l to add it.`);
    const last = open.length - 1;
    const to = { up: cur - 1, down: cur + 1, top: 0, bottom: last }[how];
    if (to === undefined) throw new HttpError(400, 'Move up, down, top or bottom');
    if (to < 0 || to > last || to === cur) {
      return { ok: true, message: `Already ${to < cur ? 'first' : 'last'} on ${target.name}: ${t.text}`, focusId: t.id };
    }
    this.mutateLists((lists) => {
      const l = lists.find((x) => x.id === target.id);
      const next = l.keys.filter((k) => k !== t.listKey);
      const anchor = next.indexOf(open[to].listKey);
      next.splice(to < cur ? anchor : anchor + 1, 0, t.listKey);
      l.keys = next;
    }, t.text, t.id);
    return { ok: true, message: `Moved ${to < cur ? 'up' : 'down'} to position ${to + 1} of ${open.length}: ${t.text}`, undo: true, focusId: t.id };
  }

  listManage(op, listId, value) {
    if (op === 'listCreate') {
      const v = value && typeof value === 'object' ? value : { name: value };
      const name = this.cleanName(v.name);
      const folder = this.cleanFolder(v.folder);
      const id = this.newListId();
      const entry = { id, name, keys: [], folder, file: '', sort: 'manual' };
      if (v.notesFolder) entry.file = this.makeListFile(entry, v.notesFolder);
      else if (v.file) entry.file = this.cleanListFile(v.file);
      if (v.fileTasks) {
        if (!entry.file) throw new HttpError(400, 'Choose a file for the list to keep its tasks in.');
        entry.fileTasks = true;
      }
      if (v.notActionable === true) entry.notActionable = true;
      Object.assign(entry, this.cleanJiraListSettings(v, entry));
      this.mutateLists((lists) => lists.push(entry), name);
      const f = entry.file ? this.fileEntry(entry.file) : null;
      return { ok: true, message: `Created list ${name}${f ? ` with notes file ${f.label}` : ''}`, undo: true, listId: id };
    }
    const target = this.getList(listId);
    if (op === 'listRename') {
      const name = this.cleanName(value, target.id);
      this.mutateLists((lists) => { lists.find((l) => l.id === target.id).name = name; }, name);
      return { ok: true, message: `Renamed ${target.name} to ${name}`, undo: true };
    }
    if (target.id === DEFAULT_LIST) throw new HttpError(400, 'My list is the default list and cannot be deleted. You can rename it.');
    this.mutateLists((lists) => {
      lists.splice(lists.findIndex((l) => l.id === target.id), 1);
      if (this.stateData.lastList === target.id) this.stateData.lastList = DEFAULT_LIST;
    }, target.name);
    return { ok: true, message: `Deleted list ${target.name}. Your text files were not changed.`, undo: true };
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) throw new HttpError(400, 'Nothing to undo');
    return this.undoEntry(e);
  }

  undoEntry(e) {
    if (e.type === 'multi') {
      let last = { ok: true, message: `Undid: ${e.text}` };
      for (const step of [...e.steps].reverse()) last = this.undoEntry(step);
      return { ...last, message: `Undid: ${e.text}` };
    }
    if (e.type === 'rewrite') return this.undoRewrite(e);
    if (e.type === 'insert') {
      try {
        removeLines(e.file, { lineIndex: e.lineIndex, expected: e.lines });
      } catch (err) {
        this.index.refresh(this.now());
        if (err instanceof ConflictError) throw new HttpError(409, 'Cannot undo: those lines have changed since. Nothing was written.', 'conflict');
        throw new HttpError(500, err.message);
      }
      this.lastWriteAt = Date.now();
      this.index.refresh(this.now());
      return { ok: true, message: `Removed: ${e.text}` };
    }
    if (e.type === 'move') {
      try {
        moveLine(e.file, { from: e.to, expected: e.after, toIndex: e.from, replacement: e.before });
      } catch (err) {
        this.index.refresh(this.now());
        if (err instanceof ConflictError) throw new HttpError(409, 'Cannot undo: those lines have changed since. Nothing was written.', 'conflict');
        throw new HttpError(500, err.message);
      }
      this.lastWriteAt = Date.now();
      this.index.refresh(this.now());
      return { ok: true, message: `Undid move: ${e.text}`, focusId: this.idAt(e.file, e.from) };
    }
    if (e.type === 'lines') {
      try {
        replaceLines(e.file, e.changes.map((c) => ({ lineIndex: c.lineIndex, expected: c.after, replacement: c.before })));
      } catch (err) {
        this.index.refresh(this.now());
        if (err instanceof ConflictError) throw new HttpError(409, 'Cannot undo: those lines have changed since. Nothing was written.', 'conflict');
        throw new HttpError(500, err.message);
      }
      this.lastWriteAt = Date.now();
      this.index.refresh(this.now());
      return { ok: true, message: `Undid change: ${e.text}`, focusId: this.idAt(e.file, e.changes[0].lineIndex) };
    }
    if (e.type === 'lists') {
      this.stateData.lists = e.before.lists;
      this.stateData.lastList = e.before.lastList;
      this.saveState();
      this.touchList();
      return { ok: true, message: `Undid list change: ${e.text}`, focusId: e.id && this.index.get(e.id) ? e.id : null };
    }
    if (e.type === 'reviewed') {
      if (e.prev === undefined) delete this.stateData.reviewed[e.file];
      else this.stateData.reviewed[e.file] = e.prev;
      this.saveState();
      this.touchList();
      return { ok: true, message: 'Undid mark as reviewed' };
    }
    if (e.type === 'restore') {
      (this.stateData.dismissed[e.file] = this.stateData.dismissed[e.file] || []).push(e.hash);
      if (e.parentKey) (this.stateData.noteOf[e.file] = this.stateData.noteOf[e.file] || {})[e.hash] = e.parentKey;
      this.saveState();
      this.index.refresh(this.now());
      this.index.emit('change', this.index.rev);
      return { ok: true, message: 'Undid restore as task' };
    }
    if (e.type === 'dismiss') {
      for (const { file, hash } of e.items) {
        this.stateData.dismissed[file] = (this.stateData.dismissed[file] || []).filter((h) => h !== hash);
        if (this.stateData.noteOf[file]) delete this.stateData.noteOf[file][hash];
        delete this.stateData.reviewed[file];
      }
      this.saveState();
      this.index.refresh(this.now());
      this.index.emit('change', this.index.rev);
      return { ok: true, message: 'Undid mark as note' };
    }
    try {
      replaceLine(e.file, { lineIndex: e.lineIndex, expected: e.after, replacement: e.before });
    } catch (err) {
      this.index.refresh(this.now());
      if (err instanceof ConflictError) throw new HttpError(409, 'Cannot undo: that line has changed since. Nothing was written.', 'conflict');
      throw new HttpError(500, err.message);
    }
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    return { ok: true, message: `Undid change: ${e.text}`, focusId: this.idAt(e.file, e.lineIndex) };
  }

  // ---- folders ----

  publicConfig() {
    const j = this.config.jira;
    return {
      folders: this.config.folders,
      masterFile: this.config.masterFile,
      masterLabel: this.config.masterFile ? this.masterLabel() : null,
      files: this.index.files.map((f) => ({ file: f.file, label: f.label })),
      jira: j ? { baseUrl: j.baseUrl, type: j.type, email: j.email || '', project: j.project || '', issueType: j.issueType || 'Task', hasToken: !!this.secrets.getJiraToken(), sync: cleanSync(j.sync || {}) } : null,
      today: toISO(this.now()),
    };
  }

  setFolders(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'folders must be a list');
    let folders;
    try {
      folders = list.map((f) => cfgMod.normalizeFolder(f));
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const seen = new Set();
    for (const f of folders) {
      if (seen.has(f.path)) throw new HttpError(400, `Folder listed twice: ${f.path}`);
      seen.add(f.path);
    }
    this.config = { ...this.config, folders };
    cfgMod.saveConfig(this.dir, this.config);
    this.index.refresh(this.now());
    if (this.index.watchers.length || this.index.poll) this.index.watch();
    return this.publicConfig();
  }

  browse(p) {
    const abs = path.resolve(cfgMod.expandHome(p || '~'));
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      throw new HttpError(400, `Cannot open folder: ${abs}`);
    }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const fileNames = entries.filter((e) => e.isFile() && !e.name.startsWith('.') && TEXT_EXT.has(path.extname(e.name).toLowerCase())).map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const textFiles = fileNames.length;
    const rtfFiles = entries.filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.rtf').length;
    const parent = path.dirname(abs) === abs ? null : path.dirname(abs);
    return { path: abs, parent, dirs, files: fileNames, textFiles, rtfFiles, home: os.homedir() };
  }

  folderTree(i) {
    const folder = this.config.folders[i];
    if (!folder) throw new HttpError(404, 'Unknown folder');
    const entries = [];
    walk(folder, (e) => {
      if (entries.length >= 3000) return;
      const isText = e.type === 'file' && (TEXT_EXT.has(e.ext) || e.ext === '.rtf');
      if (e.type === 'file' && !isText) return;
      entries.push({
        rel: e.rel,
        type: e.type,
        depth: e.rel.split('/').length - 1,
        name: path.posix.basename(e.rel),
        excluded: folder.excluded.includes(e.rel),
        inheritedExcluded: isExcluded(e.rel, folder.excluded) && !folder.excluded.includes(e.rel),
        override: folder.overrides[e.rel] || '',
        effectiveMode: modeFor(folder, e.rel),
        rtf: e.ext === '.rtf',
      });
    });
    return { path: folder.path, unmarked: folder.unmarked, entries };
  }

  // ---- rtf ----

  rtfScan(i) {
    const folder = this.config.folders[i];
    if (!folder) throw new HttpError(404, 'Unknown folder');
    return { folder: folder.path, files: this.index.rtf.filter((r) => r.folderIndex === i).map((r) => r.rel) };
  }

  rtfConvert(i, rels, confirm) {
    const folder = this.config.folders[i];
    if (!folder) throw new HttpError(404, 'Unknown folder');
    if (confirm !== true) throw new HttpError(400, 'Conversion needs explicit confirmation');
    const allowed = new Set(this.index.rtf.filter((r) => r.folderIndex === i).map((r) => r.rel));
    const wanted = (rels || []).filter((r) => allowed.has(r));
    if (!wanted.length) throw new HttpError(400, 'No matching .rtf files to convert');
    const results = convertRtfFiles({ folderPath: folder.path, rels: wanted, exec: this.rtfExec, trashDir: this.trashDir });
    this.index.refresh(this.now());
    return { results };
  }

  // ---- jira ----

  jiraClientOrNull() {
    try {
      return this.jiraClient();
    } catch {
      return null;
    }
  }

  jiraClient() {
    const j = this.config.jira;
    if (!j) throw new HttpError(400, 'Jira is not set up. Open Settings to add it.', 'jira-unconfigured');
    try {
      return new JiraClient({ baseUrl: j.baseUrl, type: j.type, email: j.email, token: this.secrets.getJiraToken(), fetch: this.fetch });
    } catch (err) {
      throw new HttpError(400, err.message, 'jira-unconfigured');
    }
  }

  setJira(body) {
    if (body.remove) {
      this.config = { ...this.config, jira: null };
      cfgMod.saveConfig(this.dir, this.config);
      this.secrets.clearJiraToken();
      return this.publicConfig();
    }
    const { baseUrl, type, email = '', project = '', issueType = 'Task', token } = body;
    try {
      const { normalizeBaseUrl } = require('./jira');
      const url = normalizeBaseUrl(baseUrl);
      if (type !== 'cloud' && type !== 'datacenter') throw new JiraError('Choose Jira Cloud or Data Center');
      if (type === 'cloud' && !String(email).trim()) throw new JiraError('Jira Cloud needs the account email');
      const prev = this.config.jira || {};
      const sync = body.sync !== undefined ? this.cleanJiraSync(body.sync, prev.sync) : prev.sync;
      this.config = { ...this.config, jira: { baseUrl: url, type, email: String(email).trim(), project: String(project).trim(), issueType: String(issueType).trim() || 'Task', ...(sync ? { sync } : {}) } };
      if (token) this.secrets.setJiraToken(String(token));
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    cfgMod.saveConfig(this.dir, this.config);
    return this.publicConfig();
  }

  async jiraIssue(key) {
    try {
      return await this.jiraClient().getIssue(key);
    } catch (err) {
      if (err instanceof JiraError) throw new HttpError(502, err.message);
      throw err;
    }
  }

  async jiraCreate({ id, project, issueType }) {
    const t = this.task(id);
    const j = this.config.jira || {};
    const client = this.jiraClient();
    let issue;
    try {
      issue = await client.createIssue({
        project: project || j.project,
        issueType: issueType || j.issueType || 'Task',
        summary: t.text,
        description: t.notes.join('\n'),
      });
    } catch (err) {
      if (err instanceof JiraError) throw new HttpError(502, err.message);
      throw err;
    }
    // Re-resolve the task: the index may have refreshed while the request was in flight.
    const fresh = this.index.get(id) || t;
    let linked;
    try {
      linked = this.lineWrite(fresh, 'jira', issue.key);
    } catch (err) {
      throw new HttpError(err.status || 500, `Created Jira ${issue.key} (${issue.url}) but could not write the link into the file: ${err.message}`, err.code);
    }
    return { ok: true, message: `Created Jira ${issue.key} and linked it: ${t.text}`, key: issue.key, url: issue.url, undo: true, focusId: linked && linked.focusId };
  }
}

require('./features').install(App, HttpError);
require('./filelists').install(App, HttpError);
require('./buckets').install(App, HttpError);
require('./blocks').install(App, HttpError);
require('./jirasync').install(App, HttpError);

module.exports = { App, HttpError };
