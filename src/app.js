'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const cfgMod = require('./config');
const { Index, walk, isExcluded, modeFor, TEXT_EXT } = require('./indexer');
const { applyOp, OpError } = require('./ops');
const { replaceLine, ConflictError } = require('./writer');
const { parseFriendly, formatDate, toISO } = require('./dates');
const { VIEWS, buildView, viewCounts, untriaged, myListTasks } = require('./views');
const { convertRtfFiles } = require('./rtf');
const { JiraClient, JiraError, KEY_RE } = require('./jira');
const secrets = require('./secrets');

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
    this.index = new Index({ getConfig: () => this.config });
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
    const counts = viewCounts(this.index, this.stateData, today);
    return {
      rev: this.index.rev,
      views: VIEWS.map((v) => ({ id: v.id, title: v.title, count: counts[v.id] })),
      folders: this.config.folders.length,
      files: this.index.files.length,
      problems: this.index.problems,
      rtfPending: this.index.rtf.length,
      jiraConfigured: !!this.jiraClientOrNull(),
      recentlyWrote: Date.now() - this.lastWriteAt < 3000,
    };
  }

  view(opts) {
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
    let next;
    try {
      next = applyOp(t.raw, op, arg, { symbols: t.symbols, unmarkedMode: t.unmarkedMode, today });
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

  dismiss(items) {
    for (const t of items) {
      const list = (this.stateData.dismissed[t.file] = this.stateData.dismissed[t.file] || []);
      if (!list.includes(t.textHash)) list.push(t.textHash);
    }
    this.saveState();
    this.undoStack.push({ type: 'dismiss', items: items.map((t) => ({ file: t.file, hash: t.textHash })) });
    this.index.emit('change', this.index.rev);
  }

  async action({ id, op, value }) {
    const today = this.now();
    if (op === 'dismissFile') {
      const file = String(id).replace(/^f:/, '');
      const list = untriaged(this.index, this.stateData).filter((u) => u.file === file);
      if (!list.length) throw new HttpError(404, 'Nothing left to skip in that file');
      this.stateData.reviewed[file] = list[0].fileMtime;
      this.dismiss(list);
      return { ok: true, message: `Skipped ${list.length} unmarked ${list.length === 1 ? 'line' : 'lines'} in ${list[0].fileLabel}`, undo: true };
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
    if (op === 'refresh') {
      this.index.refresh(today);
      return { ok: true, message: 'List refreshed' };
    }
    const t = this.task(id);
    const done = (r, message) => (r ? { ok: true, message, undo: true, focusId: r.focusId } : { ok: true, message: `No change: ${t.text}` });
    switch (op) {
      case 'dismiss':
        this.dismiss([t]);
        return { ok: true, message: `Skipped: ${t.text}` };
      case 'listToggle':
        return this.listToggle(t);
      case 'listMove':
        return this.listMove(t, value);
      case 'open':
        this.opener(t.file, t.line);
        return { ok: true, message: `Opening ${t.fileLabel}. The task is on line ${t.line}.` };
      case 'done':
      case 'toggleDone': {
        const reopen = t.flags.done && op === 'toggleDone';
        return done(this.lineWrite(t, reopen ? 'reopen' : 'done'), `${reopen ? 'Reopened' : 'Marked done'}: ${t.text}`);
      }
      case 'todo':
        return done(this.lineWrite(t, 'todo'), `Marked as to-do: ${t.text}`);
      case 'due': {
        let iso = null;
        if (value && String(value).trim()) {
          iso = parseFriendly(value, today);
          if (!iso) throw new HttpError(400, `Could not understand "${value}" as a date. Try fri, nov 20, +3d, or 2026-11-20.`, 'bad-date');
        }
        return done(this.lineWrite(t, 'due', iso), iso ? `Due date set to ${formatDate(iso, today)}: ${t.text}` : `Due date cleared: ${t.text}`);
      }
      case 'jira': {
        const key = value ? String(value).trim() : '';
        if (key && !KEY_RE.test(key)) throw new HttpError(400, 'Jira keys look like ABC-123');
        return done(this.lineWrite(t, 'jira', key || null), key ? `Linked to Jira ${key.toUpperCase()}: ${t.text}` : `Jira link removed: ${t.text}`);
      }
      default:
        if (FLAG_MESSAGES[op]) {
          const had = t.flags[op];
          return done(this.lineWrite(t, op), `${FLAG_MESSAGES[op][had ? 1 : 0]}: ${t.text}`);
        }
        throw new HttpError(400, `Unknown action: ${op}`);
    }
  }

  touchList() {
    this.lastWriteAt = Date.now();
    this.index.emit('change', this.index.rev);
  }

  setList(next, before, t) {
    this.stateData.mylist = next;
    this.saveState();
    this.undoStack.push({ type: 'order', before, id: t.id, text: t.text });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.touchList();
  }

  listToggle(t) {
    if (t.kind !== 'task') throw new HttpError(400, 'Only tasks can go on My list. Mark this line as a to-do first.');
    const before = [...this.stateData.mylist];
    if (before.includes(t.listKey)) {
      this.setList(before.filter((k) => k !== t.listKey), before, t);
      return { ok: true, message: `Removed from My list: ${t.text}`, undo: true, focusId: t.id };
    }
    this.setList([...before, t.listKey], before, t);
    const n = myListTasks(this.index, this.stateData).filter((x) => !x.flags.done).length;
    return { ok: true, message: `Added to My list, position ${n} of ${n}: ${t.text}`, undo: true, focusId: t.id };
  }

  listMove(t, how) {
    const open = myListTasks(this.index, this.stateData).filter((x) => !x.flags.done);
    const cur = open.findIndex((x) => x.listKey === t.listKey);
    if (cur < 0) throw new HttpError(400, 'That task is not on My list. Press l to add it.');
    const last = open.length - 1;
    const to = { up: cur - 1, down: cur + 1, top: 0, bottom: last }[how];
    if (to === undefined) throw new HttpError(400, 'Move up, down, top or bottom');
    if (to < 0 || to > last || to === cur) {
      return { ok: true, message: `Already ${cur === 0 && to <= cur ? 'first' : 'last'} on My list: ${t.text}`, focusId: t.id };
    }
    const before = [...this.stateData.mylist];
    const next = before.filter((k) => k !== t.listKey);
    const anchor = next.indexOf(open[to].listKey);
    next.splice(to < cur ? anchor : anchor + 1, 0, t.listKey);
    this.setList(next, before, t);
    return { ok: true, message: `Moved ${to < cur ? 'up' : 'down'} to position ${to + 1} of ${open.length}: ${t.text}`, undo: true, focusId: t.id };
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) throw new HttpError(400, 'Nothing to undo');
    if (e.type === 'order') {
      this.stateData.mylist = e.before;
      this.saveState();
      this.touchList();
      return { ok: true, message: `Undid My list change: ${e.text}`, focusId: this.index.get(e.id) ? e.id : null };
    }
    if (e.type === 'reviewed') {
      if (e.prev === undefined) delete this.stateData.reviewed[e.file];
      else this.stateData.reviewed[e.file] = e.prev;
      this.saveState();
      this.touchList();
      return { ok: true, message: 'Undid mark as reviewed' };
    }
    if (e.type === 'dismiss') {
      for (const { file, hash } of e.items) {
        this.stateData.dismissed[file] = (this.stateData.dismissed[file] || []).filter((h) => h !== hash);
        delete this.stateData.reviewed[file];
      }
      this.saveState();
      this.index.emit('change', this.index.rev);
      return { ok: true, message: 'Undid skip' };
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
      jira: j ? { baseUrl: j.baseUrl, type: j.type, email: j.email || '', project: j.project || '', issueType: j.issueType || 'Task', hasToken: !!this.secrets.getJiraToken() } : null,
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
      this.config = { ...this.config, jira: { baseUrl: url, type, email: String(email).trim(), project: String(project).trim(), issueType: String(issueType).trim() || 'Task' } };
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

module.exports = { App, HttpError };
