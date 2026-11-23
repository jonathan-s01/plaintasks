'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { parseText } = require('./parser');
const { computeBuckets } = require('./buckets');
const { link: linkBlockers } = require('./blocks');
const { decode, UnsupportedFileError } = require('./writer');

const TEXT_EXT = new Set(['.txt', '.md', '.text']);
const MAX_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules']);

const sha = (s, n = 12) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

function isExcluded(rel, excluded) {
  return excluded.some((ex) => rel === ex || rel.startsWith(`${ex}/`));
}

function modeFor(folder, rel) {
  let best = null;
  for (const [p, mode] of Object.entries(folder.overrides || {})) {
    if ((rel === p || rel.startsWith(`${p}/`)) && (!best || p.length > best.length)) best = p;
  }
  return best ? folder.overrides[best] : folder.unmarked;
}

/** Walk a watched folder, yielding text files, rtf files and directories (relative, "/"-separated). */
function walk(folder, visit) {
  const root = folder.path;
  let rootStat = null;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return;
  }
  if (rootStat.isFile()) {
    visit({ type: 'file', rel: path.basename(root), abs: root, ext: path.extname(root).toLowerCase() });
    return;
  }
  const rec = (dirAbs, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        visit({ type: 'dir', rel, abs });
        rec(abs, rel);
      } else if (e.isFile()) {
        visit({ type: 'file', rel, abs, ext: path.extname(e.name).toLowerCase() });
      }
    }
  };
  rec(root, '');
}

class Index extends EventEmitter {
  constructor({ getConfig, getNoteLinks, getDismissed }) {
    super();
    this.getConfig = getConfig;
    this.getNoteLinks = getNoteLinks || (() => ({}));
    this.getDismissed = getDismissed || (() => []);
    this.cache = new Map();
    this.files = [];
    this.tasks = [];
    this.unmarked = [];
    this.problems = [];
    this.rtf = [];
    this.byId = new Map();
    this.rev = 0;
    this.signature = '';
    this.watchers = [];
    this.timer = null;
    this.poll = null;
  }

  refresh(today = new Date()) {
    const cfg = this.getConfig();
    const files = [];
    const tasks = [];
    const unmarked = [];
    const problems = [];
    const rtf = [];
    const seen = new Set();
    const sig = [];

    cfg.folders.forEach((folder, folderIndex) => {
      if (!fs.existsSync(folder.path)) {
        problems.push({ folder: folder.path, message: 'Folder not found' });
        return;
      }
      const isFile = fs.statSync(folder.path).isFile();
      const folderName = path.basename(isFile ? path.dirname(folder.path) : folder.path);
      walk(folder, (e) => {
        if (e.type !== 'file' || isExcluded(e.rel, folder.excluded)) return;
        if (e.ext === '.rtf') {
          rtf.push({ folderIndex, rel: e.rel, abs: e.abs });
          return;
        }
        if (!TEXT_EXT.has(e.ext) || seen.has(e.abs)) return;
        seen.add(e.abs);
        const label = `${folderName}/${e.rel}`;
        let st;
        try {
          st = fs.statSync(e.abs);
        } catch {
          return;
        }
        const mode = modeFor(folder, e.rel);
        sig.push(`${e.abs}|${st.mtimeMs}|${st.size}|${mode}`);
        if (st.size > MAX_BYTES) {
          problems.push({ file: e.abs, label, message: 'Skipped: file is larger than 5 MB' });
          return;
        }
        const key = `${st.mtimeMs}|${st.size}|${mode}|${today.toDateString()}`;
        let entry = this.cache.get(e.abs);
        if (!entry || entry.key !== key) {
          try {
            const buf = fs.readFileSync(e.abs);
            const { text } = decode(buf);
            entry = { key, parsed: parseText(text, { unmarked: mode, today }), hash: sha(buf.toString('latin1'), 16), error: null };
          } catch (err) {
            entry = { key, parsed: null, error: err instanceof UnsupportedFileError ? err.message : `Could not read: ${err.message}` };
          }
          this.cache.set(e.abs, entry);
        }
        if (entry.error) {
          problems.push({ file: e.abs, label, message: entry.error });
          return;
        }
        const file = { file: e.abs, label, rel: e.rel, folderIndex, folderName, mtimeMs: st.mtimeMs, unmarkedMode: entry.parsed.unmarkedMode, hasLegend: entry.parsed.legend.hasLegend, taskCount: 0, title: entry.parsed.title };
        files.push(file);
        this.collect(entry.parsed, file, tasks, unmarked);
      });
    });

    const signature = sig.join('\n') + `\n${problems.length}|${rtf.length}`;
    const changed = signature !== this.signature || JSON.stringify(cfg.folders) !== this.cfgSig;
    this.cfgSig = JSON.stringify(cfg.folders);
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);

