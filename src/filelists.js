'use strict';

// Lists that keep their tasks in a file: every task in the file is on the list, moving a task onto the list moves its
// lines (with notes and subtasks) into that file, and reordering the list reorders the file.
// Installed onto App.prototype by app.js.

const { applyOp, OpError } = require('./ops');
const { parseText, markerInfo } = require('./parser');
const { transformFile, restoreFile, appendInPlace, removeInPlace, ConflictError } = require('./writer');
const { fileBacked } = require('./views');

const own = (s) => /^[ \t]*/.exec(s)[0];
const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);
const CHANGED = 'The file changed since the list was shown. Nothing was written. The list has been refreshed.';

/** The task line, all its notes (including & notes) and all its subtasks, in file order. */
function blockOf(parsed, me) {
  const lines = new Set();
  const tasks = [];
  const walk = (it) => {
    lines.add(it.lineIndex);
    if (it.kind === 'task') tasks.push(it);
    for (const n of it.notes) lines.add(n.lineIndex);
    for (const c of it.children) walk(parsed.items[c]);
  };
  walk(me);
  return { indices: [...lines].sort((a, b) => a - b), tasks };
}

/** What the other tasks look like: text, parent and group. Used to refuse a change that would disturb them. */
function signature(parsed, skip, withGroup) {
  const parentText = (it) => (it.parent >= 0 ? parsed.items[it.parent].text : '');
  return parsed.items
    .filter((it) => it.kind === 'task' && !skip.has(it.lineIndex))
    .map((it) => `${it.text}\u0000${skip.has(parsed.items[it.parent] ? parsed.items[it.parent].lineIndex : -1) ? '' : parentText(it)}\u0000${withGroup ? it.group : ''}`)
    .sort();
}

