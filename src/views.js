'use strict';

const { formatDate, formatTime, relativeDue, daysBetween, toISO } = require('./dates');

const VIEWS = [
  { id: 'open', title: 'All open tasks', hierarchical: true },
  { id: 'file', title: 'By file', hierarchical: true },
  { id: 'group', title: 'By group or project', hierarchical: true },
  { id: 'schedule', title: 'Schedule: overdue, today, this week', empty: 'Nothing has a due date or check-in date. Press d on a task to set one.' },
  { id: 'due', title: 'Due soon and overdue', empty: 'No open tasks are overdue or due within 7 days.' },
  { id: 'waitingMe', title: 'Waiting on me', empty: 'Nothing is waiting on you.' },
  { id: 'waitingOthers', title: 'Waiting on others', empty: 'Nothing is waiting on someone else.' },
  { id: 'important', title: 'Important', empty: 'No important tasks.' },
  { id: 'inProgress', title: 'In progress', empty: 'Nothing is in progress.' },
  { id: 'completed', title: 'Completed', empty: 'No completed tasks.' },
  { id: 'triage', title: 'Triage unmarked lines', empty: 'Nothing left to review.' },
];

const STATIC_IDS = VIEWS.map((v) => v.id);

function listView(l) {
  return { id: `list:${l.id}`, title: l.name, isList: true, empty: `${l.name} is empty. Press l on any task to add it, or n to find or create one here.` };
}

const LISTS_VIEW = { id: 'lists', title: 'All lists', empty: 'No lists yet. Press M to manage lists.' };

/** Built-in views plus the all-lists view and one view per user list, placed before the schedule view. */
function allViews(state) {
  const at = VIEWS.findIndex((v) => v.id === 'schedule');
  return [...VIEWS.slice(0, at), LISTS_VIEW, ...(state.lists || []).map(listView), ...VIEWS.slice(at)];
}
const DUE_SOON_DAYS = 7;

function matcher(q) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  return (t) => {
    const hay = `${t.text} ${t.group} ${t.fileLabel} ${t.notes.join(' ')} ${t.jira || ''} ${t.due || ''} ${t.checkin || ''}`.toLowerCase();
    return terms.every((x) => hay.includes(x));
  };
}

function statusWords(t) {
  const f = t.flags;
  const w = [f.done ? 'Done' : 'Open'];
  if (f.important) w.push('Important');
  if (f.waitingOnMe) w.push('Waiting on me');
  if (f.waitingOnOthers) w.push('Waiting on someone else');
  if (f.inProgress) w.push('In progress');
  if (f.ongoing) w.push('Ongoing');
  return w;
}

function atTime(time) {
  return time ? ` at ${formatTime(time)}` : '';
}

function dueInfo(t, today) {
  if (!t.due) return null;
  const rel = relativeDue(t.due, today);
  const tail = rel.text.replace(/^due /, '');
  return { iso: t.due, state: t.flags.done ? 'none' : rel.state, text: `Due ${formatDate(t.due, today)}${atTime(t.dueTime)}, ${tail}` };
}

function checkinText(t, today) {
  if (!t.checkin) return null;
  const rel = relativeDue(t.checkin, today);
  return `Check in ${formatDate(t.checkin, today)}${atTime(t.checkinTime)}, ${rel.text.replace(/^due /, '')}`;
}

function describe(t, today, level, extra = {}) {
  const due = dueInfo(t, today);
  const meta = [];
  if (due) meta.push(t.flags.done ? `Due ${formatDate(t.due, today)}${atTime(t.dueTime)}` : due.text);
  const checkin = !t.flags.done && checkinText(t, today);
  if (checkin) meta.push(checkin);
  if (t.flags.done && t.doneDate) meta.push(`Completed ${formatDate(t.doneDate, today)}`);
  if (extra.parentText) meta.push(`Subtask of ${extra.parentText}`);
  if (t.group && !extra.hideGroup) meta.push(`Group ${t.group}`);
  if (t.jira) meta.push(`Jira ${t.jira}`);
  if (t.notes.length) meta.push(t.notes.length === 1 ? '1 note' : `${t.notes.length} notes`);
  if (!extra.hideFile) meta.push(`File ${t.fileLabel}, line ${t.line}`);
  return {
    id: t.id,
    type: t.kind === 'unmarked' ? 'unmarked' : 'task',
    level,
    text: t.text,
    words: t.kind === 'unmarked' ? ['Unmarked'] : statusWords(t),
    meta,
    due: due ? { iso: due.iso, state: due.state, time: t.dueTime || null } : null,
    checkin: t.checkin ? { iso: t.checkin, time: t.checkinTime || null } : null,
    flags: t.flags,
    hasChildren: !!extra.hasChildren,
    notes: t.notes,
    jira: t.jira,
    fileLabel: t.fileLabel,
    line: t.line,
    ...(t.kind === 'unmarked' ? { context: { before: t.before || [], after: t.after || [] } } : {}),
  };
}

