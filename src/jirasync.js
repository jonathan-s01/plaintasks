'use strict';

// Jira sync: runs only when asked. preview() compares every task in the files of lists that have "Sync to Jira" on
// with its Jira issue and returns a plan; nothing is sent or written. apply() rebuilds the plan, carries out only the
// changes the user chose that are still the same, and records what was in sync, so the next run can tell which side
// changed. Installed onto App.prototype by app.js.

const { JiraError, KEY_RE } = require('./jira');
const { applyOp } = require('./ops');
const { toISO } = require('./dates');
const { transformFile, ConflictError } = require('./writer');
const { bucketIndex, isBucket } = require('./buckets');
const { jiraSkipSources } = require('./parser');

const STARTED_RE = /^started:?\s+(\d{4}-\d{2}-\d{2})\.?$/i;
const FIELD_RE = /^[A-Za-z0-9_]+$/;
const KINDS = ['open', 'inProgress', 'ongoing', 'done', 'deleted'];

const SYNC_DEFAULTS = {
  project: '',
  epic: '',
  taskType: '',
  subtaskType: '',
  startField: '',
  dueField: 'duedate',
  flaggedField: '',
  assignee: '',
  reporter: '',
  statuses: { open: 'To Do', inProgress: 'In Progress', ongoing: 'In Progress', done: 'Resolved', deleted: 'Resolved' },
  transitions: {},
  resolutions: { done: 'Done', deleted: "Won't Do" },
  labels: { waiting: 'waiting', ongoing: 'ongoing' },
  priorities: { high: 'High', medium: 'Medium', low: 'Low' },
  labelPrefix: 'bucket-',
  linkType: 'Relates',
  blockType: 'Blocks',
};

const KIND_WORDS = { open: 'to do (@)', inProgress: 'in progress (%)', ongoing: 'ongoing (~)', done: 'done (+)', deleted: 'deleted ($)' };

const str = (v) => (v == null ? '' : String(v).trim());

/** "In Discovery=3, To Do=11" or { "In Discovery": "3" } -> { "In Discovery": "3" }. */
function parseTransitions(v) {
  const out = {};
  const pairs = typeof v === 'string' ? v.split(/[,\n]/).map((p) => p.split('=')) : Object.entries(v || {});
  for (const [name, id] of pairs) {
    const n = str(name);
    const i = str(id);
    if (!n && !i) continue;
    if (!n || !/^\d+$/.test(i)) throw new JiraError(`Transitions look like "To Do=11": could not read "${[name, id].filter((x) => x != null).join('=')}"`);
    out[n] = i;
  }
  return out;
}

function cleanSync(v, prev = {}) {
  const base = { ...SYNC_DEFAULTS, ...prev };
  const s = v && typeof v === 'object' ? v : {};
  const pick = (k) => (s[k] !== undefined ? str(s[k]) : base[k]);
  const out = {
    project: pick('project').toUpperCase(),
    epic: pick('epic').toUpperCase(),
    taskType: pick('taskType'),
    subtaskType: pick('subtaskType'),
    startField: pick('startField'),
    dueField: pick('dueField'),
    flaggedField: pick('flaggedField'),
    assignee: pick('assignee'),
    reporter: pick('reporter'),
    linkType: pick('linkType') || 'Relates',
    blockType: pick('blockType') || 'Blocks',
    labelPrefix: (pick('labelPrefix') || SYNC_DEFAULTS.labelPrefix).replace(/\s+/g, '-'),
    statuses: { ...SYNC_DEFAULTS.statuses, ...base.statuses },
    resolutions: { ...SYNC_DEFAULTS.resolutions, ...base.resolutions },
    labels: { ...SYNC_DEFAULTS.labels, ...base.labels },
    priorities: { ...SYNC_DEFAULTS.priorities, ...base.priorities },
    transitions: s.transitions !== undefined ? parseTransitions(s.transitions) : { ...base.transitions },
  };
  for (const k of KINDS) if (s.statuses && s.statuses[k] !== undefined) out.statuses[k] = str(s.statuses[k]) || SYNC_DEFAULTS.statuses[k];
  for (const k of ['done', 'deleted']) if (s.resolutions && s.resolutions[k] !== undefined) out.resolutions[k] = str(s.resolutions[k]) || SYNC_DEFAULTS.resolutions[k];
  for (const k of ['high', 'medium', 'low']) if (s.priorities && s.priorities[k] !== undefined) out.priorities[k] = str(s.priorities[k]) || SYNC_DEFAULTS.priorities[k];
  for (const k of ['waiting', 'ongoing']) if (s.labels && s.labels[k] !== undefined) out.labels[k] = str(s.labels[k]).replace(/\s+/g, '-');
  if (out.project && !/^[A-Z][A-Z0-9_]*$/.test(out.project)) throw new JiraError('The Jira project key looks like ABC');
  if (out.epic && !KEY_RE.test(out.epic)) throw new JiraError('The epic key looks like ABC-123');
  for (const k of ['taskType', 'subtaskType', 'startField', 'dueField', 'flaggedField']) {
    if (out[k] && !FIELD_RE.test(out[k])) throw new JiraError(`${k} should be an id such as 10002 or customfield_10035`);
  }
  return out;
}

// ---- Atlassian Document Format ----

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'text', text: m[0], marks: [{ type: 'link', attrs: { href: m[0] } }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** Notes as an ADF document, one paragraph per note, with web addresses as links. Null when there are no notes. */
function toAdf(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  return { type: 'doc', version: 1, content: lines.map((l) => ({ type: 'paragraph', content: inline(l) })) };
}

const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'listItem', 'tableRow']);

/** Plain text of an ADF document (or a v2 string), one trimmed line per block, for comparing with notes. */
function adfToText(doc) {
  if (!doc) return '';
  if (typeof doc === 'string') return normText(doc);
  // Checklist items read "[x] text" (done) or "[ ] text", with "- " per level of nesting.
  const walk = (n, d = 0) => {
    if (!n || typeof n !== 'object') return '';
    if (n.type === 'text') return n.text || '';
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'taskList') return (n.content || []).map((c) => walk(c, c.type === 'taskList' ? d + 1 : d)).join('');
    const inner = (n.content || []).map((c) => walk(c, d)).join('');
    if (n.type === 'taskItem') return `\n${'- '.repeat(d)}[${n.attrs && n.attrs.state === 'DONE' ? 'x' : ' '}] ${inner}\n`;
    return BLOCKS.has(n.type) ? `${inner}\n` : inner;
  };
  return normText(walk(doc));
}