function install(App, HttpError) {
  const proto = App.prototype;

  proto.simulateFile = function simulateFile(lines, mode) {
    return parseText(lines.join('\n'), { unmarked: mode, today: this.now() });
  };

  proto.fileWriteFailed = function fileWriteFailed(err, what) {
    this.index.refresh(this.now());
    if (err instanceof ConflictError) throw new HttpError(409, err.message, 'conflict');
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `Could not ${what}: ${err.message}`);
  };

  /** The file-backed lists whose file holds this task. */
  proto.fileListsOf = function fileListsOf(t) {
    return this.stateData.lists.filter((l) => fileBacked(l) && t.kind === 'task' && l.file === t.file);
  };

  /**
   * Moves a task with its notes and subtasks to the end of another list's file, as a top-level task.
   * Writes the new file first, then removes the lines from the old one; if that fails the new file is put back.
   */
  proto.moveToListFile = function moveToListFile(t, target) {
    this.requireTask(t);
    const dest = this.fileEntry(target.file);
    if (!dest) throw new HttpError(409, `The file for ${target.name} is missing or not in a watched folder. Choose another in Manage lists (press M).`, 'no-list-file');
    if (t.file === target.file) return { ok: true, message: `Already on ${target.name}: ${t.text}`, focusId: t.id };
    const src = this.parsedFor(t.file);
    const dst = this.parsedFor(target.file);
    const me = src.items.find((i) => i.lineIndex === t.lineIndex && i.kind === 'task');
    if (!me || src.lines[t.lineIndex] !== t.raw) throw new HttpError(409, CHANGED, 'conflict');

    const { indices, tasks } = blockOf(src, me);
    const inBlock = new Set(indices);
    const taskAt = new Map(tasks.map((x) => [x.lineIndex, x]));
    const plainNotes = new Set(tasks.flatMap((x) => x.notes.filter((n) => !n.amp).map((n) => n.lineIndex)));
    const headIndent = own(me.raw);
    const ctx = { symbols: t.symbols, unmarkedMode: dest.unmarkedMode, today: this.now() };
    let moved;
    try {
      moved = indices.map((i) => {
        let raw = src.lines[i];
        raw = raw.startsWith(headIndent) ? raw.slice(headIndent.length) : raw.replace(/^[ \t]+/, '');
        const task = taskAt.get(i);
        // At the top of the new file a "•" would make it a subtask of whatever is above it there.
        if (i === me.lineIndex) raw = applyOp(raw, 'clearSubtask', null, ctx);
        if (task && !markerInfo(raw) && dest.unmarkedMode !== 'tasks') raw = applyOp(raw, 'todo', null, ctx);
        // Where plain lines are tasks, a plain note keeps its meaning by starting with &.
        if (plainNotes.has(i) && dest.unmarkedMode === 'tasks') raw = `${own(raw)}& ${raw.trim()}`;
        return raw;
      });
    } catch (err) {
      if (err instanceof OpError) throw new HttpError(400, err.message);
      throw err;
    }

    // Choose the fewest blank lines that keep the new file's existing tasks as they were and the block intact.
    const base = dst.lines[dst.lines.length - 1] === '' ? dst.lines.slice(0, -1) : [...dst.lines];
    const dstBefore = signature(dst, new Set(), true);
    const openCount = tasks.filter((x) => !x.flags.excluded).length;
    let extra = null;
    for (const sep of [[], [''], ['', '']]) {
      const lines = [...base, ...sep, ...moved];
      const after = this.simulateFile([...lines, ''], dest.unmarkedMode);
      const head = after.items.find((i) => i.lineIndex === base.length + sep.length);
      const newSkip = new Set(moved.map((_, k) => base.length + sep.length + k));
      const blockTasks = after.items.filter((i) => i.kind === 'task' && newSkip.has(i.lineIndex)).length;
      if (head && head.kind === 'task' && head.parent < 0 && blockTasks === openCount && sameLines(signature(after, newSkip, true), dstBefore)) {
        extra = sep;
        break;
      }
    }
    if (!extra) throw new HttpError(400, `Could not add it to the end of ${dest.label} without changing the tasks already there. Nothing was written.`);

    const srcAfterLines = src.lines.filter((_, i) => !inBlock.has(i));
    const srcAfter = this.simulateFile(srcAfterLines, src.unmarkedMode);
    if (!sameLines(signature(srcAfter, new Set(), false), signature(src, inBlock, false))) {
      throw new HttpError(400, `Taking it out of ${t.fileLabel} would change other tasks there. Nothing was written. Move it in the file instead.`);
    }

    const oldTasks = this.index.tasks.filter((x) => x.file === t.file && inBlock.has(x.lineIndex));
    let wroteDest;
    let at;
    try {
      wroteDest = transformFile(target.file, (lines, eols) => {
        if (!sameLines(lines, dst.lines)) throw new ConflictError(CHANGED);
        at = appendInPlace(lines, eols, [...extra, ...moved]).lineIndex + extra.length;
      });
    } catch (err) {
      this.fileWriteFailed(err, `write to ${dest.label}`);
    }
    let wroteSrc;
    try {
      wroteSrc = transformFile(t.file, (lines, eols) => {
        if (!sameLines(lines, src.lines)) throw new ConflictError(CHANGED);
        removeInPlace(lines, eols, indices);
      });
    } catch (err) {
      try {
        restoreFile(target.file, { expect: wroteDest.after.lines, lines: wroteDest.before.lines, eols: wroteDest.before.eols });
      } catch {
        this.index.refresh(this.now());
        throw new HttpError(500, `Could not take it out of ${t.fileLabel}, and could not undo the copy in ${dest.label}. Check both files. ${err.message}`);
      }
      this.fileWriteFailed(err, `take it out of ${t.fileLabel}`);
    }
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());

    // Keep its place on other lists and its date added: those are stored by file, so they follow it to the new file.
    const remap = new Map();
    indices.forEach((oldLine, k) => {
      const old = oldTasks.find((x) => x.lineIndex === oldLine);
      const fresh = old && this.index.get(this.idAt(target.file, at + k));
      if (fresh && fresh.kind === 'task') remap.set(old.listKey, fresh.listKey);
    });
    for (const [a, b] of remap) if (this.stateData.created[a] && !this.stateData.created[b]) this.stateData.created[b] = this.stateData.created[a];
    const listsEntry = this.mutateLists(
      (lists) => {
        const now = new Set(remap.values());
        for (const l of lists) {
          l.keys = l.keys.map((k) => remap.get(k) || k);
          // The list that keeps them in its file shows them anyway.
          if (fileBacked(l) && l.file === target.file) l.keys = l.keys.filter((k) => !now.has(k));
        }
        this.stateData.lastList = target.id;
      },
      t.text,
      null,
      { silent: true },
    );
    const steps = [
      { type: 'rewrite', file: target.file, before: wroteDest.before, after: wroteDest.after, text: t.text },
      { type: 'rewrite', file: t.file, before: wroteSrc.before, after: wroteSrc.after, text: t.text },
      listsEntry,
    ];
    this.pushUndo({ type: 'multi', steps, text: t.text });
    const subs = openCount - 1;
    const from = this.stateData.lists.find((l) => fileBacked(l) && l.file === t.file);
    return {
      ok: true,
      message: `Moved to ${target.name}${from ? ` from ${from.name}` : ''}${subs ? `, with ${subs === 1 ? '1 subtask' : `${subs} subtasks`}` : ''}: ${t.text}. Press u to undo`,
      undo: true,
      focusId: this.idAt(target.file, at),
    };
  };

  /** Reorders a task among its open sibling tasks in a file-backed list, moving its lines in the file. */
  proto.fileListMove = function fileListMove(t, how, target) {
    if (t.kind !== 'task' || t.file !== target.file) throw new HttpError(400, `That task is not on ${target.name}. Press l to move it here.`);
    const parsed = this.parsedFor(t.file);
    const me = parsed.items.find((i) => i.lineIndex === t.lineIndex && i.kind === 'task');
    if (!me || parsed.lines[t.lineIndex] !== t.raw) throw new HttpError(409, CHANGED, 'conflict');
    const sibs = parsed.items.filter((i) => i.kind === 'task' && i.parent === me.parent && (!i.flags.done || i === me));
    const cur = sibs.indexOf(me);
    const last = sibs.length - 1;
    const to = { up: cur - 1, down: cur + 1, top: 0, bottom: last }[how];
    if (to === undefined) throw new HttpError(400, 'Move up, down, top or bottom');
    const parent = me.parent >= 0 ? parsed.items[me.parent] : null;
    const where = parent ? ` under ${parent.text}` : '';
    if (to < 0 || to > last || to === cur) return { ok: true, message: `Already ${to < cur ? 'first' : 'last'}${where}: ${t.text}`, focusId: t.id };

    const { indices } = blockOf(parsed, me);
    const inBlock = new Set(indices);
    const anchor = sibs[to];
    const anchorLine = to < cur ? anchor.lineIndex : Math.max(...blockOf(parsed, anchor).indices) + 1;
    const rest = parsed.lines.map((_, i) => i).filter((i) => !inBlock.has(i));
    let pos = rest.findIndex((i) => i >= anchorLine);
    if (pos < 0) pos = rest.length;
    // A file that ends with a line break keeps its empty last line last.
    if (pos === rest.length && parsed.lines[parsed.lines.length - 1] === '' && rest.length) pos = rest.length - 1;
    const order = [...rest.slice(0, pos), ...indices, ...rest.slice(pos)];
    const newLines = order.map((i) => parsed.lines[i]);
    const newHead = order.indexOf(me.lineIndex);

    const after = this.simulateFile(newLines, t.unmarkedMode);
    const moved = after.items.find((i) => i.lineIndex === newHead);
    const movedParent = moved && moved.parent >= 0 ? after.items[moved.parent].text : null;
    const lineMap = new Map(order.map((oldI, newI) => [oldI, newI]));
    const othersBefore = signature(parsed, inBlock, true);
    const othersAfter = signature(after, new Set(indices.map((i) => lineMap.get(i))), true);
    const unmarked = (p) => p.items.filter((i) => i.kind === 'unmarked').length;
    if (!moved || moved.kind !== 'task' || movedParent !== (parent ? parent.text : null) || !sameLines(othersBefore, othersAfter) || unmarked(after) !== unmarked(parsed)) {
      throw new HttpError(400, `Could not move it there without changing other tasks, for example across a blank line or a heading. Nothing was written. Move it in ${t.fileLabel} instead.`);
    }

    let res;
    try {
      res = transformFile(t.file, (lines) => {
        if (!sameLines(lines, parsed.lines)) throw new ConflictError(CHANGED);
        lines.splice(0, lines.length, ...newLines);
      });
    } catch (err) {
      this.fileWriteFailed(err, 'move the task');
    }
    this.pushUndo({ type: 'rewrite', file: t.file, before: res.before, after: res.after, text: t.text });
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    const dir = to < cur ? 'up' : 'down';
    return { ok: true, message: `Moved ${dir} to position ${to + 1} of ${sibs.length}${where}: ${t.text}`, undo: true, focusId: this.idAt(t.file, newHead) };
  };

  proto.undoRewrite = function undoRewrite(e) {
    try {
      restoreFile(e.file, { expect: e.after.lines, lines: e.before.lines, eols: e.before.eols });
    } catch (err) {
      this.index.refresh(this.now());
      if (err instanceof ConflictError) throw new HttpError(409, 'Cannot undo: that file has changed since. Nothing was written.', 'conflict');
      throw new HttpError(500, err.message);
    }
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    return { ok: true, message: `Undid move: ${e.text}` };
  };
}

module.exports = { install, blockOf };