function predicates(today) {
  return {
    open: (t) => !t.flags.done,
    file: (t) => !t.flags.done,
    group: (t) => !t.flags.done,
    due: (t) => !!t.due && daysBetween(toISO(today), t.due) <= DUE_SOON_DAYS,
    waitingMe: (t) => t.flags.waitingOnMe,
    waitingOthers: (t) => t.flags.waitingOnOthers,
    important: (t) => t.flags.important,
    inProgress: (t) => t.flags.inProgress,
    completed: (t) => t.flags.done,
  };
}

function untriaged(index, state, { changedOnly = false } = {}) {
  const reviewed = state.reviewed || {};
  return index.unmarked.filter((u) => !((state.dismissed || {})[u.file] || []).includes(u.textHash) && !(changedOnly && reviewed[u.file] === u.fileMtime));
}

/** Items on a list: tasks, and unmarked lines that were added as list notes. In the list's own order. */
function listTasks(index, state, listId) {
  const list = (state.lists || []).find((l) => l.id === listId);
  const byKey = new Map(index.unmarked.map((u) => [u.listKey, u]));
  for (const t of index.tasks) byKey.set(t.listKey, t);
  return list ? list.keys.map((k) => byKey.get(k)).filter(Boolean) : [];
}

function sortListItems(items, list, state) {
  const mode = list.sort || 'manual';
  if (mode === 'manual') return items;
  const created = state.created || {};
  const isNote = (t) => t.kind !== 'task';
  const order = new Map(items.map((t, i) => [t, i]));
  const when = (iso, time) => (iso ? `${iso} ${time || '99:99'}` : '9999');
  const byDate = (key) => (a, b) => when(a[key], a[`${key}Time`]).localeCompare(when(b[key], b[`${key}Time`]));
  const cmp = {
    due: byDate('due'),
    checkin: byDate('checkin'),
    created: (a, b) => (created[a.listKey] || '9999').localeCompare(created[b.listKey] || '9999'),
    type: () => 0,
    name: (a, b) => a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: 'base' }),
  }[mode];
  const noteRank = (t) => (isNote(t) && mode !== 'name' && mode !== 'created' ? 1 : 0);
  return [...items].sort((a, b) => noteRank(a) - noteRank(b) || cmp(a, b) || order.get(a) - order.get(b));
}

/** Events that put a task on the schedule: its earliest open due or check-in date. */
function scheduled(index, today) {
  const out = [];
  for (const t of index.tasks) {
    if (t.flags.done) continue;
    const dates = [];
    if (t.due) dates.push({ iso: t.due, time: t.dueTime });
    if (t.checkin) dates.push({ iso: t.checkin, time: t.checkinTime });
    if (!dates.length) continue;
    dates.sort((a, b) => `${a.iso} ${a.time || '00:00'}`.localeCompare(`${b.iso} ${b.time || '00:00'}`));
    out.push({ t, iso: dates[0].iso, time: dates[0].time });
  }
  return out.sort((a, b) => `${a.iso} ${a.time || '00:00'}`.localeCompare(`${b.iso} ${b.time || '00:00'}`) || a.t.fileLabel.localeCompare(b.t.fileLabel) || a.t.line - b.t.line);
}

function scheduleBucket(iso, today) {
  const d = daysBetween(toISO(today), iso);
  if (d < 0) return 'Overdue';
  if (d === 0) return 'Today';
  if (d <= 7) return 'This week';
  return 'Later';
}

function viewCounts(index, state, today) {
  const preds = predicates(today);
  const counts = {};
  for (const v of allViews(state)) {
    if (v.id === 'triage') counts.triage = untriaged(index, state).length;
    else if (v.id === 'lists') counts.lists = (state.lists || []).length;
    else if (v.id === 'schedule') counts.schedule = scheduled(index, today).length;
    else if (v.isList) counts[v.id] = listTasks(index, state, v.id.slice(5)).filter((t) => !t.flags.done).length;
    else if (v.id === 'completed') counts.completed = index.tasks.filter(preds.completed).length;
    else counts[v.id] = index.tasks.filter((t) => !t.flags.done && preds[v.id](t)).length;
  }
  return counts;
}

/** A task's own notes show as rows under it when it is expanded. */
function withNoteRows(items) {
  const out = [];
  for (const it of items) {
    out.push(it);
    if (it.type !== 'task' || !it.notes || !it.notes.length) continue;
    it.hasChildren = true;
    it.noteCount = it.notes.length;
    it.notes.forEach((text, i) => out.push({ id: `tn:${it.id}:${i}`, type: 'tasknote', level: it.level + 1, text, words: ['Note'], meta: [], hasChildren: false, flags: {}, notes: [] }));
  }
  return out;
}