function normText(s) {
  return String(s || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// ---- what a task wants in Jira ----

function fileKind(t) {
  if (t.kind === 'excluded' || t.flags.excluded) return 'deleted';
  if (t.flags.done) return 'done';
  if (t.flags.ongoing) return 'ongoing';
  if (t.flags.inProgress) return 'inProgress';
  return 'open';
}

const startedNote = (n) => { const m = STARTED_RE.exec(str(n)); return m ? m[1] : null; };
const descOf = (t) => normText((t.notes || []).filter((n) => !startedNote(n)).join('\n'));

/** Checklist rows as text, the same way adfToText reads them back from Jira. */
const checklistLines = (nodes, d = 0) => nodes.flatMap((n) => [`${'- '.repeat(d)}[${n.done ? 'x' : ' '}] ${n.text}`, ...checklistLines(n.kids, d + 1)]);
const checklistCount = (nodes) => nodes.reduce((sum, n) => sum + 1 + checklistCount(n.kids), 0);
const checklistOf = (ctx, t) => (ctx.checklists && ctx.checklists.get(t.id)) || [];
/** What the description should say: the notes, then a Sub-task's checklist of the tasks nested under it. */
const descTextOf = (ctx, t) => normText([descOf(t), ...checklistLines(checklistOf(ctx, t))].join('\n'));

function taskListAdf(nodes, ids) {
  const list = { type: 'taskList', attrs: { localId: `pt-${(ids.n += 1)}` }, content: [] };
  for (const n of nodes) {
    list.content.push({ type: 'taskItem', attrs: { localId: `pt-${(ids.n += 1)}`, state: n.done ? 'DONE' : 'TODO' }, content: inline(n.text) });
    if (n.kids.length) list.content.push(taskListAdf(n.kids, ids));
  }
  return list;
}

function descAdfOf(ctx, t) {
  const nodes = checklistOf(ctx, t);
  const doc = toAdf(descOf(t));
  if (!nodes.length) return doc;
  const out = doc || { type: 'doc', version: 1, content: [] };
  out.content.push(taskListAdf(nodes, { n: 0 }));
  return out;
}

const startOf = (t) => t.start || (t.notes || []).map(startedNote).find(Boolean) || null;
const dueOf = (t) => (t.flags.done ? t.doneDate || t.due || null : t.due || null);

function wantedStatus(cfg, kind, list) {
  if (kind === 'open' && list && list.jiraStatus) return list.jiraStatus;
  return cfg.statuses[kind];
}

function resolutionField(cfg, kind) {
  const r = cfg.resolutions[kind === 'deleted' ? 'deleted' : 'done'];
  return { resolution: /^\d+$/.test(r) ? { id: r } : { name: r } };
}

const lower = (s) => str(s).toLowerCase();

/** How the issue reads as a plaintasks status. */
function jiraKind(cfg, issue) {
  const f = issue.fields || {};
  const cat = f.status && f.status.statusCategory ? f.status.statusCategory.key : '';
  const res = f.resolution ? f.resolution : null;
  const deleted = res && (lower(res.name) === lower(cfg.resolutions.deleted) || res.id === cfg.resolutions.deleted);
  if (cat === 'done') return deleted ? 'deleted' : 'done';
  if (cat === 'indeterminate') return 'inProgress';
  return 'open';
}

/** Whether the issue's status already matches. `exact`: the status name must match too (used right after creating). */
function statusInSync(cfg, kind, issue, list, exact) {
  const f = issue.fields || {};
  const name = f.status ? f.status.name : '';
  const jk = jiraKind(cfg, issue);
  const same = jk === kind || (kind === 'ongoing' && jk === 'inProgress');
  if (!same) return false;
  return !exact || lower(name) === lower(wantedStatus(cfg, kind, list));
}

const statusSig = (issue) => {
  const f = issue.fields || {};
  return `${f.status ? f.status.name : ''}|${f.resolution ? f.resolution.name : ''}`;
};
const statusWords = (issue) => {
  const f = issue.fields || {};
  return `${f.status ? f.status.name : 'no status'}${f.resolution ? `, resolution ${f.resolution.name}` : ''}`;
};
const isFlagged = (v) => (Array.isArray(v) ? v.length > 0 : !!v);

function listForFile(lists, file) {
  const mine = lists.filter((l) => l.jiraSync && l.file === file);
  if (!mine.length) return null;
  return {
    id: mine[0].id,
    name: mine.map((l) => l.name).join(', '),
    jiraStatus: (mine.find((l) => l.jiraStatus) || {}).jiraStatus || '',
    jiraLabels: [...new Set(mine.flatMap((l) => l.jiraLabels || []))],
  };
}

function managedLabels(cfg, ctxLists) {
  return new Set([cfg.labels.waiting, cfg.labels.ongoing, ...ctxLists.flatMap((l) => l.jiraLabels || [])].filter(Boolean));
}

/** Labels for a task's buckets (own, or inherited from its parent task or its list): prefix plus the bucket id. */
function bucketLabels(cfg, t, bucketsById) {
  if (!bucketsById) return [];
  // Deleted ($) lines are not indexed, so they have no inherited buckets: use their own tokens.
  const ids = t.buckets || (t.goalLinks || []).filter((id) => bucketsById.has(id));
  return ids.filter((id) => bucketsById.has(id) && bucketsById.get(id).id !== t.id).map((id) => `${cfg.labelPrefix}${id}`);
}

function wantedLabels(cfg, t, list, bucketsById) {
  const out = new Set(list.jiraLabels || []);
  if (t.flags.waitingOnOthers && cfg.labels.waiting) out.add(cfg.labels.waiting);
  if (t.flags.ongoing && cfg.labels.ongoing) out.add(cfg.labels.ongoing);
  for (const l of bucketLabels(cfg, t, bucketsById)) out.add(l);
  return out;
}

/** Which of high, medium, low a Jira priority name means, by the names in Settings. Null for any other name. */
function priorityKind(cfg, name) {
  const n = lower(name);
  return n ? ['high', 'medium', 'low'].find((k) => lower(cfg.priorities[k]) === n) || null : null;
}

/** How many parent steps a task is below its main task (0 = Task, 1 = Sub-task, 2+ = checklist item). */
function levelOf(byTaskId, t) {
  let n = 0;
  for (let cur = t; cur.parentId && byTaskId.has(cur.parentId); cur = byTaskId.get(cur.parentId).t) n += 1;
  return n;
}

/**
 * Checklists for Sub-tasks: Map(taskId -> [{ text, done, kids }]) of the tasks nested under each one, in file order.
 * Lines already in Jira sync on their own (their children move up a level); open questions stay out with their subtasks.
 */
function checklistsFor(entries) {
  const byTaskId = new Map(entries.map((e) => [e.t.id, e]));
  const nodes = (t) => {
    const out = [];
    for (const cid of t.childIds || []) {
      const e = byTaskId.get(cid);
      if (!e) continue;
      const c = e.t;
      if (c.jira) out.push(...nodes(c));
      else if (!c.flags.question) out.push({ text: c.text, done: !!c.flags.done, kids: nodes(c) });
    }
    return out;
  };
  const out = new Map();
  for (const e of entries) {
    if (e.excluded || levelOf(byTaskId, e.t) !== 1) continue;
    const list = nodes(e.t);
    if (list.length) out.set(e.t.id, list);
  }
  return out;
}

function descWords(t, n) {
  const notes = !!descOf(t);
  const items = n === 1 ? '1 checklist item' : `${n} checklist items`;
  if (!n) return notes ? 'from the notes' : 'clear it';
  return notes ? `from the notes and ${items}` : items;
}

/** Issues a task waits for, as Map(upper-case Jira key or "new:taskId" -> blocker task). Blockers that will not be in Jira are left out. */
function wantedBlockers(index, t, willCreate = () => false) {
  const out = new Map();
  for (const bid of t.blockedBy || []) {
    const b = index.get(bid);
    if (!b || b.id === t.id || isBucket(b) || b.jiraSkip) continue;
    if (b.jira) out.set(b.jira.toUpperCase(), b);
    else if (willCreate(b.id)) out.set(`new:${b.id}`, b);
  }
  return out;
}

const blockLinksOf = (cfg, issue) => ((issue.fields && issue.fields.issuelinks) || []).filter((l) => lower(l.type && l.type.name) === lower(cfg.blockType) && l.inwardIssue);

/** Per field: the file's value, Jira's value, and whether they agree. Missing fields are left out. */
function fieldStates(ctx, entry, issue) {
  const { cfg } = ctx;
  const { t, list } = entry;
  const f = issue.fields || {};
  const kind = fileKind(t);
  const out = {
    status: { file: kind, jira: statusSig(issue), same: statusInSync(cfg, kind, issue, list) },
  };
  if (kind === 'deleted') return out;
  out.summary = { file: t.text, jira: str(f.summary), same: str(f.summary) === t.text };
  const desc = adfToText(f.description);
  const descWant = descTextOf(ctx, t);
  out.desc = { file: descWant, jira: desc, same: descWant === desc };
  if (f.priority !== undefined) {
    const pn = f.priority ? str(f.priority.name) : '';
    const jk = priorityKind(cfg, pn);
    out.priority = { file: t.priority || 'medium', jira: jk || pn, pullKind: jk, same: jk ? jk === (t.priority || 'medium') : !pn && (t.priority || 'medium') === 'medium' };
  }
  if (cfg.dueField) {
    const j = f[cfg.dueField] ? String(f[cfg.dueField]).slice(0, 10) : '';
    out.due = { file: dueOf(t) || '', jira: j, same: (dueOf(t) || '') === j };
  }
  if (cfg.startField) {
    const j = f[cfg.startField] ? String(f[cfg.startField]).slice(0, 10) : '';
    out.start = { file: startOf(t) || '', jira: j, same: (startOf(t) || '') === j };
  }
  if (ctx.flaggedField) {
    const j = isFlagged(f[ctx.flaggedField]);
    out.flagged = { file: !!t.flags.waitingOnOthers, jira: j, same: j === !!t.flags.waitingOnOthers };
  }
  const want = wantedLabels(cfg, t, list, ctx.bucketsById);
  const have = new Set(f.labels || []);
  const snap = ((ctx.synced[issue.key] || {}).labels || {}).added || [];
  const add = [...want].filter((l) => !have.has(l));
  // Labels with the bucket prefix belong to buckets, so any that is no longer wanted goes, whoever added it.
  const prefixed = [...have].filter((l) => cfg.labelPrefix && l.startsWith(cfg.labelPrefix));
  const remove = [...new Set([...snap, ...prefixed])].filter((l) => !want.has(l) && have.has(l));
  out.labels = { file: [...want], jira: [...have], add, remove, same: !add.length && !remove.length };
  return out;
}

function install(App, HttpError) {
  const proto = App.prototype;

  const wrap = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof JiraError) throw new HttpError(502, err.message);
      throw err;
    }
  };

  proto.syncConfig = function syncConfig() {
    const j = this.config.jira;
    if (!j) throw new HttpError(400, 'Jira is not set up. Open Settings to add it.', 'jira-unconfigured');
    if (j.type !== 'cloud') throw new HttpError(400, 'Sync with Jira needs Jira Cloud.', 'jira-unconfigured');
    const cfg = cleanSync(j.sync || {});
    const missing = [['project', 'project key'], ['taskType', 'Task issue type id'], ['subtaskType', 'Sub-task issue type id']]
      .filter(([k]) => !cfg[k]).map(([, w]) => w);
    if (missing.length) throw new HttpError(400, `Jira sync needs the ${missing.join(', ')}. Add them in Settings.`, 'jira-unconfigured');
    return cfg;
  };

  proto.cleanJiraSync = function cleanJiraSync(v, prev) {
    try {
      return cleanSync(v, prev);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  };

  /** Per-list sync settings from a list form. Only the keys present in `v` are returned. */
  proto.cleanJiraListSettings = function cleanJiraListSettings(v, list) {
    const out = {};
    if (typeof v.jiraSync === 'boolean') {
      if (v.jiraSync && !list.file) throw new HttpError(400, 'Choose a file for the list first: Jira sync works per file.');
      out.jiraSync = v.jiraSync;
    }
    if (v.jiraLabels !== undefined) {
      const raw = Array.isArray(v.jiraLabels) ? v.jiraLabels : String(v.jiraLabels || '').split(/[,\s]+/);
      out.jiraLabels = [...new Set(raw.map(str).filter(Boolean))];
    }
    if (v.jiraStatus !== undefined) out.jiraStatus = str(v.jiraStatus).slice(0, 60);
    return out;
  };

  /** Everything a plan needs: settings, the tasks of synced files, and their issues from Jira. */
  proto.syncContext = async function syncContext() {
    const cfg = this.syncConfig();
    const client = this.jiraClient();
    this.index.refresh(this.now());
    const lists = this.stateData.lists.filter((l) => l.jiraSync && l.file);
    const files = [...new Set(lists.map((l) => l.file))].filter((f) => this.fileEntry(f));
    const entries = [];
    for (const file of files) {
      const list = listForFile(this.stateData.lists, file);
      // Buckets (jira:label) are never issues; the tasks in them get a label instead.
      for (const t of this.index.tasks) if (t.file === file && !isBucket(t)) entries.push({ t, list, skip: t.jiraSkip });
      // Deleted ($) lines are not in the index, but a linked one still closes its issue as Won't Do.
      const parsed = this.parsedFor(file);
      const label = this.fileEntry(file).label;
      const skips = jiraSkipSources(parsed);
      parsed.items.forEach((it, i) => {
        if (it.kind !== 'excluded' || !it.jira || it.jiraLabel) return;
        entries.push({ t: { ...it, id: `x:${file}:${it.lineIndex}`, file, fileLabel: label, line: it.lineIndex + 1, notes: [], symbols: parsed.symbols, unmarkedMode: parsed.unmarkedMode }, list, excluded: true, skip: skips[i] });
      });
    }
    // jira:skip lines (and everything under them) stay out: never created, never updated. A linked one is reported.
    const skipped = entries.filter((e) => e.skip && e.t.jira).map((e) => e.t);
    for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].skip) entries.splice(i, 1);
    const checklists = checklistsFor(entries);
    const keys = [...new Set(entries.map((e) => e.t.jira).filter(Boolean))];
    let flaggedField = cfg.flaggedField;
    if (!flaggedField) {
      const all = await client.fields();
      const hit = (Array.isArray(all) ? all : []).find((f) => lower(f.name) === 'flagged');
      flaggedField = hit ? hit.id : '';
    }
    const issues = await this.fetchIssues(client, cfg, flaggedField, keys);
    const jstate = this.stateData.jira;
    return { cfg, client, lists, files, entries, issues, flaggedField, bucketsById: bucketIndex(this.index).byId, checklists, skipped, created: new Set(jstate.created), synced: jstate.synced };
  };

  proto.fetchIssues = async function fetchIssues(client, cfg, flaggedField, keys) {
    const fields = ['summary', 'status', 'priority', 'resolution', 'resolutiondate', 'description', 'labels', 'issuelinks', 'parent', 'issuetype', cfg.dueField, cfg.startField, flaggedField].filter(Boolean);
    const issues = new Map();
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const found = await client.searchJql(`key in (${chunk.join(',')})`, fields);
      for (const is of found) issues.set(String(is.key).toUpperCase(), is);
    }
    return issues;
  };

  /** Builds the list of changes. Item ids are stable, and `sig` changes when either side does. */
  proto.syncPlan = function syncPlan(ctx) {
    const { cfg, entries, issues, created, synced } = ctx;
    const items = [];
    const info = [];
    const byTaskId = new Map(entries.map((e) => [e.t.id, e]));
    const where = (t) => ({ taskId: t.id, task: t.text, file: t.fileLabel, line: t.line });
    const add = (it) => items.push({ ...it, sig: JSON.stringify([it.from, it.to, it.raw]) });
    // A task under a bucket line is a main task: the bucket is never an issue to be a parent.
    const topOf = (t) => {
      let cur = t;
      while (cur.parentId && byTaskId.has(cur.parentId)) cur = byTaskId.get(cur.parentId).t;
      return cur;
    };
    const creating = new Set();
    for (const t of ctx.skipped || []) info.push({ ...where(t), key: t.jira, text: `Not synced: skipped (jira:skip); linked issue ${t.jira} left in Jira.` });

    for (const e of entries) {
      const { t, list } = e;
      if (t.jira) continue;
      if (e.excluded) continue;
      // Two levels only: Tasks and their Sub-tasks. Deeper tasks are the Sub-task's checklist, quietly.
      const level = levelOf(byTaskId, t);
      if (level >= 2) continue;
      const kind = fileKind(t);
      const sub = t.depth > 0 && t.parentId && byTaskId.has(t.parentId);
      const top = sub ? topOf(t) : null;
      // Opt-in: a main task goes only when marked jira:yes; a subtask goes when its main task is marked or linked.
      if (level === 0 ? !t.jiraYes : !(top && (top.jira || top.jiraYes))) continue;
      // An open question (?) is not created until it is answered. A task linked to Jira keeps syncing either way.
      if (t.flags.question) {
        info.push({ ...where(t), text: 'Not synced: open question.' });
        continue;
      }
      if (sub && !top.jira && (fileKind(top) === 'done')) {
        info.push({ ...where(t), text: `Not created: its main task, ${top.text}, is done and not in Jira.` });
        continue;
      }
      if (sub && !top.jira && top.flags.question) {
        info.push({ ...where(t), text: `Not created: its main task, ${top.text}, is an open question and not in Jira.` });
        continue;
      }
      creating.add(t.id);
      const buckets = bucketLabels(cfg, t, ctx.bucketsById);
      const items0 = checklistCount(checklistOf(ctx, t));
      add({
        id: `create:${t.id}`,
        group: 'create',
        ...where(t),
        raw: t.raw,
        field: 'create',
        parentTaskId: sub ? top.id : null,
        label: `Create ${sub ? `Sub-task of ${top.jira || top.text}` : `Task${cfg.epic ? ` in epic ${cfg.epic}` : ''}`}, status ${wantedStatus(cfg, kind, list)}${t.priority && t.priority !== 'medium' ? `, priority ${cfg.priorities[t.priority]}` : ''}${buckets.length ? `, ${buckets.length === 1 ? 'label' : 'labels'} ${buckets.join(', ')}` : ''}${items0 ? `, includes ${items0 === 1 ? '1 checklist item' : `${items0} checklist items`}` : ''}`,
        from: null,
        to: { kind, text: t.text },
        checked: kind !== 'done',
      });
    }

    for (const e of entries) {
      const { t, list } = e;
      if (!t.jira) continue;
      const issue = issues.get(t.jira.toUpperCase());
      if (!issue) {
        info.push({ ...where(t), key: t.jira, text: `${t.jira} was not found in Jira, or you cannot see it.` });
        continue;
      }
      const key = issue.key;
      const ours = created.has(key);
      const snap = synced[key] || {};
      const states = fieldStates(ctx, e, issue);
      const base = { ...where(t), key, raw: t.raw };

      // Status and summary can change on either side.
      for (const field of ['status', 'summary', 'priority']) {
        const s = states[field];
        if (!s || s.same) continue;
        const sn = snap[field];
        const fileChanged = !sn || sn.file !== s.file;
        const jiraChanged = !sn || sn.jira !== s.jira;
        const isStatus = field === 'status';
        const isPriority = field === 'priority';
        if (isPriority && !s.pullKind) {
          add({ ...base, id: `${key}:priority`, group: 'push', field, label: `Priority: Jira has "${s.jira || 'none'}", which is not High, Medium or Low in Settings. Send ${cfg.priorities[s.file]} from the file`, from: s.jira, to: s.file, checked: false });
          continue;
        }
        const fileWords = isStatus ? `${KIND_WORDS[s.file]} → Jira ${wantedStatus(cfg, s.file, list)}` : isPriority ? `${s.file} → Jira ${cfg.priorities[s.file]}` : s.file;
        const pullKind = isStatus ? jiraKind(cfg, issue) : isPriority ? s.pullKind : null;
        const jiraWords = isStatus ? `${statusWords(issue)} → file ${KIND_WORDS[pullKind]}` : isPriority ? `${issue.fields.priority ? issue.fields.priority.name : 'none'} → file ${pullKind}` : s.jira;
        const fieldName = isStatus ? 'Status' : isPriority ? 'Priority' : 'Summary';
        if (e.excluded) {
          add({ ...base, id: `${key}:${field}`, group: 'push', field, label: `Close as ${cfg.resolutions.deleted}: the line is deleted ($) in the file`, from: statusWords(issue), to: s.file, checked: true });
        } else if (!sn || (fileChanged && jiraChanged)) {
          add({
            ...base, id: `${key}:${field}`, group: 'conflict', field,
            label: `${fieldName} differs${sn ? ' and both sides changed' : ' (first sync)'}`,
            from: s.jira, to: s.file, pullKind,
            choices: { file: `Keep file: ${fileWords}`, jira: `Take Jira: ${jiraWords}` },
            // plaintasks made this issue from the file, so on a first sync the file is the source of truth.
            choice: !sn && ours ? 'file' : 'skip',
          });
        } else if (jiraChanged) {
          add({
            ...base, id: `${key}:${field}`, group: 'pull', field, pullKind,
            label: `${fieldName} changed in Jira: ${jiraWords}`,
            from: s.file, to: s.jira, checked: true,
          });
        } else {
          add({
            ...base, id: `${key}:${field}`, group: 'push', field,
            label: `${fieldName} changed in the file: ${fileWords}${!isStatus && !ours ? '. plaintasks did not create this issue' : ''}`,
            from: s.jira, to: s.file, checked: isStatus || isPriority || ours,
          });
        }
      }
      if (e.excluded) continue;

      // Push-only fields. Never clear a value in Jira that plaintasks did not set.
      const names = { desc: 'Description', due: 'Due date', start: 'Start date', flagged: 'Flagged' };
      for (const field of ['desc', 'due', 'start', 'flagged']) {
        const s = states[field];
        if (!s || s.same) continue;
        const sn = snap[field];
        const unchanged = !!sn && sn.jira === s.jira;
        const jiraEmpty = !s.jira;
        if (!s.file && !jiraEmpty && !unchanged) continue;
        let checked = unchanged || jiraEmpty;
        if (field === 'desc' && !ours) checked = false;
        const shown = (v) => (field === 'flagged' ? (v ? 'flagged' : 'not flagged') : v || 'none');
        add({
          ...base, id: `${key}:${field}`, group: 'push', field,
          label: `${names[field]}: ${field === 'desc' ? descWords(t, checklistCount(checklistOf(ctx, t))) : shown(s.file)}${field === 'desc' && !ours ? '. plaintasks did not create this issue' : ''}${!unchanged && !jiraEmpty ? '. It was changed in Jira' : ''}`,
          from: s.jira, to: s.file, checked,
        });
      }
      const lab = states.labels;
      if (lab && !lab.same) {
        add({
          ...base, id: `${key}:labels`, group: 'push', field: 'labels',
          label: `Labels: ${[lab.add.length ? `add ${lab.add.join(', ')}` : '', lab.remove.length ? `remove ${lab.remove.join(', ')}` : ''].filter(Boolean).join('; ')}`,
          from: lab.jira, to: { add: lab.add, remove: lab.remove }, checked: true,
        });
      }
    }

    // Blocks links: the task waiting is blocked by each open or done task it waits for, once both are (or will be) in Jira.
    for (const e of entries) {
      const { t } = e;
      if (e.excluded) continue;
      const issue = t.jira ? issues.get(t.jira.toUpperCase()) : null;
      if (t.jira && !issue) continue;
      if (!t.jira && !creating.has(t.id)) continue;
      const wanted = wantedBlockers(this.index, t, (id) => creating.has(id));
      const have = issue ? blockLinksOf(cfg, issue) : [];
      const haveKeys = new Set(have.map((l) => str(l.inwardIssue.key).toUpperCase()));
      for (const [k, b] of wanted) {
        if (haveKeys.has(k)) continue;
        add({
          ...where(t), key: t.jira || null, raw: t.raw, id: `block:${t.id}:${b.id}`, group: 'push', field: 'block',
          blockerTaskId: b.id,
          label: `Blocked by ${b.text}${b.jira ? ` (${b.jira})` : ''}: add a ${cfg.blockType} link`,
          from: null, to: b.jira || b.text, checked: true,
        });
      }
      // Remove only links plaintasks made, and not while a waiting-for token has no task behind it.
      const unresolved = (t.waitsFor || []).length > (t.blockedBy || []).length;
      const ours = ((synced[issue ? issue.key : ''] || {}).blockers) || [];
      if (!issue || unresolved) continue;
      for (const l of have) {
        const k = str(l.inwardIssue.key).toUpperCase();
        if (wanted.has(k) || !ours.includes(k)) continue;
        add({
          ...where(t), key: issue.key, raw: t.raw, id: `unblock:${t.id}:${k}`, group: 'push', field: 'unblock',
          linkId: l.id, blockerKey: k,
          label: `No longer blocked by ${k}: remove the ${cfg.blockType} link`,
          from: k, to: null, checked: true,
        });
      }
    }

    const started = this.startedNotes().length;
    return { items, info, startedNotes: started, synced: ctx.files.map((f) => (this.fileEntry(f) || {}).label || f) };
  };

  proto.syncPreview = async function syncPreview() {
    return wrap(async () => {
      const ctx = await this.syncContext();
      const plan = this.syncPlan(ctx);
      if (!ctx.files.length) plan.message = 'No list syncs with Jira yet. In Manage lists (press M), tick Sync to Jira on a list that keeps its tasks in a file.';
      return plan;
    });
  };

  /** value.choices: { itemId: { choice: 'apply' | 'file' | 'jira', sig } }. Anything else is skipped. */
  proto.syncApply = async function syncApply(value) {
    const choices = (value && value.choices) || {};
    return wrap(async () => {
      const ctx = await this.syncContext();
      const plan = this.syncPlan(ctx);
      const { cfg, client } = ctx;
      const results = [];
      const note = (ok, text) => results.push({ ok, text });
      const chosen = [];
      for (const [id, c] of Object.entries(choices)) {
        const it = plan.items.find((x) => x.id === id);
        const want = c && c.choice;
        if (!want || want === 'skip') continue;
        if (!it || it.sig !== c.sig) {
          note(false, `Skipped, it changed since the preview: ${it ? it.task : id}`);
          continue;
        }
        let mode = 'push';
        if (it.group === 'pull') mode = 'pull';
        else if (it.group === 'conflict') mode = want === 'jira' ? 'pull' : 'push';
        chosen.push({ ...it, mode });
      }
      const entryOf = new Map(ctx.entries.map((e) => [e.t.id, e]));
      const newKeys = new Map();
      const keyOf = (taskId) => {
        const e = entryOf.get(taskId);
        return (e && e.t.jira) || newKeys.get(taskId) || null;
      };

      const saved = this.undoStack;
      this.undoStack = [];
      // Find a task again after earlier writes: same file and line, same text.
      const live = (t) => {
        if (t.id.startsWith('x:')) return t;
        const hit = this.index.get(this.idAt(t.file, t.lineIndex));
        if (hit && hit.text === t.text) return hit;
        return this.index.tasks.find((x) => x.file === t.file && x.text === t.text) || null;
      };
      const writeLine = (t, ops) => {
        const cur = live(t);
        if (!cur) throw new HttpError(409, 'the line changed in the file');
        return this.lineWrite(cur, ops);
      };
      let jiraChanges = 0;

      try {
        const creates = chosen.filter((it) => it.field === 'create');
        for (const it of [...creates.filter((x) => !x.parentTaskId), ...creates.filter((x) => x.parentTaskId)]) {
          const { t, list } = entryOf.get(it.taskId);
          try {
            const parent = it.parentTaskId ? keyOf(it.parentTaskId) : cfg.epic || null;
            if (it.parentTaskId && !parent) throw new Error('its main task is not in Jira, so it was not created');
            const kind = fileKind(t);
            const fields = {
              project: { key: cfg.project },
              issuetype: { id: it.parentTaskId ? cfg.subtaskType : cfg.taskType },
              summary: t.text.slice(0, 250),
            };
            if (parent) fields.parent = { key: parent };
            const desc = descAdfOf(ctx, t);
            if (desc) fields.description = desc;
            if (cfg.assignee) fields.assignee = { accountId: cfg.assignee };
            if (cfg.reporter) fields.reporter = { accountId: cfg.reporter };
            if (cfg.dueField && dueOf(t)) fields[cfg.dueField] = dueOf(t);
            if (cfg.startField && startOf(t)) fields[cfg.startField] = startOf(t);
            const labels = [...wantedLabels(cfg, t, list, ctx.bucketsById)];
            if (labels.length) fields.labels = labels;
            if (t.priority && t.priority !== 'medium') fields.priority = { name: cfg.priorities[t.priority] };
            const made = await client.create(fields);
            jiraChanges += 1;
            newKeys.set(t.id, made.key);
            this.stateData.jira.created = [...new Set([...this.stateData.jira.created, made.key])];
            this.saveState();
            try {
              writeLine(t, [['jira', made.key], ['jiraYes', false]]);
            } catch (err) {
              note(false, `Created ${made.key} but could not write jira:${made.key} into ${t.fileLabel} line ${t.line}: ${err.message}. Add it by hand: ${t.text}`);
              continue;
            }
            if (ctx.flaggedField && t.flags.waitingOnOthers) await client.update(made.key, { fields: { [ctx.flaggedField]: [{ value: 'Impediment' }] } });
            // Read the new issue directly: JQL search can lag behind a create and miss it, which left done tasks at To Do.
            let fresh = null;
            try {
              fresh = await client.v3('GET', `/issue/${encodeURIComponent(made.key)}?fields=status,resolution`);
            } catch {
              /* unknown status: move it below */
            }
            const known = fresh && fresh.fields && fresh.fields.status;
            const landsRight = kind === 'open' && !(list && list.jiraStatus);
            if (known ? !statusInSync(cfg, kind, fresh, list, true) : !landsRight) {
              try {
                await this.moveIssue(client, cfg, made.key, kind, list);
              } catch (err) {
                note(false, `Created ${made.key}: ${t.text}, but could not set its status to ${wantedStatus(cfg, kind, list)}: ${err.message}`);
                continue;
              }
            }
            note(true, `Created ${made.key}: ${t.text}`);
          } catch (err) {
            note(false, `Could not create ${t.text}: ${err.message}`);
          }
        }

        // Updates to existing issues, one request per issue, then status.
        const byKey = new Map();
        for (const it of chosen) if (it.key && it.mode === 'push' && !['link', 'block', 'unblock', 'create'].includes(it.field)) {
          if (!byKey.has(it.key)) byKey.set(it.key, []);
          byKey.get(it.key).push(it);
        }
        for (const [key, its] of byKey) {
          const { t, list } = entryOf.get(its[0].taskId);
          const fields = {};
          const update = {};
          const done = [];
          let status = null;
          for (const it of its) {
            if (it.field === 'status') status = fileKind(t);
            else if (it.field === 'summary') fields.summary = t.text.slice(0, 250);
            else if (it.field === 'priority') fields.priority = { name: cfg.priorities[t.priority || 'medium'] };
            else if (it.field === 'desc') fields.description = descAdfOf(ctx, t);
            else if (it.field === 'due') fields[cfg.dueField] = dueOf(t) || null;
            else if (it.field === 'start') fields[cfg.startField] = startOf(t) || null;
            else if (it.field === 'flagged') fields[ctx.flaggedField] = t.flags.waitingOnOthers ? [{ value: 'Impediment' }] : null;
            else if (it.field === 'labels') update.labels = [...it.to.add.map((l) => ({ add: l })), ...it.to.remove.map((l) => ({ remove: l }))];
            done.push(it.field === 'desc' ? 'description' : it.field);
          }
          try {
            if (Object.keys(fields).length || update.labels) {
              await client.update(key, { fields: Object.keys(fields).length ? fields : undefined, update: update.labels ? update : undefined });
              jiraChanges += 1;
            }
            if (update.labels) {
              const snap = this.stateData.jira.synced[key] || (this.stateData.jira.synced[key] = {});
              const its2 = its.find((x) => x.field === 'labels');
              const had = new Set(((snap.labels || {}).added) || []);
              for (const l of its2.to.add) had.add(l);
              for (const l of its2.to.remove) had.delete(l);
              snap.labels = { added: [...had] };
            }
            if (status) {
              await this.moveIssue(client, cfg, key, status, list);
              jiraChanges += 1;
            }
            note(true, `Updated ${key} (${done.join(', ')}): ${t.text}`);
          } catch (err) {
            note(false, `Could not update ${key}, ${t.text}: ${err.message}`);
          }
        }

        for (const it of chosen.filter((x) => x.field === 'block')) {
          const dep = keyOf(it.taskId);
          const blocker = keyOf(it.blockerTaskId) || (this.index.get(it.blockerTaskId) || {}).jira;
          try {
            if (!dep || !blocker) throw new Error('one of the two tasks is not in Jira');
            await client.link(cfg.blockType, blocker, dep);
            jiraChanges += 1;
            note(true, `${blocker} now blocks ${dep}: ${it.task}`);
          } catch (err) {
            note(false, `Could not link ${it.task} to the task it waits for: ${err.message}`);
          }
        }
        for (const it of chosen.filter((x) => x.field === 'unblock')) {
          try {
            await client.unlink(it.linkId);
            jiraChanges += 1;
            note(true, `Removed the ${cfg.blockType} link from ${it.blockerKey} to ${it.key}: ${it.task}`);
          } catch (err) {
            note(false, `Could not remove the link to ${it.blockerKey}: ${err.message}`);
          }
        }

        // File changes from Jira, one write per line.
        const pulls = new Map();
        for (const it of chosen) if (it.mode === 'pull') {
          if (!pulls.has(it.taskId)) pulls.set(it.taskId, []);
          pulls.get(it.taskId).push(it);
        }
        for (const [taskId, its] of pulls) {
          const { t } = entryOf.get(taskId);
          const issue = ctx.issues.get(t.jira.toUpperCase());
          const ops = [];
          for (const it of its) {
            if (it.field === 'summary') ops.push(['text', issue.fields.summary]);
            if (it.field === 'priority') ops.push(['priority', it.pullKind]);
            if (it.field === 'status') ops.push(...pullOps(t, it.pullKind, issue));
          }
          try {
            const r = ops.length ? writeLine(t, ops) : null;
            note(true, r ? `Updated the file from ${t.jira}: ${t.text}` : `No change needed in the file: ${t.text}`);
          } catch (err) {
            note(false, `Could not update ${t.fileLabel} line ${t.line} from ${t.jira}: ${err.message}`);
          }
        }
      } finally {
        const steps = this.undoStack;
        this.undoStack = saved;
        if (steps.length) this.pushUndo(steps.length === 1 ? steps[0] : { type: 'multi', steps, text: 'Jira sync' });
        this.lastSyncUndo = steps.length;
      }

      await this.recordSnapshots(cfg, client, ctx.flaggedField);
      const fileChanges = this.lastSyncUndo;
      const failed = results.filter((r) => !r.ok).length;
      const parts = [`${jiraChanges} ${jiraChanges === 1 ? 'change' : 'changes'} sent to Jira`, `${fileChanges} ${fileChanges === 1 ? 'line' : 'lines'} changed in files`];
      if (failed) parts.push(`${failed} not done`);
      return {
        ok: true,
        message: `Jira sync finished: ${parts.join(', ')}.${fileChanges ? ' Press U to undo the file changes; Jira changes stay.' : ''}`,
        results,
        undo: fileChanges > 0,
      };
    });
  };

  /** Moves an issue to the status for `kind`, with the resolution when it closes. */
  proto.moveIssue = async function moveIssue(client, cfg, key, kind, list) {
    const name = wantedStatus(cfg, kind, list);
    let id = Object.entries(cfg.transitions).find(([n]) => lower(n) === lower(name));
    id = id ? id[1] : null;
    if (!id) {
      const j = await client.v3('GET', `/issue/${encodeURIComponent(key)}/transitions`);
      const hit = (j.transitions || []).find((x) => lower(x.to && x.to.name) === lower(name) || lower(x.name) === lower(name));
      if (!hit) throw new JiraError(`no transition to ${name}. Add it under Transitions in Settings`);
      id = hit.id;
    }
    await client.transition(key, id, kind === 'done' || kind === 'deleted' ? resolutionField(cfg, kind) : undefined);
  };

  /** Re-reads the synced issues and remembers each field where file and Jira agree. */
  proto.recordSnapshots = async function recordSnapshots(cfg, client, flaggedField) {
    try {
      const ctx = await this.syncContext();
      for (const e of ctx.entries) {
        if (!e.t.jira) continue;
        const issue = ctx.issues.get(e.t.jira.toUpperCase());
        if (!issue) continue;
        const snap = this.stateData.jira.synced[issue.key] || {};
        const states = fieldStates(ctx, e, issue);
        for (const [field, s] of Object.entries(states)) {
          if (!s.same) continue;
          if (field === 'labels') {
            const want = new Set(s.file);
            snap.labels = { added: [...new Set([...((snap.labels || {}).added || []).filter((l) => want.has(l)), ...s.file])] };
          } else snap[field] = { file: s.file, jira: s.jira };
        }
        const have = new Set(blockLinksOf(cfg, issue).map((l) => str(l.inwardIssue.key).toUpperCase()));
        const want = wantedBlockers(this.index, e.t);
        snap.blockers = [...new Set([...(snap.blockers || []).filter((k) => have.has(k)), ...[...want.keys()].filter((k) => have.has(k))])];
        this.stateData.jira.synced[issue.key] = snap;
      }
      this.saveState();
    } catch {
      /* a failed re-read leaves the old snapshots; the next preview then shows conflicts instead of guessing */
    }
  };

  // ---- "& Started YYYY-MM-DD" notes -> start: tokens ----

  proto.startedNotes = function startedNotes() {
    const out = [];
    for (const f of this.index.files) {
      let parsed;
      try {
        parsed = this.parsedFor(f.file);
      } catch {
        continue;
      }
      for (const it of parsed.items) {
        if (it.kind !== 'task' || it.start) continue;
        const n = it.notes.find((x) => x.amp && startedNote(x.text));
        if (n) out.push({ file: f.file, label: f.label, taskLine: it.lineIndex, noteLine: n.lineIndex, date: startedNote(n.text), raw: it.raw, text: it.text, symbols: parsed.symbols, unmarkedMode: parsed.unmarkedMode });
      }
    }
    return out;
  };

  proto.convertStarted = function convertStarted() {
    const found = this.startedNotes();
    if (!found.length) return { ok: true, message: 'No "& Started" notes to convert.' };
    const byFile = new Map();
    for (const x of found) {
      if (!byFile.has(x.file)) byFile.set(x.file, []);
      byFile.get(x.file).push(x);
    }
    const steps = [];
    let count = 0;
    try {
      for (const [file, list] of byFile) {
        const res = transformFile(file, (lines, eols) => {
          for (const x of list) {
            if (lines[x.taskLine] !== x.raw || !startedNote((lines[x.noteLine] || '').replace(/^[ \t]*&/, ''))) throw new ConflictError('The file changed since it was read. Nothing was written.');
            lines[x.taskLine] = applyOp(x.raw, 'start', x.date, { symbols: x.symbols, unmarkedMode: x.unmarkedMode, today: this.now() });
          }
          for (const x of [...list].sort((a, b) => b.noteLine - a.noteLine)) {
            lines.splice(x.noteLine, 1);
            eols.splice(x.noteLine, 1);
          }
          return {};
        });
        steps.push({ type: 'rewrite', file, before: res.before, after: res.after, text: 'Started notes' });
        count += list.length;
      }
    } catch (err) {
      if (steps.length) this.pushUndo(steps.length === 1 ? steps[0] : { type: 'multi', steps, text: 'Started notes' });
      this.index.refresh(this.now());
      if (err instanceof ConflictError) throw new HttpError(409, `${err.message}${count ? ` ${count} notes in other files were converted; press U to undo them.` : ''}`, 'conflict');
      throw new HttpError(500, err.message);
    }
    if (steps.length) this.pushUndo(steps.length === 1 ? steps[0] : { type: 'multi', steps, text: 'Started notes' });
    this.lastWriteAt = Date.now();
    this.index.refresh(this.now());
    return { ok: true, message: `Converted ${count} "& Started" ${count === 1 ? 'note' : 'notes'} to start: dates in ${byFile.size} ${byFile.size === 1 ? 'file' : 'files'}. Press U to undo.`, undo: true };
  };
}

/** Line ops that make the file match a status read from Jira. */
function pullOps(t, kind, issue) {
  const f = t.flags;
  const ops = [];
  if (kind === 'deleted') return [['exclude']];
  if (kind === 'done') {
    const when = issue.fields && issue.fields.resolutiondate ? String(issue.fields.resolutiondate).slice(0, 10) : null;
    if (f.inProgress) ops.push(['inProgress']);
    ops.push(['done', when]);
    return ops;
  }
  if (f.done) ops.push(['reopen']);
  if (kind === 'inProgress') {
    if (!f.inProgress && !f.ongoing) ops.push(['inProgress']);
  } else {
    if (f.inProgress) ops.push(['inProgress']);
    if (f.ongoing) ops.push(['ongoing']);
  }
  return ops;
}

module.exports = { install, cleanSync, toAdf, adfToText, parseTransitions, SYNC_DEFAULTS, fileKind, STARTED_RE, toISO };
