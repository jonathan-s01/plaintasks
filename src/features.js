'use strict';

// Notes on tasks, subtasks, adding tasks, list sorting, list folders and notes files, dates and times.
// Installed onto App.prototype by app.js.

const fs = require('node:fs');
const path = require('node:path');
const cfgMod = require('./config');
const { applyOp, OpError } = require('./ops');
const { parseText, markerInfo } = require('./parser');
const { insertLinesAfter, appendLines, replaceLines, moveLine, createTextFile, ConflictError } = require('./writer');
const { parseWhen, parseFriendly, formatDate, formatTime, toISO } = require('./dates');
const { modeFor, TEXT_EXT } = require('./indexer');
const { matcher, fileBacked, heldBack } = require('./views');

const own = (s) => /^[ \t]*/.exec(s)[0];
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function install(App, HttpError) {
  const proto = App.prototype;

  // ---- shared helpers ----

  proto.pushUndo = function pushUndo(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 100) this.undoStack.shift();
  };

  proto.parsedFor = function parsedFor(file) {
    const entry = this.index.cache.get(file);
    if (!entry || !entry.parsed) throw new HttpError(404, 'That file is no longer available. The list has been refreshed.', 'gone');
    return entry.parsed;
  };

  proto.fileEntry = function fileEntry(file) {
    return this.index.files.find((f) => f.file === file) || null;
  };

  /** The watched folder that contains `abs`, with the path relative to it, or null. */
  proto.watchedFolderFor = function watchedFolderFor(abs) {
    for (const folder of this.config.folders) {
      const root = path.resolve(folder.path);
      if (abs === root || abs.startsWith(root + path.sep)) return { folder, rel: path.relative(root, abs).split(path.sep).join('/') };
    }
    return null;
  };

  /** Re-parses what a file would look like after a change, so a change that would not behave as promised is refused. */
  function simulate(lines, mode, today) {
    return parseText(lines.join('\n'), { unmarked: mode, today });
  }

  proto.writeFailed = function writeFailed(err, what) {
    this.index.refresh(this.now());
    if (err instanceof ConflictError) throw new HttpError(409, err.message, 'conflict');
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `Could not ${what}: ${err.message}`);
  };

  // ---- notes on tasks ----

  proto.addNote = function addNote(t, value, listId) {
    if (t.kind !== 'task') throw new HttpError(400, 'Notes can only be added to tasks.');
    // value.amp writes "& note" where plain notes cannot exist, so the note still attaches to the task above it.
    const amp = t.unmarkedMode === 'tasks' && !!(value && value.amp);
    if (t.unmarkedMode === 'tasks' && !amp) throw new HttpError(400, 'In this file every plain line is a task, so a note could not be told apart. Change the folder or file to treat plain lines as notes first.');
    const text = clean(value && value.text);
    if (!text) throw new HttpError(400, 'Type the note first.');
    if (markerInfo(text)) throw new HttpError(400, 'A note cannot start with a task symbol. Add a word before it.');
    const list = listId ? this.stateData.lists.find((l) => l.id === listId) : null;
    const stamp = !value || value.stamp !== false;
    const line = stamp ? `[${toISO(this.now())}${list ? `, ${list.name}` : ''}] ${text}` : text;

    const parsed = this.parsedFor(t.file);
    const item = parsed.items.find((i) => i.lineIndex === t.lineIndex);
    if (!item) throw new HttpError(404, 'That task is no longer in the file. The list has been refreshed.', 'gone');
    const own_ = item.notes.filter((n) => !n.amp);
    const lastNote = own_.length ? own_[own_.length - 1] : null;
    const afterIndex = lastNote ? lastNote.lineIndex : item.lineIndex;
    const taskIndent = own(item.raw);
    const indent = lastNote ? own(parsed.lines[lastNote.lineIndex]) : taskIndent + (taskIndent.includes('\t') ? '\t' : '  ');
    const newLine = indent + (amp ? `& ${line}` : line);

    const lines = [...parsed.lines];
    lines.splice(afterIndex + 1, 0, newLine);
    const after = simulate(lines, t.unmarkedMode, this.now());
    const again = after.items.find((i) => i.lineIndex === item.lineIndex);
    if (!again || !again.notes.some((n) => n.lineIndex === afterIndex + 1)) {
      throw new HttpError(400, 'That text would not stay attached to the task as a note. Try rewording it, for example without a colon at the end.');
    }

    let res;
    try {
      res = insertLinesAfter(t.file, { afterIndex, expected: parsed.lines[afterIndex], newLines: [newLine] });
    } catch (err) {
      this.writeFailed(err, 'write the note');
    }
    this.pushUndo({ type: 'insert', file: t.file, lineIndex: res.lineIndex, lines: [newLine], text: text });
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    return { ok: true, message: `Note added to: ${t.text}`, undo: true, focusId: this.idAt(t.file, t.lineIndex) };
  };

  /** Renames a task and/or rewrites its notes in the file. value: { text, notes: [one string per note line in the file] }. */
  proto.editTask = function editTask(t, value) {
    if (t.kind !== 'task') throw new HttpError(400, 'Only tasks can be renamed.');
    const parsed = this.parsedFor(t.file);
    const item = parsed.items.find((i) => i.lineIndex === t.lineIndex);
    if (!item) throw new HttpError(404, 'That task is no longer in the file. The list has been refreshed.', 'gone');
    const changes = [];
    const wantText = value && typeof value.text === 'string' ? clean(value.text) : t.text;
    if (!wantText) throw new HttpError(400, 'The task name cannot be empty.');
    if (wantText !== t.text) {
      let next;
      try {
        next = applyOp(t.raw, 'text', wantText, { symbols: t.symbols, unmarkedMode: t.unmarkedMode, today: this.now() });
      } catch (err) {
        if (err instanceof OpError) throw new HttpError(400, err.message);
        throw err;
      }
      if (next !== t.raw) changes.push({ lineIndex: t.lineIndex, expected: t.raw, replacement: next });
    }
    const noteCount = item.notes.length;
    const wantNotes = value && Array.isArray(value.notes) ? value.notes : null;
    let notesChanged = 0;
    if (wantNotes) {
      if (wantNotes.length !== noteCount) throw new HttpError(409, 'The notes changed in the file. The list has been refreshed. Open the task again.', 'conflict');
      item.notes.forEach((n, i) => {
        const text = clean(wantNotes[i]);
        if (!text) throw new HttpError(400, `Note ${i + 1} is empty. A note cannot be removed here; delete its line in the file with o.`);
        if (text === n.text) return;
        if (!n.amp && markerInfo(text)) throw new HttpError(400, `Note ${i + 1} cannot start with a task symbol. Add a word before it.`);
        const raw = parsed.lines[n.lineIndex];
        const replacement = n.amp ? raw.replace(/^([ \t]*&[ \t]+)[\s\S]*$/, (m, pre) => pre + text) : own(raw) + text;
        changes.push({ lineIndex: n.lineIndex, expected: raw, replacement });
        notesChanged += 1;
      });
    }
    if (!changes.length) return { ok: true, message: `No change: ${t.text}` };

    const lines = [...parsed.lines];
    for (const c of changes) lines[c.lineIndex] = c.replacement;
    const again = simulate(lines, t.unmarkedMode, this.now()).items.find((i) => i.lineIndex === item.lineIndex);
    const intact = again && again.kind === 'task' && again.notes.length === noteCount && again.notes.every((n, i) => n.lineIndex === item.notes[i].lineIndex);
    if (!intact) throw new HttpError(400, 'That text would not stay as it is in the file. Try rewording it, for example without a colon at the end or a leading symbol. Nothing was written.');

    try {
      replaceLines(t.file, changes);
    } catch (err) {
      this.writeFailed(err, 'save the changes');
    }
    this.pushUndo({ type: 'lines', file: t.file, changes: changes.map((c) => ({ lineIndex: c.lineIndex, before: c.expected, after: c.replacement })), text: t.text });
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    const bits = [];
    if (changes.some((c) => c.lineIndex === t.lineIndex)) bits.push(`Renamed to: ${wantText}`);
    if (notesChanged) bits.push(notesChanged === 1 ? 'Note updated' : `${notesChanged} notes updated`);
    return { ok: true, message: bits.join('. '), undo: true, focusId: this.idAt(t.file, t.lineIndex) };
  };

  // ---- delete ----

  /** Marks a line and everything nested under it with $. The text stays in the file; the app stops showing it. */
  proto.exclude = function exclude(t) {
    const parsed = this.parsedFor(t.file);
    const me = parsed.items.find((i) => i.lineIndex === t.lineIndex);
    if (!me) throw new HttpError(404, 'That line is no longer in the file. The list has been refreshed.', 'gone');
    const idxs = [];
    const walk = (it) => {
      idxs.push(it.lineIndex);
      for (const c of it.children) walk(parsed.items[c]);
    };
    walk(me);
    const changes = [];
    for (const idx of idxs) {
      const raw = parsed.lines[idx];
      let next;
      try {
        next = applyOp(raw, 'exclude', null, { symbols: t.symbols, unmarkedMode: t.unmarkedMode, today: this.now() });
      } catch (err) {
        if (err instanceof OpError) throw new HttpError(400, err.message);
        throw err;
      }
      if (next !== raw) changes.push({ lineIndex: idx, expected: raw, replacement: next });
    }
    if (!changes.length) return { ok: true, message: `No change: ${t.text}` };
    try {
      replaceLines(t.file, changes);
    } catch (err) {
      this.writeFailed(err, 'delete this');
    }
    this.pushUndo({ type: 'lines', file: t.file, changes: changes.map((c) => ({ lineIndex: c.lineIndex, before: c.expected, after: c.replacement })), text: t.text });
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    const subs = idxs.length - 1;
    return { ok: true, message: `Deleted: ${t.text}${subs ? ` and ${subs === 1 ? '1 subtask' : `${subs} subtasks`}` : ''}. The text stays in the file, marked with a dollar sign. Press u to undo`, undo: true };
  };

  // ---- subtasks ----

  proto.reindent = function reindent(t, dir) {
    const parsed = this.parsedFor(t.file);
    const me = parsed.items.find((i) => i.lineIndex === t.lineIndex);
    if (!me) throw new HttpError(404, 'That line is no longer in the file. The list has been refreshed.', 'gone');
    if (t.kind === 'unmarked' && (this.stateData.dismissed[t.file] || []).includes(t.textHash)) {
      throw new HttpError(400, 'This line was reviewed as a note. Press @ to make it a task first.');
    }
    const myIndent = own(me.raw);
    let newIndent;
    let expectParent;
    let prev = null;
    let clearSubtask = false;

    if (dir === 'in') {
      const rank = (i) => i.lineIndex;
      const sameLevel = me.kind === 'unmarked' ? parsed.items.filter((i) => i.kind === 'task' && rank(i) < rank(me)) : parsed.items.filter((i) => i.parent === me.parent && rank(i) < rank(me) && i.kind === 'task');
      prev = sameLevel.length ? sameLevel[sameLevel.length - 1] : null;
      if (!prev) throw new HttpError(400, 'There is no task above to make this a subtask of. A subtask goes under the task directly above it, with no blank line between.');
      const kid = prev.children.length ? parsed.items[prev.children[0]] : null;
      const unit = own(prev.raw).includes('\t') ? '\t' : '  ';
      newIndent = kid ? own(kid.raw) : own(prev.raw) + unit;
      expectParent = prev.lineIndex;
    } else {
      if (me.kind !== 'task') throw new HttpError(400, 'Only tasks can move up a level.');
      if (me.parent < 0) throw new HttpError(400, 'Already at the top level.');
      const p = parsed.items[me.parent];
      newIndent = own(p.raw);
      expectParent = p.parent >= 0 ? parsed.items[p.parent].lineIndex : -1;
      // A "•" subtask at its parent's indentation moves up a level by losing the "•".
      clearSubtask = me.flags.subtask && newIndent === myIndent;
    }

    const subtree = [];
    const walkItem = (it) => {
      subtree.push(it.lineIndex, ...it.notes.filter((n) => !n.amp).map((n) => n.lineIndex));
      for (const c of it.children) walkItem(parsed.items[c]);
    };
    walkItem(me);

    const lines = [...parsed.lines];
    const changes = [];
    for (const idx of subtree) {
      let raw = parsed.lines[idx];
      if (idx === me.lineIndex && me.kind === 'unmarked') {
        try {
          raw = applyOp(raw, 'todo', null, { symbols: t.symbols, unmarkedMode: t.unmarkedMode, today: this.now() });
        } catch (err) {
          if (err instanceof OpError) throw new HttpError(400, err.message);
          throw err;
        }
      }
      if (idx === me.lineIndex && clearSubtask) raw = applyOp(raw, 'clearSubtask', null, { symbols: t.symbols, unmarkedMode: t.unmarkedMode, today: this.now() });
      if (!raw.startsWith(myIndent)) throw new HttpError(400, 'The indentation here mixes tabs and spaces, so it cannot be changed safely. Fix it in the file first.');
      const next = newIndent + raw.slice(myIndent.length);
      lines[idx] = next;
      if (next !== parsed.lines[idx]) changes.push({ lineIndex: idx, expected: parsed.lines[idx], replacement: next });
    }
    if (!changes.length) return { ok: true, message: `No change: ${t.text}` };

    const after = simulate(lines, t.unmarkedMode, this.now());
    const moved = after.items.find((i) => i.lineIndex === me.lineIndex);
    const gotParent = moved && moved.parent >= 0 ? after.items[moved.parent].lineIndex : -1;
    if ((!moved || moved.kind !== 'task' || gotParent !== expectParent) && dir === 'in' && me.kind === 'unmarked') {
      return this.moveUnder(t, parsed, me, prev, newIndent, myIndent);
    }
    if (!moved || moved.kind !== 'task' || gotParent !== expectParent) {
      throw new HttpError(400, dir === 'in' ? 'That would not make it a subtask of the task above. Check there is no blank line between them.' : 'That would not move it up a level. Check the indentation in the file.');
    }
    const adopted = dir === 'out' ? moved.children.length - me.children.length : 0;

    try {
      replaceLines(t.file, changes);
    } catch (err) {
      this.writeFailed(err, 'change the indentation');
    }
    this.pushUndo({ type: 'lines', file: t.file, changes: changes.map((c) => ({ lineIndex: c.lineIndex, before: c.expected, after: c.replacement })), text: t.text });
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    const message =
      dir === 'in'
        ? `Now a subtask of ${prev.text}: ${t.text}`
        : `Moved up a level: ${t.text}${adopted > 0 ? `. The ${adopted === 1 ? 'task' : `${adopted} tasks`} right after it at the old level ${adopted === 1 ? 'is' : 'are'} now ${adopted === 1 ? 'its subtask' : 'its subtasks'}` : ''}`;
    return { ok: true, message, undo: true, focusId: this.idAt(t.file, t.lineIndex) };
  };

  /** A plain line with other lines between it and the task above: moves it to the end of that task's block as a subtask. */
  proto.moveUnder = function moveUnder(t, parsed, me, prev, newIndent, myIndent) {
    let end = prev.lineIndex;
    const walkItem = (it) => {
      end = Math.max(end, it.lineIndex, ...it.notes.filter((n) => !n.amp).map((n) => n.lineIndex));
      for (const c of it.children) walkItem(parsed.items[c]);
    };
    walkItem(prev);
    if (end >= me.lineIndex) throw new HttpError(400, 'That would not make it a subtask of the task above.');

    let raw;
    try {
      raw = applyOp(me.raw, 'todo', null, { symbols: t.symbols, unmarkedMode: t.unmarkedMode, today: this.now() });
    } catch (err) {
      if (err instanceof OpError) throw new HttpError(400, err.message);
      throw err;
    }
    if (!raw.startsWith(myIndent)) throw new HttpError(400, 'The indentation here mixes tabs and spaces, so it cannot be changed safely. Fix it in the file first.');
    const next = newIndent + raw.slice(myIndent.length);

    const lines = [...parsed.lines];
    lines.splice(me.lineIndex, 1);
    lines.splice(end + 1, 0, next);
    const after = simulate(lines, t.unmarkedMode, this.now());
    const moved = after.items.find((i) => i.lineIndex === end + 1);
    if (!moved || moved.kind !== 'task' || moved.parent < 0 || after.items[moved.parent].lineIndex !== prev.lineIndex) {
      throw new HttpError(400, 'That would not make it a subtask of the task above. Check the indentation in the file.');
    }

    try {
      moveLine(t.file, { from: me.lineIndex, expected: me.raw, toIndex: end + 1, replacement: next, anchorExpected: parsed.lines[end] });
    } catch (err) {
      this.writeFailed(err, 'move this line');
    }
    this.pushUndo({ type: 'move', file: t.file, from: me.lineIndex, to: end + 1, before: me.raw, after: next, text: t.text });
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    return { ok: true, message: `Moved under ${prev.text} as a subtask: ${t.text}. Press u to undo`, undo: true, focusId: this.idAt(t.file, end + 1) };
  };

  // ---- adding tasks ----

  proto.searchTasks = function searchTasks(q) {
    const query = clean(q);
    if (!query) return { results: [] };
    const match = matcher(query);
    const results = this.index.tasks
      .filter((t) => !t.flags.done && match(t))
      .slice(0, 20)
      .map((t) => ({ id: t.id, text: t.text, fileLabel: t.fileLabel, line: t.line, group: t.group }));
    return { results, masterFile: this.config.masterFile };
  };

  proto.masterLabel = function masterLabel() {
    const f = this.config.masterFile ? this.fileEntry(this.config.masterFile) : null;
    return f ? f.label : this.config.masterFile;
  };

  /** Chooses the file new tasks are saved to. `create` makes a new file: { folder, name }. */
  proto.setMaster = function setMaster(body) {
    let target;
    if (body && body.create) {
      const name = clean(body.create.name).replace(/[\\/:*?"<>|]/g, '-').replace(/\.(txt|md)$/i, '');
      if (!name) throw new HttpError(400, 'Enter a name for the file.');
      const dir = path.resolve(cfgMod.expandHome(String(body.create.folder || '')));
      target = path.join(dir, `${name}.txt`);
    } else {
      target = path.resolve(cfgMod.expandHome(String((body && body.path) || '')));
    }
    const where = this.watchedFolderFor(target);
    if (!where) throw new HttpError(400, 'That file is not inside one of your watched folders. Add its folder in Settings first, or choose a file inside one.');
    if (!TEXT_EXT.has(path.extname(target).toLowerCase())) throw new HttpError(400, 'Choose a .txt or .md file.');
    if (body && body.create) {
      try {
        createTextFile(target, []);
      } catch (err) {
        throw new HttpError(400, err.code === 'EEXIST' ? 'A file with that name already exists there. Choose it from the list instead.' : `Could not create the file: ${err.message}`);
      }
    } else if (!fs.existsSync(target)) {
      throw new HttpError(400, 'That file does not exist.');
    }
    this.config = { ...this.config, masterFile: target };
    cfgMod.saveConfig(this.dir, this.config);
    this.index.refresh(this.now());
    return { ...this.publicConfig(), ok: true, message: `New tasks will be saved to ${this.masterLabel()}` };
  };

  /** Appends a new task to the master file, and puts it on a list if one is given. */
  proto.newTask = function newTask(value, listId) {
    const text = clean(value && value.text);
    if (!text) throw new HttpError(400, 'Type the new task first.');
    if (markerInfo(text)) throw new HttpError(400, 'Type the task without a leading symbol. The app adds the to-do symbol for you.');
    const home = listId ? this.getList(listId) : null;
    // A list that keeps its tasks in a file gets new tasks at the end of that file.
    const master = fileBacked(home) ? home.file : this.config.masterFile;
    if (fileBacked(home) && !this.fileEntry(master)) {
      throw new HttpError(409, `The file for ${home.name} is missing or not in a watched folder. Choose another in Manage lists (press M).`, 'no-list-file');
    }
    if (!master || !fs.existsSync(master)) {
      throw new HttpError(409, master ? 'The file for new tasks is missing. Choose another.' : 'Choose which file new tasks are saved to.', 'no-master');
    }
    const parsed = this.parsedFor(master);
    const todoChar = Object.entries(parsed.symbols).find(([, v]) => v === 'todo');
    const line = `${todoChar ? todoChar[0] : '@'} ${text}`;
    let res;
    try {
      res = appendLines(master, [line]);
    } catch (err) {
      this.writeFailed(err, 'save the new task');
    }
    this.pushUndo({ type: 'insert', file: master, lineIndex: res.lineIndex, lines: [line], text });
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    const id = this.idAt(master, res.lineIndex);
    const fresh = id ? this.index.get(id) : null;
    let message = `Created task in ${fileBacked(home) ? this.fileEntry(master).label : this.masterLabel()}: ${text}`;
    if (fileBacked(home)) {
      if (fresh) this.stateData.created[fresh.listKey] = toISO(this.now());
      this.stateData.lastList = home.id;
      this.saveState();
      message = `Created task in ${home.name}, at the end of ${this.fileEntry(master).label}: ${text}`;
    } else if (fresh && listId) {
      const target = this.getList(listId);
      this.mutateLists((lists) => {
        const l = lists.find((x) => x.id === target.id);
        if (!l.keys.includes(fresh.listKey)) l.keys.push(fresh.listKey);
        this.stateData.created[fresh.listKey] = toISO(this.now());
        this.stateData.lastList = target.id;
      }, text, id);
      message += `. Added to ${target.name}`;
    }
    return { ok: true, message, undo: true, focusId: id };
  };

  proto.listAdd = function listAdd(t, listId) {
    this.requireTask(t);
    const target = this.getList(listId);
    if (fileBacked(target)) {
      if (t.file === target.file || target.keys.includes(t.listKey)) return { ok: true, message: `Already on ${target.name}: ${t.text}`, focusId: t.id };
      return this.moveToListFile(t, target);
    }
    if (target.keys.includes(t.listKey)) return { ok: true, message: `Already on ${target.name}: ${t.text}`, focusId: t.id };
    this.mutateLists((lists) => {
      lists.find((x) => x.id === target.id).keys.push(t.listKey);
      this.stateData.created[t.listKey] = toISO(this.now());
      this.stateData.lastList = target.id;
    }, t.text, t.id);
    return { ok: true, message: `Added to ${target.name}: ${t.text}`, undo: true, focusId: t.id };
  };

  /** Gives every list entry a created date the first time it is seen. */
  proto.stampCreated = function stampCreated() {
    const created = this.stateData.created;
    const day = toISO(this.now());
    let dirty = false;
    for (const l of this.stateData.lists) {
      for (const k of l.keys) {
        if (!created[k]) {
          created[k] = day;
          dirty = true;
        }
      }
    }
    if (dirty) this.saveState();
  };

  // ---- list sorting, folders and notes files ----

  proto.listSort = function listSort(listId, mode) {
    const target = this.getList(listId);
    if (!cfgMod.SORT_MODES.includes(mode)) throw new HttpError(400, `Sort by one of: ${cfgMod.SORT_MODES.join(', ')}.`);
    this.mutateLists((lists) => {
      lists.find((x) => x.id === target.id).sort = mode;
    }, target.name);
    const label = { manual: 'manual order', due: 'due date', checkin: 'check-in date', created: 'date added', type: 'type, notes last', name: 'name' }[mode];
    return { ok: true, message: `${target.name} is now sorted by ${label}`, undo: true };
  };

  proto.cleanFolder = function cleanFolder(v) {
    const f = clean(v);
    if (f.length > 60) throw new HttpError(400, 'Folder names can be at most 60 characters.');
    return f;
  };

  /** Creates a new notes file for a list inside a watched folder and returns its path. */
  proto.makeListFile = function makeListFile(list, folderInput) {
    const dir = path.resolve(cfgMod.expandHome(String(folderInput || '')));
    const where = this.watchedFolderFor(dir);
    if (!where) throw new HttpError(400, 'Choose a folder inside one of your watched folders, so the app can read the notes back.');
    const probe = where.rel ? `${where.rel}/x.txt` : 'x.txt';
    if (modeFor(where.folder, probe) === 'tasks') throw new HttpError(400, 'That folder treats every plain line as a task, so notes in it would become tasks. Choose another folder.');
    const base = clean(list.name).replace(/[\\/:*?"<>|]/g, '-') || 'List';
    let file = path.join(dir, `${base}.txt`);
    for (let n = 2; fs.existsSync(file); n += 1) file = path.join(dir, `${base} ${n}.txt`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      createTextFile(file, [list.name, `Created ${toISO(this.now())}`]);
    } catch (err) {
      throw new HttpError(500, `Could not create the notes file: ${err.message}`);
    }
    this.index.refresh(this.now());
    const dismissed = (this.stateData.dismissed[file] = this.stateData.dismissed[file] || []);
    for (const u of this.index.unmarked.filter((x) => x.file === file)) if (!dismissed.includes(u.textHash)) dismissed.push(u.textHash);
    this.saveState();
    this.index.refresh(this.now());
    return file;
  };

  proto.cleanListFile = function cleanListFile(file) {
    if (typeof file !== 'string' || !this.fileEntry(file)) throw new HttpError(400, 'That file is not one of your watched files.');
    return file;
  };

  /** Edits a list's folder, or gives it a notes file (an existing one, or a new one in `notesFolder`). */
  proto.listEdit = function listEdit(listId, value) {
    const target = this.getList(listId);
    const v = value || {};
    const folder = v.folder !== undefined ? this.cleanFolder(v.folder) : undefined;
    let file;
    if (v.notesFolder) file = this.makeListFile(target, v.notesFolder);
    else if (v.file) file = this.cleanListFile(v.file);
    const fileTasks = typeof v.fileTasks === 'boolean' ? v.fileTasks : undefined;
    if (fileTasks && !(file || target.file)) throw new HttpError(400, 'Choose a file for the list to keep its tasks in first.');
    const notActionable = typeof v.notActionable === 'boolean' ? v.notActionable : undefined;
    const jira = this.cleanJiraListSettings(v, { file: file || target.file });
    this.mutateLists((lists) => {
      const l = lists.find((x) => x.id === target.id);
      if (notActionable === true) l.notActionable = true;
      else if (notActionable === false) delete l.notActionable;
      if (folder !== undefined) l.folder = folder;
      if (file) l.file = file;
      if (fileTasks === true) l.fileTasks = true;
      else if (fileTasks === false) delete l.fileTasks;
      for (const [k, val] of Object.entries(jira)) {
        if (val === false || val === '' || (Array.isArray(val) && !val.length)) delete l[k];
        else l[k] = val;
      }
    }, target.name);
    const bits = [];
    const kept = fileBacked(this.getList(target.id));
    if (folder !== undefined) bits.push(folder ? `in folder ${folder}` : 'out of its folder');
    if (file) bits.push(`${kept ? 'tasks kept in' : 'notes file'} ${(this.fileEntry(file) || {}).label || file}`);
    if (fileTasks !== undefined) {
      bits.push(kept
        ? `shows every task in ${(this.fileEntry(this.getList(target.id).file) || {}).label}, and moving a task here moves its lines into that file`
        : 'shows only the tasks you add to it');
    }
    if (notActionable !== undefined) bits.push(notActionable ? 'not actionable: its tasks stay out of My Day and Next actions' : 'actionable: its tasks can show in My Day and Next actions');
    if (jira.jiraSync !== undefined) bits.push(jira.jiraSync ? 'syncs with Jira' : 'does not sync with Jira');
    if (jira.jiraLabels !== undefined) bits.push(jira.jiraLabels.length ? `Jira labels ${jira.jiraLabels.join(', ')}` : 'no extra Jira labels');
    if (jira.jiraStatus !== undefined) bits.push(jira.jiraStatus ? `open tasks go to Jira as ${jira.jiraStatus}` : 'open tasks use the usual Jira status');
    return { ok: true, message: `${target.name}: ${bits.join(', ') || 'no change'}${v.notesFolder ? '. Undo keeps the file on disk.' : ''}`, undo: true };
  };

  /** A note on a list that is not a task: written into the list's notes file. */
  proto.listNote = function listNote(value, listId) {
    const target = this.getList(listId);
    if (!target.file) throw new HttpError(409, `${target.name} has no notes file yet. Choose one in Manage lists (press M).`, 'no-list-file');
    const f = this.fileEntry(target.file);
    if (!f) throw new HttpError(409, `The notes file for ${target.name} is missing or not in a watched folder. Choose another in Manage lists (press M).`, 'no-list-file');
    if (f.unmarkedMode === 'tasks') throw new HttpError(400, 'That notes file treats plain lines as tasks, so a note could not be told apart.');
    const text = clean(value && value.text);
    if (!text) throw new HttpError(400, 'Type the note first.');
    if (markerInfo(text)) throw new HttpError(400, 'A note cannot start with a task symbol. Add a word before it.');
    const line = `[${toISO(this.now())}] ${text}`;
    const parsed = this.parsedFor(target.file);

    // A note straight after a task would attach to that task, so separate it with a blank line when needed.
    const tryAppend = (extra) => {
      const lines = parsed.lines[parsed.lines.length - 1] === '' ? parsed.lines.slice(0, -1) : [...parsed.lines];
      lines.push(...extra, line);
      const after = simulate([...lines, ''], f.unmarkedMode, this.now());
      return after.items.some((i) => i.kind === 'unmarked' && i.lineIndex === lines.length - 1);
    };
    const extra = tryAppend([]) ? [] : tryAppend(['']) ? [''] : null;
    if (!extra) throw new HttpError(400, 'That text would not stay a separate note. Try rewording it, for example without a colon at the end.');
    const newLines = [...extra, line];

    let res;
    try {
      res = appendLines(target.file, newLines);
    } catch (err) {
      this.writeFailed(err, 'write the note');
    }
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    const noteLine = res.lineIndex + extra.length;
    const u = this.index.unmarked.find((x) => x.file === target.file && x.lineIndex === noteLine);
    const insertEntry = { type: 'insert', file: target.file, lineIndex: res.lineIndex, lines: newLines, text };
    if (!u) {
      this.pushUndo(insertEntry);
      throw new HttpError(500, 'The note was written but could not be found again. Refresh the list.');
    }
    const dismissed = (this.stateData.dismissed[target.file] = this.stateData.dismissed[target.file] || []);
    if (!dismissed.includes(u.textHash)) dismissed.push(u.textHash);
    this.stateData.created[u.listKey] = toISO(this.now());
    const listEntry = this.mutateLists(
      (lists) => {
        lists.find((x) => x.id === target.id).keys.push(u.listKey);
        this.stateData.lastList = target.id;
      },
      text,
      u.id,
      { silent: true },
    );
    this.pushUndo({ type: 'multi', steps: [insertEntry, listEntry], text });
    this.index.emit('change', this.index.rev);
    return { ok: true, message: `Note added to ${target.name}`, undo: true, focusId: u.id };
  };

  // ---- dates and times ----

  /** Turns "fri 2pm" into the text written after `due:` or `checkin:`. Empty clears. */
  proto.whenArg = function whenArg(value, label) {
    const raw = clean(value);
    if (!raw) return { arg: null, text: null };
    const w = parseWhen(raw, this.now());
    if (!w) throw new HttpError(400, `Could not understand "${raw}" as a ${label}. Try fri, nov 20, +3d, 2026-11-20, or add a time such as fri 2pm.`, 'bad-date');
    return { arg: w.time ? `${w.iso} ${w.time}` : w.iso, text: `${formatDate(w.iso, this.now())}${w.time ? ` at ${formatTime(w.time)}` : ''}` };
  };

  /** Picks a task for My Day (today:), or takes it out again. A pick from an earlier day counts as picked until it is removed. */
  proto.pickToday = function pickToday(t) {
    if (t.kind !== 'task') throw new HttpError(400, 'Only tasks can be picked for My Day. Mark this line as a to-do first.');
    if (t.flags.done) throw new HttpError(400, 'That task is done, so it cannot be picked for My Day.');
    const today = this.now();
    const now = toISO(today);
    const unpick = !!t.picked && t.picked <= now;
    const r = this.lineWrite(t, 'today', unpick ? null : now);
    const why = unpick ? null : heldBack(this.stateData, { ...t, picked: now }, today);
    const message = unpick ? `Taken out of My Day: ${t.text}` : `Picked for today: ${t.text}${why ? `. It will not show in My Day while ${why}` : ''}`;
    return r ? { ok: true, message, undo: true, focusId: r.focusId } : { ok: true, message: `No change: ${t.text}` };
  };

  /** Sets the priority. value: 'high' | 'medium' | 'low', or undefined to cycle medium, high, low, medium. */
  proto.setPriority = function setPriority(t, value) {
    if (t.kind !== 'task') throw new HttpError(400, 'Only tasks have a priority. Mark this line as a to-do first.');
    const order = ['medium', 'high', 'low'];
    let next = value == null || value === '' ? order[(order.indexOf(t.priority) + 1) % 3] : String(value).toLowerCase();
    if (next === 'med' || next === 'normal') next = 'medium';
    if (!order.includes(next)) throw new HttpError(400, 'Priority is high, medium or low.');
    if (next === t.priority) return { ok: true, message: `No change. Priority ${next}: ${t.text}` };
    const r = this.lineWrite(t, 'priority', next);
    const label = next === 'medium' ? 'Priority medium (no token)' : `Priority ${next}`;
    return r ? { ok: true, message: `${label}: ${t.text}`, undo: true, focusId: r.focusId } : { ok: true, message: `No change: ${t.text}` };
  };

  proto.setDates = function setDates(t, value) {
    const v = value || {};
    const steps = [];
    const said = [];
    if (v.due !== undefined) {
      const d = this.whenArg(v.due, 'due date');
      steps.push(['due', d.arg]);
      said.push(d.text ? `due ${d.text}` : 'due date cleared');
    }
    if (v.checkin !== undefined) {
      const c = this.whenArg(v.checkin, 'check-in date');
      steps.push(['checkin', c.arg]);
      said.push(c.text ? `check in ${c.text}` : 'check-in date cleared');
    }
    if (!steps.length) throw new HttpError(400, 'Nothing to change.');
    const r = this.lineWrite(t, steps);
    return r ? { ok: true, message: `${said.join(', ')}: ${t.text}`, undo: true, focusId: r.focusId } : { ok: true, message: `No change: ${t.text}` };
  };
}

module.exports = { install };
