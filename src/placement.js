'use strict';

// Placing tasks anywhere in a file: a new task under a parent, or before or after another task, and moving a task (with
// its notes and subtasks) to such a place. Every change is checked by parsing the file as it would be, and refused if
// it would change any other task. Installed onto App.prototype by app.js.

const { applyOp, OpError } = require('./ops');
const { transformFile, ConflictError } = require('./writer');

const own = (s) => /^[ \t]*/.exec(s)[0];
const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);
const CHANGED = 'The file changed since the list was shown. Nothing was written. The list has been refreshed.';
const WHERE = ['parent', 'after', 'before'];

function blockLines(parsed, item) {
  const out = new Set();
  const walk = (it) => {
    out.add(it.lineIndex);
    for (const n of it.notes) out.add(n.lineIndex);
    for (const c of it.children) walk(parsed.items[c]);
  };
  walk(item);
  return [...out].sort((a, b) => a - b);
}

/** The other tasks: text, parent text, and whether they are done. Placing must leave this exactly as it was. */
function others(parsed, skip) {
  return parsed.items
    .filter((it) => it.kind === 'task' && !skip.has(it.lineIndex))
    .map((it) => `${it.text}\u0000${it.parent >= 0 && !skip.has(parsed.items[it.parent].lineIndex) ? parsed.items[it.parent].text : ''}\u0000${it.flags.done ? 1 : 0}`)
    .sort();
}

/** One level of indentation in this file: a tab unless the file indents with spaces. */
function unitOf(lines) {
  const first = lines.find((l) => /^[ \t]+\S/.test(l));
  return first && first[0] === ' ' ? '  ' : '\t';
}

/** Which placement the value asks for: { how, ref } or null. */
function placementOf(v) {
  const given = WHERE.filter((k) => v && v[k] != null && v[k] !== '');
  if (!given.length) return null;
  if (given.length > 1) throw new Error(`Give only one of ${WHERE.join(', ')}.`);
  return { how: given[0], ref: String(v[given[0]]) };
}