function buildHierarchy(index, ctx, groupKeyOf) {
  const { today, showCompleted, match } = ctx;
  const byId = new Map(index.tasks.map((t) => [t.id, t]));
  const memo = new Map();
  const include = (t) => {
    if (memo.has(t.id)) return memo.get(t.id);
    let r = (showCompleted || !t.flags.done) && match(t);
    if (!r) r = t.childIds.some((c) => byId.has(c) && include(byId.get(c)));
    memo.set(t.id, r);
    return r;
  };
  const emit = (t, level, out, hideGroup) => {
    const kids = t.childIds.map((c) => byId.get(c)).filter((c) => c && include(c));
    out.push(describe(t, today, level, { hasChildren: kids.length > 0, hideGroup }));
    for (const k of kids) emit(k, level + 1, out, hideGroup);
  };
  const roots = index.tasks.filter((t) => t.parentId === null && include(t));
  if (!groupKeyOf) {
    const out = [];
    for (const r of roots) emit(r, 1, out, false);
    return out;
  }
  const buckets = new Map();
  for (const r of roots) {
    const { key, label } = groupKeyOf(r);
    if (!buckets.has(key)) buckets.set(key, { label, roots: [] });
    buckets.get(key).roots.push(r);
  }
  const ordered = [...buckets.entries()].sort(([a], [b]) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0));
  const out = [];
  for (const [key, b] of ordered) {
    const body = [];
    for (const r of b.roots) emit(r, 2, body, true);
    const n = body.filter((i) => i.type === 'task').length;
    out.push({
      id: `g:${key}`,
      type: 'group',
      level: 1,
      text: b.label,
      words: [],
      meta: [n === 1 ? '1 task' : `${n} tasks`],
      hasChildren: true,
    });
    out.push(...body);
  }
  return out;
}