    this.files = files;
    linkBlockers(tasks);
    this.buckets = computeBuckets(tasks, files);
    this.tasks = tasks;
    this.unmarked = unmarked;
    this.problems = problems;
    this.rtf = rtf;
    this.byId = new Map([...tasks, ...unmarked].map((t) => [t.id, t]));
    if (changed) {
      this.signature = signature;
      this.rev += 1;
      this.emit('change', this.rev);
    }
    return changed;
  }

  collect(parsed, file, tasks, unmarked) {
    const occ = new Map();
    const ids = parsed.items.map((it) => {
      const k = it.raw.trim();
      const n = (occ.get(k) || 0) + 1;
      occ.set(k, n);
      return sha(`${file.file}\0${k}\0${n}`);
    });
    const textOcc = new Map();
    const listKeys = parsed.items.map((it) => {
      const n = (textOcc.get(it.text) || 0) + 1;
      textOcc.set(it.text, n);
      return sha(`${file.file}\0${it.text}\0${n}`);
    });
    const unmarkedItems = parsed.items.filter((it) => it.kind === 'unmarked');
    parsed.items.forEach((it, i) => {
      if (it.kind === 'excluded') return;
      const nearby = (from, step) => {
        const out = [];
        for (let j = from; j >= 0 && j < parsed.lines.length && out.length < 2; j += step) {
          const t = parsed.lines[j].trim();
          if (t) out.push(t);
          else break;
        }
        return step < 0 ? out.reverse() : out;
      };
      const base = {
        listKey: listKeys[i],
        before: it.kind === 'task' ? [] : nearby(it.lineIndex - 1, -1),
        after: it.kind === 'task' ? [] : nearby(it.lineIndex + 1, 1),
        fileUnmarkedTotal: unmarkedItems.length,
        id: ids[i],
        kind: it.kind,
        file: file.file,
        fileLabel: file.label,
        fileMtime: file.mtimeMs,
        line: it.lineIndex + 1,
        lineIndex: it.lineIndex,
        raw: it.raw,
        text: it.text,
        flags: it.flags,
        group: it.group,
        notes: it.notes.map((n) => n.text),
        depth: it.depth || 0,
        parentId: it.parent >= 0 ? ids[it.parent] : null,
        childIds: (it.children || []).filter((c) => parsed.items[c].kind !== 'excluded').map((c) => ids[c]),
        due: it.due || null,
        dueTime: it.dueTime || null,
        checkin: it.checkin || null,
        checkinTime: it.checkinTime || null,
        noteLines: it.notes.map((n) => n.lineIndex),
        doneDate: it.doneDate || null,
        start: it.start || null,
        picked: it.picked || null,
        priority: it.priority || 'medium',
        refId: it.refId || null,
        waitsFor: it.waitsFor || [],
        jira: it.jira || null,
        jiraLabel: !!it.jiraLabel,
        goalId: it.goalId || null,
        goalLinks: it.goalLinks || [],
        symbols: parsed.symbols,
        unmarkedMode: parsed.unmarkedMode,
        textHash: sha(it.raw.trim()),
      };
      if (it.kind === 'task') {
        tasks.push(base);
        file.taskCount += 1;
      } else unmarked.push(base);
    });

    // Task lines the user converted to notes (kept in state, the file is untouched) leave the task list.
    const asNotes = new Set(this.getDismissed(file.file));
    for (let k = tasks.length - 1; k >= 0; k -= 1) {
      const t = tasks[k];
      if (t.file !== file.file || !asNotes.has(t.textHash) || t.childIds.length) continue;
      tasks.splice(k, 1);
      file.taskCount -= 1;
      unmarked.push({ ...t, kind: 'unmarked', childIds: [], parentId: null, flags: { ...t.flags, done: false } });
    }

    // Lines the user marked as notes in triage attach to the task they chose.
    const links = this.getNoteLinks(file.file);
    for (const u of unmarked) {
      if (u.file !== file.file || !links[u.textHash]) continue;
      const parent = tasks.find((t) => t.file === file.file && t.listKey === links[u.textHash]);
      if (parent) {
        parent.notes = [...parent.notes, u.text];
        u.attachedTo = parent.text;
      }
    }
  }

  get(id) {
    // Rows that show a task a second time (a task under each of its buckets) use "taskId@where" ids.
    return this.byId.get(id) || this.byId.get(String(id).split('@')[0]) || null;
  }

  watch(intervalMs = 15000) {
    this.unwatch();
    const kick = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        try {
          this.refresh();
        } catch (err) {
          this.emit('error', err);
        }
      }, 250);
    };
    this.kick = kick;
    for (const folder of this.getConfig().folders) {
      try {
        const w = fs.watch(folder.path, { recursive: true }, kick);
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {
        /* folder missing; the poll below will report it */
      }
    }
    this.poll = setInterval(kick, intervalMs);
    this.poll.unref();
  }

  unwatch() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    clearTimeout(this.timer);
    clearInterval(this.poll);
  }
}

module.exports = { Index, walk, isExcluded, modeFor, TEXT_EXT };