function install(App, HttpError) {
  const proto = App.prototype;

  /** Resolves a placement against the file: the line index to insert at, the indentation, and the parent's text. */
  proto.placeIn = function placeIn(parsed, anchor, how) {
    const item = parsed.items.find((i) => i.lineIndex === anchor.lineIndex && i.kind === 'task');
    if (!item || parsed.lines[anchor.lineIndex] !== anchor.raw) throw new HttpError(409, CHANGED, 'conflict');
    const unit = unitOf(parsed.lines);
    const end = (it) => Math.max(...blockLines(parsed, it));
    let at;
    let indent;
    let parent;
    if (how === 'parent') {
      const kid = item.children.map((c) => parsed.items[c]).find((c) => c.kind === 'task' && !c.flags.subtask);
      indent = kid ? own(kid.raw) : own(item.raw) + unit;
      at = end(item) + 1;
      parent = item;
    } else {
      parent = item.parent >= 0 ? parsed.items[item.parent] : null;
      // A "•" subtask sits at its parent's indentation; a sibling placed next to it is indented one level instead.
      indent = parent && item.flags.subtask ? own(parent.raw) + unit : own(item.raw);
      at = how === 'after' ? end(item) + 1 : item.lineIndex;
    }
    // A file that ends with a line break keeps its empty last line last.
    const last = parsed.lines.length - 1;
    if (at > last && parsed.lines[last] === '') at = last;
    return { at, indent, parent, item };
  };

  /** Inserts new task lines at a placement, in one checked write. Returns { lineIndex, undo }. */
  proto.insertPlaced = function insertPlaced(anchor, how, makeLines) {
    const parsed = this.parsedFor(anchor.file);
    const { at, indent, parent } = this.placeIn(parsed, anchor, how);
    const newLines = makeLines(indent);
    const lines = [...parsed.lines];
    lines.splice(at, 0, ...newLines);
    const after = this.simulateFile(lines, anchor.unmarkedMode);
    const head = after.items.find((i) => i.lineIndex === at);
    const skip = new Set(newLines.map((_, k) => at + k));
    const gotParent = head && head.parent >= 0 ? after.items[head.parent].text : null;
    if (!head || head.kind !== 'task' || gotParent !== (parent ? parent.text : null) || !sameLines(others(after, skip), others(parsed, new Set()))) {
      throw new HttpError(400, `Could not add it there without changing other tasks, for example across a blank line or a heading. Nothing was written. Add it in ${anchor.fileLabel} instead.`);
    }
    let res;
    try {
      res = transformFile(anchor.file, (ls, eols) => {
        if (!sameLines(ls, parsed.lines)) throw new ConflictError(CHANGED);
        const eol = eols.find(Boolean) || '\n';
        if (at >= ls.length) {
          eols[ls.length - 1] = eol;
          ls.push(...newLines);
          eols.push(...newLines.map((_, i) => (i === newLines.length - 1 ? '' : eol)));
        } else {
          ls.splice(at, 0, ...newLines);
          eols.splice(at, 0, ...newLines.map(() => eol));
        }
      });
    } catch (err) {
      this.fileWriteFailed(err, 'add the task');
    }
    return { lineIndex: at, parent, undo: { type: 'rewrite', file: anchor.file, before: res.before, after: res.after } };
  };

  /** The `move` action: value is { parent | after | before: task id }. Moves the task with its notes and subtasks. */
  proto.moveTask = function moveTask(t, value) {
    if (t.kind !== 'task') throw new HttpError(400, 'Only tasks can be moved. Mark this line as a to-do first.');
    let place;
    try {
      place = placementOf(value);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (!place) throw new HttpError(400, `Say where to move it: ${WHERE.join(', ')} with a task id.`);
    const anchor = this.task(place.ref);
    if (anchor.kind !== 'task') throw new HttpError(400, 'Move it next to or under a task, not a note or plain line.');
    if (anchor.file !== t.file) {
      throw new HttpError(400, 'That task is in another file. Move a task into another file by adding it to a list that keeps its tasks in that file (listAdd), or edit the files.');
    }
    const parsed = this.parsedFor(t.file);
    const me = parsed.items.find((i) => i.lineIndex === t.lineIndex && i.kind === 'task');
    if (!me || parsed.lines[t.lineIndex] !== t.raw) throw new HttpError(409, CHANGED, 'conflict');
    const block = blockLines(parsed, me);
    const inBlock = new Set(block);
    if (inBlock.has(anchor.lineIndex)) throw new HttpError(400, 'A task cannot move under or next to itself or its own subtasks.');
    const { at, indent, parent } = this.placeIn(parsed, anchor, place.how);

    const myIndent = own(me.raw);
    const ctx = { symbols: t.symbols, unmarkedMode: t.unmarkedMode, today: this.now() };
    let moved;
    try {
      moved = block.map((i) => {
        let raw = parsed.lines[i];
        if (raw.trim() && !raw.startsWith(myIndent)) throw new HttpError(400, 'The indentation here mixes tabs and spaces, so it cannot be moved safely. Fix it in the file first.');
        raw = raw.trim() ? indent + raw.slice(myIndent.length) : raw;
        if (i === me.lineIndex) raw = applyOp(raw, 'clearSubtask', null, ctx);
        return raw;
      });
    } catch (err) {
      if (err instanceof OpError) throw new HttpError(400, err.message);
      throw err;
    }
    const rest = parsed.lines.map((_, i) => i).filter((i) => !inBlock.has(i));
    let pos = rest.filter((i) => i < at).length;
    if (pos === rest.length && parsed.lines[parsed.lines.length - 1] === '' && rest.length) pos = rest.length - 1;
    const newLines = [...rest.slice(0, pos).map((i) => parsed.lines[i]), ...moved, ...rest.slice(pos).map((i) => parsed.lines[i])];
    if (sameLines(newLines, parsed.lines)) return { ok: true, message: `Already there: ${t.text}`, focusId: t.id };

    const after = this.simulateFile(newLines, t.unmarkedMode);
    const head = after.items.find((i) => i.lineIndex === pos);
    const skip = new Set(moved.map((_, k) => pos + k));
    const gotParent = head && head.parent >= 0 ? after.items[head.parent].text : null;
    const count = (p, s) => p.items.filter((i) => i.kind === 'task' && s.has(i.lineIndex)).length;
    if (!head || head.kind !== 'task' || gotParent !== (parent ? parent.text : null) || count(after, skip) !== count(parsed, inBlock) || !sameLines(others(after, skip), others(parsed, inBlock))) {
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
    const where = place.how === 'parent' ? `under ${anchor.text}` : `${place.how} ${anchor.text}`;
    return { ok: true, message: `Moved ${where}: ${t.text}. Press u to undo`, undo: true, focusId: this.idAt(t.file, pos) };
  };
}

module.exports = { install, placementOf, WHERE };