function buildView(index, state, opts = {}) {
  const today = opts.today || new Date();
  let sortedBy = null;
  const views = allViews(state);
  const wanted = opts.view === 'mylist' ? 'list:mylist' : opts.view;
  const view = views.some((v) => v.id === wanted) ? wanted : 'open';
  const def = views.find((v) => v.id === view);
  const match = matcher(opts.q);
  const showCompleted = !!opts.showCompleted;
  const ctx = { today, showCompleted, match };
  let items;

  if (view === 'triage') {
    const list = untriaged(index, state, { changedOnly: !!opts.changedOnly }).filter(match);
    const files = [...new Map(list.map((u) => [u.file, u])).values()].sort((a, b) => b.fileMtime - a.fileMtime || a.fileLabel.localeCompare(b.fileLabel));
    const dismissed = state.dismissed || {};
    items = [];
    for (const first of files) {
      const todo = list.filter((x) => x.file === first.file);
      const total = todo.length;
      items.push({ id: `f:${first.file}`, type: 'group', level: 1, text: first.fileLabel, words: [], meta: [total === 1 ? '1 line to review' : `${total} lines to review`], hasChildren: true, file: first.file });
      // The whole file in order: tasks and reviewed notes are shown for context, only the unmarked lines need a decision.
      const lines = [
        ...index.tasks.filter((t) => t.file === first.file),
        ...index.unmarked.filter((u) => u.file === first.file),
      ].sort((a, b) => a.lineIndex - b.lineIndex);
      let pos = 0;
      for (const u of lines) {
        const known = u.kind === 'task';
        if (known && u.flags.done && !showCompleted) continue;
        const reviewed = !known && (dismissed[u.file] || []).includes(u.textHash);
        const it = describe(u, today, 2, { hideFile: true, hideGroup: false });
        it.meta = it.meta.filter((m) => !/^\d+ notes?$/.test(m));
        it.meta.push(`Line ${u.line}`);
        if (known) {
          it.words = [...it.words, 'Already a task'];
        } else if (reviewed) {
          it.words = ['Note', 'Reviewed'];
          if (u.attachedTo) it.meta.push(`Attached to ${u.attachedTo}`);
        } else {
          pos += 1;
          it.meta.push(`${pos} of ${total} to review in this file`);
        }
        it.known = known || reviewed;
        if (known) it.meta.push('No action needed');
        it.file = u.file;
        items.push(it);
      }
    }
  } else if (view === 'lists') {
    const lists = (state.lists || []).filter((l) => match({ text: l.name, group: l.folder || '', fileLabel: '', notes: [], jira: null, due: null, checkin: null }));
    const folders = [...new Set(lists.map((l) => l.folder || ''))].sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0) || a.localeCompare(b, undefined, { sensitivity: 'base' }));
    items = [];
    for (const f of folders) {
      const here = lists.filter((l) => (l.folder || '') === f);
      items.push({ id: `g:${f}`, type: 'group', level: 1, text: f || 'No folder', words: [], meta: [here.length === 1 ? '1 list' : `${here.length} lists`], hasChildren: true });
      for (const l of here) {
        const n = listTasks(index, state, l.id).filter((x) => !x.flags.done).length;
        const file = l.file ? index.files.find((x) => x.file === l.file) : null;
        items.push({ id: `list:${l.id}`, type: 'list', listId: l.id, level: 2, text: l.name, words: [], meta: [n === 1 ? '1 open item' : `${n} open items`, file ? `Notes file ${file.label}` : 'No notes file'], hasChildren: false, flags: {}, notes: [] });
      }
    }
  } else if (view === 'schedule') {
    const byId = new Map(index.tasks.map((t) => [t.id, t]));
    const all = scheduled(index, today).filter((e) => match(e.t));
    items = [];
    for (const label of ['Overdue', 'Today', 'This week', 'Later']) {
      const here = all.filter((e) => scheduleBucket(e.iso, today) === label);
      if (!here.length) continue;
      items.push({ id: `g:${label}`, type: 'group', level: 1, text: label, words: [], meta: [here.length === 1 ? '1 task' : `${here.length} tasks`], hasChildren: true });
      for (const e of here) {
        const p = e.t.parentId ? byId.get(e.t.parentId) : null;
        items.push(describe(e.t, today, 2, { parentText: p ? p.text : null }));
      }
    }
  } else if (def.isList) {
    const list = (state.lists || []).find((l) => l.id === view.slice(5));
    items = sortListItems(listTasks(index, state, list.id), list, state)
      .filter((t) => (showCompleted || !t.flags.done) && match(t))
      .map((t) => {
        if (t.kind !== 'task') {
          const n = describe(t, today, 1, { hideGroup: true });
          return { ...n, type: 'note', words: ['Note'], meta: n.meta.filter((m) => !/^File /.test(m)).concat(`File ${t.fileLabel}, line ${t.line}`) };
        }
        const p = t.parentId ? index.get(t.parentId) : null;
        return describe(t, today, 1, { parentText: p ? p.text : null });
      });
  } else if (view === 'open') {
    items = buildHierarchy(index, ctx, null);
  } else if (view === 'file') {
    items = buildHierarchy(index, ctx, (t) => ({ key: t.fileLabel, label: t.fileLabel }));
    items.forEach((i) => {
      if (i.type === 'task') i.meta = i.meta.filter((m) => !m.startsWith('File '));
    });
  } else if (view === 'group') {
    items = buildHierarchy(index, ctx, (t) => ({ key: t.group.toLowerCase(), label: t.group || 'No group' }));
  } else {
    const pred = predicates(today)[view];
    let list = index.tasks.filter((t) => pred(t) && match(t) && (view === 'completed' || showCompleted || !t.flags.done));
    if (view === 'due') list = [...list].sort((a, b) => a.due.localeCompare(b.due) || a.fileLabel.localeCompare(b.fileLabel) || a.line - b.line);
    if (view === 'completed') list = [...list].sort((a, b) => (b.doneDate || '').localeCompare(a.doneDate || ''));
    const byId = new Map(index.tasks.map((t) => [t.id, t]));
    items = list.map((t) => {
      const p = t.parentId ? byId.get(t.parentId) : null;
      return describe(t, today, 1, { parentText: p ? p.text : null });
    });
  }

  if (view !== 'triage' && (state.lists || []).some((l) => l.keys.length)) {
    for (const i of items) {
      const t = i.type === 'task' ? index.get(i.id) : null;
      const on = t ? state.lists.filter((l) => l.keys.includes(t.listKey)) : [];
      if (on.length) {
        i.lists = on.map((l) => l.id);
        i.meta.unshift(`On ${on.length > 1 ? 'lists' : 'list'}: ${on.map((l) => l.name).join(', ')}`);
      }
    }
  }
  if (view !== 'triage' && view !== 'lists') items = withNoteRows(items);
  if (def.isList) sortedBy = (state.lists || []).find((l) => l.id === view.slice(5)).sort || 'manual';
  const count = view === 'triage' ? items.filter((i) => i.type === 'unmarked' && !i.known).length : items.filter((i) => i.type === 'task' || i.type === 'unmarked').length;
  return { view, title: def.title, items, count: view === 'lists' ? (state.lists || []).length : count, empty: def.empty || 'No open tasks.', rev: index.rev, sortedBy, isList: !!def.isList };
}

module.exports = { listTasks, allViews, VIEWS, buildView, viewCounts, describe, matcher, untriaged, DUE_SOON_DAYS };
