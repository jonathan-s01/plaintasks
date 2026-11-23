(() => {
  'use strict';

  const { api, announce, alertMessage, el } = window.PT;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  // A plain listbox by default: Chrome and Safari give every tree row an expanded or collapsed state,
  // so VoiceOver says "collapsed" even on rows with nothing to open. ?ui=tree brings back the ARIA tree.
  const listMode = params.get('ui') !== 'tree';
  const VIEW_KEYS = { 1: 'open', 2: 'file', 3: 'group', 4: 'schedule', 5: 'waitingMe', 6: 'waitingOthers', 7: 'important', 8: 'inProgress', 9: 'completed', 0: 'triage', '-': 'list:mylist', '=': 'lists' };
  const store = {
    get: (k, d) => {
      try {
        return localStorage.getItem(`plaintasks.${k}`) ?? d;
      } catch {
        return d;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(`plaintasks.${k}`, v);
      } catch {
        /* storage unavailable */
      }
    },
  };

  const st = {
    view: store.get('view', 'open'),
    q: '',
    showCompleted: store.get('completed', '0') === '1',
    model: null,
    summary: null,
    collapsed: new Set(),
    seenNotes: new Set(),
    activeId: null,
    jira: null,
    pendingFocus: null,
    changedOnly: store.get('changed', '0') === '1',
    grab: null,
  };

  // Each view remembers which rows you collapsed, across view switches and reloads.
  const viewMemo = (() => {
    try {
      return JSON.parse(store.get('viewstate', '{}')) || {};
    } catch {
      return {};
    }
  })();
  function saveViewState() {
    viewMemo[st.view] = { c: [...st.collapsed], s: [...st.seenNotes] };
    store.set('viewstate', JSON.stringify(viewMemo));
  }
  function restoreViewState() {
    const m = viewMemo[st.view];
    st.collapsed = new Set(m ? m.c : []);
    st.seenNotes = new Set(m ? m.s : []);
  }
  restoreViewState();

  const SORT_LABELS = { manual: 'manual order', due: 'due date', checkin: 'check-in date', created: 'date added', type: 'type, notes last', name: 'name' };

  const tree = $('tree');
  const itemRole = listMode ? 'option' : 'treeitem';
  tree.setAttribute('role', listMode ? 'listbox' : 'tree');
  tree.setAttribute('aria-labelledby', 'list-heading');
  tree.setAttribute('aria-describedby', 'list-status');
  if (listMode) tree.setAttribute('aria-orientation', 'vertical');

  // ---------- data ----------

  async function loadSummary() {
    st.summary = await api('/api/summary');
    const select = $('view');
    if ([...select.options].map((o) => o.value).join() !== st.summary.views.map((v) => v.id).join()) {
      select.replaceChildren(...st.summary.views.map((v) => el('option', { value: v.id })));
    }
    for (const v of st.summary.views) {
      const opt = [...select.options].find((o) => o.value === v.id);
      opt.textContent = `${v.title} (${v.count})`;
    }
    select.value = st.view;
    const problems = st.summary.problems.length;
    return problems;
  }

  function visibleItems() {
    const out = [];
    let hideBelow = null;
    for (const it of st.model.items) {
      if (hideBelow !== null && it.level > hideBelow) continue;
      hideBelow = null;
      out.push(it);
      if (it.hasChildren && st.collapsed.has(it.id)) hideBelow = it.level;
    }
    return out;
  }

  // ---------- rendering ----------

  function render() {
    const items = st.model.items;
    const vis = visibleItems();
    tree.replaceChildren();
    $('empty').hidden = vis.length > 0;
    $('empty').textContent = vis.length ? '' : st.model.empty;

    // Position within siblings, computed over all items so counts stay stable when collapsed.
    const posinset = new Map();
    const setsize = new Map();
    const stack = [];
    for (const it of items) {
      while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
      const parentKey = stack.length ? stack[stack.length - 1].id : 'root';
      const key = `${parentKey}|${it.level}`;
      const n = (setsize.get(key) || 0) + 1;
      setsize.set(key, n);
      posinset.set(it.id, { n, key });
      stack.push(it);
    }

    if (!vis.some((i) => i.id === st.activeId)) st.activeId = vis.length ? vis[0].id : null;

    for (const it of vis) {
      const pos = posinset.get(it.id);
      const node = el('div', {
        role: itemRole,
        id: `item-${it.id.replace(/[^\w-]/g, '_')}`,
        'data-id': it.id,
        tabindex: it.id === st.activeId ? '0' : '-1',
        class: [it.type === 'group' ? 'group' : '', it.type === 'note' ? 'note' : '', it.type === 'list' ? 'listrow' : '', it.id === st.grab ? 'grabbed' : '', it.due && it.due.state === 'overdue' ? 'overdue' : ''].filter(Boolean).join(' '),
      });
      node.style.setProperty('--level', String(it.level));
      if (listMode) {
        node.setAttribute('aria-selected', it.id === st.activeId ? 'true' : 'false');
      } else {
        node.setAttribute('aria-level', String(it.level));
        node.setAttribute('aria-posinset', String(pos.n));
        node.setAttribute('aria-setsize', String(setsize.get(pos.key)));
        if (it.hasChildren) node.setAttribute('aria-expanded', st.collapsed.has(it.id) ? 'false' : 'true');
      }
      node.append(el('span', { class: 'text', text: `${it.text}. ` }));
      // The kind of row (list, task, subtask, bucket, group, section) is spoken right after the name.
      if (it.typeWord) node.append(el('span', { class: 'sr-only', text: `${it.typeWord}. ` }));
      if (listMode) {
        // Only rows that can open say so.
        const state = [it.level > 1 ? `Level ${it.level}.` : '', it.hasChildren ? (st.collapsed.has(it.id) ? 'Collapsed.' : 'Expanded.') : ''].filter(Boolean).join(' ');
        if (state) node.append(el('span', { class: 'sr-only', text: ` ${state} ` }));
      }
      // Status comes last: name first, then level and whether it opens, then Open, Done and so on.
      if (it.words.length) node.append(el('span', { class: 'words', text: `${it.words.join(', ')}. ` }));
      if (it.meta.length) {
        const meta = el('span', { class: 'meta', text: `${it.meta.join('. ')}.` });
        // Rows speak only status and name; the details are in the Enter dialog. Group and list rows keep their counts.
        if (it.type !== 'group' && it.type !== 'list') meta.setAttribute('aria-hidden', 'true');
        node.append(meta);
      }
      tree.append(node);
    }

    $('list-heading').textContent = st.model.title;
    const gi = st.grab ? vis.findIndex((i) => i.id === st.grab) : -1;
    $('grab-status').hidden = gi < 0;
    $('grab-status').textContent = gi < 0 ? '' : `Reordering "${vis[gi].text}", position ${gi + 1} of ${vis.length}. Up and Down move it. Home and End send it to the top or bottom. Enter or Escape drops it.`;
    const n = st.model.count;
    const noun = st.model.view === 'triage' ? (n === 1 ? 'unmarked line' : 'unmarked lines') : st.model.view === 'lists' ? (n === 1 ? 'list' : 'lists') : n === 1 ? 'task' : 'tasks';
    const sorted = st.model.isList && st.model.sortedBy && st.model.sortedBy !== 'manual' ? `, sorted by ${SORT_LABELS[st.model.sortedBy] || st.model.sortedBy}` : '';
    $('list-status').textContent = `${n} ${noun}${st.model.summary ? `, ${st.model.summary}` : ''}${sorted}${st.q ? ` matching "${st.q}"` : ''}${st.showCompleted && st.model.view !== 'completed' ? ', including completed' : ''}${st.changedOnly && st.model.view === 'triage' ? ', new or changed files only' : ''}.`;
  }

  function nodeFor(id) {
    return [...tree.children].find((c) => c.dataset.id === id) || null;
  }

  function setActive(id, focus = true) {
    st.activeId = id;
    for (const c of tree.children) {
      const on = c.dataset.id === id;
      c.tabIndex = on ? 0 : -1;
      if (listMode) c.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    const node = nodeFor(id);
    if (node && focus) node.focus();
    return node;
  }

  async function loadView({ focusId = null, keepIndex = null, focus = true, announceText = null } = {}) {
    const [model] = await Promise.all([
      api(`/api/view?view=${encodeURIComponent(st.view)}&q=${encodeURIComponent(st.q)}&completed=${st.showCompleted ? 1 : 0}&changed=${st.changedOnly ? 1 : 0}`),
      loadSummary(),
    ]);
    st.model = model;
    if (model.view !== st.view) {
      st.view = model.view;
      store.set('view', st.view);
      $('view').value = st.view;
    }
    // Drop collapsed ids that no longer exist.
    const ids = new Set(model.items.map((i) => i.id));
    if (!st.q) for (const id of [...st.collapsed]) if (!ids.has(id)) st.collapsed.delete(id);
    // Tasks with notes start collapsed the first time they appear. After that the choice is yours.
    for (const it of model.items) {
      if (!it.noteCount || st.seenNotes.has(it.id)) continue;
      st.seenNotes.add(it.id);
      st.collapsed.add(it.id);
    }
    saveViewState();

    const vis = visibleItems();
    let target = null;
    // In the buckets view a task can show once per bucket ("taskId@bucketTaskId"): stay under the same bucket when possible.
    const under = st.activeId && st.activeId.includes('@') ? st.activeId.slice(st.activeId.indexOf('@')) : null;
    const copy = focusId && (vis.find((i) => under && i.id === focusId + under) || vis.find((i) => i.id.startsWith(`${focusId}@`)));
    if (focusId && vis.some((i) => i.id === focusId)) target = focusId;
    else if (copy) target = copy.id;
    else if (keepIndex != null && vis.length) target = vis[Math.min(keepIndex, vis.length - 1)].id;
    else if (st.activeId && vis.some((i) => i.id === st.activeId)) target = st.activeId;
    st.activeId = target || (vis[0] && vis[0].id) || null;
    render();
    if (focus) {
      if (st.activeId) setActive(st.activeId, true);
      else $('empty').focus();
    }
    if (announceText) announce(announceText.replace('{count}', `${model.count}`));
    return model;
  }

  // ---------- actions ----------

  function currentItem() {
    return st.model && st.model.items.find((i) => i.id === st.activeId);
  }

  function activeIndex() {
    return visibleItems().findIndex((i) => i.id === st.activeId);
  }

  let queue = Promise.resolve();
  const enqueue = (fn) => {
    queue = queue.then(fn, fn);
    return queue;
  };

  async function act(op, value, item = currentItem(), list = undefined) {
    if (!item) return undefined;
    return enqueue(() => doAct(op, value, item, list));
  }

  const NOTE_OPS = ['listToggle', 'listMove', 'open'];
  const ADVANCE_OPS = ['todo', 'note', 'exclude', 'done', 'toggleDone', 'waitingOnMe', 'waitingOnOthers', 'important', 'inProgress', 'ongoing', 'indent'];

  function nextTriageId(item, idx) {
    if (item.type !== 'unmarked') return null;
    const vis = visibleItems();
    const nxt = vis.slice(idx + 1).find((i) => i.type === 'unmarked' && !i.known) || vis.find((i) => i.type === 'unmarked' && !i.known && i.id !== item.id);
    return nxt ? nxt.id : null;
  }

  async function doAct(op, value, item, list) {
    const isTask = item.type === 'task' || item.type === 'unmarked';
    if (!isTask && op !== 'dismissFile' && !(item.type === 'note' && NOTE_OPS.includes(op))) {
      announce(item.type === 'tasknote' ? 'That is a note under a task. Select the task to change it or add another note.' : item.type === 'note' ? 'That is a note, not a task. You can remove it from the list, move it, or open its file.' : item.type === 'list' ? 'That is a list. Press Enter to open it.' : 'That is a heading, not a task.');
      return;
    }
    const idx = activeIndex();
    const nextId = st.view === 'triage' && ADVANCE_OPS.includes(op) ? nextTriageId(item, idx) : null;
    try {
      const res = await api('/api/action', { method: 'POST', body: { id: item.id, op, value, list } });
      announce(res.message);
      if (op === 'open') return;
      if (op === 'addNote' || (value && value.note)) {
        // Show the note you just added.
        for (const id of [item.id, res.focusId]) if (id) {
          st.seenNotes.add(id);
          st.collapsed.delete(id);
        }
      }
      await loadView({ focusId: nextId || res.focusId, keepIndex: idx });
    } catch (err) {
      alertMessage(err.message);
      if (err.status === 409 || err.status === 404) await loadView({ keepIndex: idx });
    }
  }

  async function undo() {
    const idx = activeIndex();
    try {
      const res = await api('/api/undo', { method: 'POST', body: {} });
      announce(res.message);
      await loadView({ focusId: res.focusId, keepIndex: idx });
    } catch (err) {
      alertMessage(err.message);
    }
  }

  async function switchView(id, { fromSelect = false } = {}) {
    saveViewState();
    st.view = id;
    store.set('view', id);
    restoreViewState();
    st.grab = null;
    st.activeId = null;
    // Say which view this is straight away, before the list loads and focus lands on its first item.
    const known = st.summary && st.summary.views.find((v) => v.id === id);
    if (!fromSelect && known) announce(`${known.title}.`);
    const model = await loadView({ focus: !fromSelect });
    $('view').value = id;
    announce(`${model.title}. ${$('list-status').textContent}`);
  }

  async function toggleCompleted() {
    st.showCompleted = !st.showCompleted;
    store.set('completed', st.showCompleted ? '1' : '0');
    $('toggle-completed').setAttribute('aria-pressed', String(st.showCompleted));
    $('toggle-completed').textContent = st.showCompleted ? 'Hide completed' : 'Show completed';
    const model = await loadView({ focus: document.activeElement === document.body || tree.contains(document.activeElement) });
    announce(`${st.showCompleted ? 'Showing' : 'Hiding'} completed tasks. ${model.count} ${model.count === 1 ? 'task' : 'tasks'}.`);
  }

  // ---------- dialogs ----------

  function openDialog(dlg, returnId) {
    dlg.returnId = returnId;
    dlg.showModal();
  }

  function closeDialog(dlg) {
    if (dlg.open) dlg.close();
  }

  // Help starts at its heading, so VoiceOver reads it from the top instead of jumping to Close.
  function openHelp(returnId) {
    openDialog($('help-dialog'), returnId);
    $('help-title').focus();
  }

  for (const dlg of document.querySelectorAll('dialog')) {
    dlg.addEventListener('close', () => {
      if (dlg.returnId && st.model && !tree.contains(document.activeElement)) {
        const node = nodeFor(dlg.returnId);
        if (node) setActive(dlg.returnId, true);
      }
    });
  }

  const FLAG_LABELS = [
    ['waitingOnMe', 'Mark waiting on me', 'Clear waiting on me', 'less than'],
    ['waitingOnOthers', 'Mark waiting on someone else', 'Clear waiting on someone else', 'greater than'],
    ['important', 'Mark important', 'Clear important', 'asterisk'],
    ['inProgress', 'Mark in progress', 'Clear in progress', 'percent'],
    ['ongoing', 'Mark ongoing', 'Clear ongoing', 'b'],
  ];

  async function openActions() {
    const item = currentItem();
    if (!item) return;
    if (item.type === 'group') {
      toggleExpand(item);
      return;
    }
    if (item.type === 'tasknote') {
      announce('That is a note under a task. Select the task to change it or add another note.');
      return;
    }
    if (item.type === 'list') {
      switchView(`list:${item.listId}`);
      return;
    }
    const dlg = $('actions-dialog');
    $('actions-title').textContent = item.text;
    $('actions-details').textContent = [item.words.join(', '), ...item.meta].filter(Boolean).join('. ') + '.';
    const notes = $('actions-notes');
    notes.replaceChildren();
    if (item.notes && item.notes.length) {
      notes.append(el('h3', { text: 'Notes' }), el('ul', {}, ...item.notes.map((n) => el('li', { text: n }))));
    }
    const box = $('actions-buttons');
    box.replaceChildren();
    const add = (label, fn) => box.append(el('button', { type: 'button', text: label, onclick: async () => { closeDialog(dlg); await fn(); } }));
    if (item.type === 'note') {
      add('Remove from this list', () => act('listToggle', null, item, curListId()));
      if (curListId()) {
        add('Move up (alt and up)', () => act('listMove', 'up', item, curListId()));
        add('Move down (alt and down)', () => act('listMove', 'down', item, curListId()));
      }
      add('Open source file (o)', () => act('open', null, item));
      openDialog(dlg, item.id);
      box.querySelector('button').focus();
      return;
    }
    if (item.type === 'unmarked') {
      const ctx = item.context || { before: [], after: [] };
      if (ctx.before.length || ctx.after.length) {
        notes.append(el('h3', { text: 'Nearby lines' }), el('ul', {}, ...ctx.before.map((n) => el('li', { text: `Before: ${n}` })), el('li', { text: `This line: ${item.text}` }), ...ctx.after.map((n) => el('li', { text: `After: ${n}` }))));
      }
      add('Mark as to-do (a)', () => act('todo'));
      add('Mark as to-do and choose lists (l)', () => listKey());
      add('Mark as a note (s)', () => act('note'));
      add('Make a subtask of the task above (tab)', () => act('indent'));
      add('Mark all remaining lines in this file as notes (shift and s)', () => act('dismissFile', null, { id: `f:${fileOf(item)}`, type: 'group' }));
      add('Mark this file as reviewed (shift and r)', () => act('reviewFile'));
    } else {
      add('Add a note to this task (s)', () => openNote());
      add('Make a subtask of the task above (tab)', () => act('indent'));
      add('Move up a level (shift and tab)', () => act('outdent'));
      add('Convert to a note', () => act('note'));
      add('Choose lists for this task (l)', () => listKey());
      if (item.type === 'task') add('Choose buckets (y)', () => openBuckets());
      if (curListId()) {
        add('Move up (alt and up)', () => act('listMove', 'up'));
        add('Move down (alt and down)', () => act('listMove', 'down'));
        add('Move to top', () => act('listMove', 'top'));
        add('Move to bottom', () => act('listMove', 'bottom'));
        add('Reorder with arrow keys (g)', () => startGrab());
      }
    }
    add(item.flags.done ? 'Reopen (plus)' : 'Mark done (plus)', () => act('toggleDone'));
    for (const [flag, on, off, key] of FLAG_LABELS) add(`${item.flags[flag] ? off : on} (${key})`, () => act(flag));
    if (item.type === 'task') {
      add(item.pickedNow ? 'Take out of My Day (t)' : 'Pick for today (t)', () => act('today'));
      add(`Priority: ${item.priority === 'high' ? 'High' : item.priority === 'low' ? 'Low' : 'Medium'}. Press to cycle (shift and p)`, () => act('priority'));
      add('Blocked by other tasks (shift and b)', () => openBlockers());
    }
    add('Due date and check-in (d)', () => openDue());
    add('Open source file (o)', () => act('open'));
    add('Jira (j)', () => openJira());
    add('Undo last change (u)', () => undo());
    openDialog(dlg, item.id);
    box.querySelector('button').focus();
  }

  function fileOf(item) {
    const g = st.model.items.slice(0, st.model.items.indexOf(item)).reverse().find((i) => i.type === 'group' && i.file);
    return g ? g.file : '';
  }

  $('actions-close').addEventListener('click', () => closeDialog($('actions-dialog')));

  const whenText = (d) => (d ? `${d.iso}${d.time ? ` ${d.time}` : ''}` : '');
  let dueInitial = { due: '', checkin: '' };

  function openDue(focusCheckin = false) {
    const item = currentItem();
    if (!item || item.type === 'group' || item.type === 'list' || item.type === 'note') return;
    $('due-task').textContent = item.text;
    dueInitial = { due: whenText(item.due), checkin: whenText(item.checkin) };
    $('due-input').value = dueInitial.due;
    $('checkin-input').value = dueInitial.checkin;
    $('due-error').textContent = '';
    openDialog($('due-dialog'), item.id);
    const f = $(focusCheckin ? 'checkin-input' : 'due-input');
    f.focus();
    f.select();
  }

  $('due-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = currentItem();
    const idx = activeIndex();
    const value = {};
    if ($('due-input').value.trim() !== dueInitial.due) value.due = $('due-input').value;
    if ($('checkin-input').value.trim() !== dueInitial.checkin) value.checkin = $('checkin-input').value;
    if (!Object.keys(value).length) {
      closeDialog($('due-dialog'));
      announce('No change.');
      return;
    }
    try {
      const res = await api('/api/action', { method: 'POST', body: { id: item.id, op: 'dates', value } });
      closeDialog($('due-dialog'));
      announce(res.message);
      await loadView({ focusId: res.focusId, keepIndex: idx });
    } catch (err) {
      $('due-error').textContent = err.message;
      $('due-input').focus();
    }
  });
  $('due-cancel').addEventListener('click', () => closeDialog($('due-dialog')));

  async function openJira() {
    const item = currentItem();
    if (!item || item.type === 'group') return;
    $('jira-task').textContent = item.text;
    $('jira-key').value = item.jira || '';
    $('jira-result').textContent = '';
    if (!st.jira) {
      try {
        st.jira = (await api('/api/config')).jira || { none: true };
      } catch {
        st.jira = { none: true };
      }
    }
    const configured = !st.jira.none && st.summary && st.summary.jiraConfigured;
    $('jira-project').value = (st.jira && st.jira.project) || '';
    $('jira-type').value = (st.jira && st.jira.issueType) || 'Task';
    $('jira-status').disabled = !configured;
    $('jira-create-group').disabled = !configured;
    $('jira-setup-hint').hidden = configured;
    openDialog($('jira-dialog'), item.id);
    $('jira-key').focus();
  }

  const jiraAct = async (fn) => {
    try {
      await fn();
    } catch (err) {
      $('jira-result').textContent = err.message;
    }
  };
  $('jira-link').addEventListener('click', () => jiraAct(async () => {
    const item = currentItem();
    const idx = activeIndex();
    const key = $('jira-key').value.trim();
    if (!key) throw new Error('Enter an issue key such as ABC-123, or use Remove link.');
    const res = await api('/api/action', { method: 'POST', body: { id: item.id, op: 'jira', value: key } });
    closeDialog($('jira-dialog'));
    announce(res.message);
    await loadView({ focusId: res.focusId, keepIndex: idx });
  }));
  $('jira-unlink').addEventListener('click', () => jiraAct(async () => {
    const item = currentItem();
    const idx = activeIndex();
    const res = await api('/api/action', { method: 'POST', body: { id: item.id, op: 'jira', value: '' } });
    closeDialog($('jira-dialog'));
    announce(res.message);
    await loadView({ focusId: res.focusId, keepIndex: idx });
  }));
  $('jira-status').addEventListener('click', () => jiraAct(async () => {
    const key = $('jira-key').value.trim();
    if (!key) throw new Error('Enter an issue key first.');
    $('jira-result').textContent = 'Checking Jira.';
    const issue = await api(`/api/jira/issue?key=${encodeURIComponent(key)}`);
    $('jira-result').textContent = `${issue.key} is ${issue.status}. ${issue.summary}`;
  }));
  $('jira-create').addEventListener('click', () => jiraAct(async () => {
    const item = currentItem();
    const idx = activeIndex();
    $('jira-result').textContent = 'Creating the issue.';
    const res = await api('/api/jira/create', { method: 'POST', body: { id: item.id, project: $('jira-project').value.trim(), issueType: $('jira-type').value.trim() } });
    closeDialog($('jira-dialog'));
    announce(res.message);
    await loadView({ focusId: res.focusId, keepIndex: idx });
  }));
  $('jira-close').addEventListener('click', () => closeDialog($('jira-dialog')));

  $('help-btn').addEventListener('click', () => openHelp(null));
  $('help-close').addEventListener('click', () => closeDialog($('help-dialog')));
  // Escape closes help wherever focus or the VoiceOver cursor is, not only when the dialog itself has focus.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('help-dialog').open) return;
    e.preventDefault();
    e.stopPropagation();
    closeDialog($('help-dialog'));
  }, true);

  // ---------- notes, new tasks, sorting, master file ----------

  const post = (body) => api('/api/action', { method: 'POST', body });

  async function finish(res, idx) {
    announce(res.message);
    await loadView({ focusId: res.focusId, keepIndex: idx });
  }

  let noteCtx = null;

  function openNote() {
    const item = currentItem();
    if (!item || item.type !== 'task') {
      announce('Select a task to add a note to it.');
      return;
    }
    noteCtx = { mode: 'task', item };
    $('note-title').textContent = 'Add a note to this task';
    $('note-task').textContent = item.text;
    $('note-hint').textContent = 'The note is written into the file under the task, after any notes it already has.';
    $('note-stamp').parentElement.hidden = false;
    showNote(item.id);
  }

  function openListNote() {
    const id = curListId();
    if (!id) {
      announce('Shift and n adds a note to a list. Open a list first, for example with minus.');
      return;
    }
    noteCtx = { mode: 'list', id };
    $('note-title').textContent = `Add a note to ${listName(id)}`;
    $('note-task').textContent = '';
    $('note-hint').textContent = 'This is a note, not a task. It is saved with today\'s date in the list\'s notes file.';
    $('note-stamp').parentElement.hidden = true;
    showNote(st.activeId);
  }

  function showNote(returnId) {
    $('note-input').value = '';
    $('note-error').textContent = '';
    $('note-stamp').checked = true;
    if (noteCtx.mode !== 'status') $('note-save').textContent = 'Add note';
    openDialog($('note-dialog'), returnId);
    $('note-input').focus();
  }

  $('note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const idx = activeIndex();
    const text = $('note-input').value;
    if (noteCtx.mode === 'status') {
      const { item, op } = noteCtx;
      closeDialog($('note-dialog'));
      await act(op, text.trim() ? { note: text } : undefined, item, curListId() || undefined);
      return;
    }
    try {
      const body = noteCtx.mode === 'list'
        ? { op: 'listNote', value: { text }, list: noteCtx.id }
        : { id: noteCtx.item.id, op: 'addNote', value: { text, stamp: $('note-stamp').checked }, list: curListId() || undefined };
      const res = await post(body);
      closeDialog($('note-dialog'));
      await finish(res, idx);
    } catch (err) {
      $('note-error').textContent = err.message;
      $('note-input').focus();
    }
  });
  $('note-cancel').addEventListener('click', () => closeDialog($('note-dialog')));

  const nt = { search: true, seq: 0, timer: null };

  function ntOptions(results, text) {
    const sel = $('nt-results');
    const opts = results.map((r) => el('option', { value: `t:${r.id}`, text: `${r.text} (${r.fileLabel})` }));
    opts.push(el('option', { value: 'create', text: text ? `Create new task: ${text}` : 'Create new task' }));
    sel.replaceChildren(...opts);
    sel.selectedIndex = 0;
  }

  async function ntSearch() {
    const text = $('nt-text').value.trim();
    const mine = ++nt.seq;
    if (!text) {
      ntOptions([], '');
      return;
    }
    try {
      const { results } = await api(`/api/search?q=${encodeURIComponent(text)}`);
      if (mine !== nt.seq) return;
      ntOptions(results, text);
      announce(results.length ? `${results.length} matching ${results.length === 1 ? 'task' : 'tasks'}. Press Down to choose. The last choice creates a new task.` : 'No matching tasks. Enter creates a new task.');
    } catch (err) {
      $('nt-error').textContent = err.message;
    }
  }

  function openNewTask(search) {
    nt.search = search;
    nt.seq += 1;
    $('newtask-title').textContent = search ? 'Add a task' : 'Create a new task';
    $('nt-hint').textContent = search
      ? 'Type to search your tasks. Press Down to choose a match to add to a list, or the last choice to create a new task. Enter confirms.'
      : 'The task is added to the end of the master list file with the to-do symbol.';
    $('nt-results-wrap').hidden = !search;
    $('nt-go').textContent = search ? 'Add' : 'Create task';
    $('nt-text').value = '';
    $('nt-error').textContent = '';
    ntOptions([], '');
    const cur = curListId();
    $('nt-list').replaceChildren(el('option', { value: '', text: 'No list' }), ...st.summary.lists.map((l) => el('option', { value: l.id, text: l.name })));
    $('nt-list').value = cur || '';
    openDialog($('newtask-dialog'), st.activeId);
    $('nt-text').focus();
  }

  $('nt-text').addEventListener('input', () => {
    if (!nt.search) return;
    clearTimeout(nt.timer);
    nt.timer = setTimeout(ntSearch, 150);
  });
  $('nt-text').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && nt.search) {
      e.preventDefault();
      clearTimeout(nt.timer);
      $('nt-results').focus();
    }
  });
  $('nt-results').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('newtask-form').requestSubmit();
    } else if (e.key === 'ArrowUp' && $('nt-results').selectedIndex === 0) {
      e.preventDefault();
      $('nt-text').focus();
    }
  });
  $('nt-cancel').addEventListener('click', () => closeDialog($('newtask-dialog')));

  $('newtask-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearTimeout(nt.timer);
    const idx = activeIndex();
    const text = $('nt-text').value.trim();
    const list = $('nt-list').value || undefined;
    let choice = nt.search ? $('nt-results').value : 'create';
    if (nt.search && !text) choice = 'create';
    try {
      if (choice.startsWith('t:')) {
        if (!list) {
          $('nt-error').textContent = 'Choose a list to add the task to, or choose Create new task.';
          $('nt-list').focus();
          return;
        }
        const res = await post({ id: choice.slice(2), op: 'listAdd', list });
        closeDialog($('newtask-dialog'));
        await finish(res, idx);
        return;
      }
      if (!text) {
        $('nt-error').textContent = 'Type the new task first.';
        $('nt-text').focus();
        return;
      }
      const res = await post({ op: 'newTask', value: { text }, list });
      closeDialog($('newtask-dialog'));
      await finish(res, idx);
    } catch (err) {
      if (err.code === 'no-master') {
        closeDialog($('newtask-dialog'));
        openMaster(() => openNewTask(nt.search), err.message);
        return;
      }
      $('nt-error').textContent = err.message;
      $('nt-text').focus();
    }
  });

  function openSort() {
    const id = curListId();
    if (!id) {
      announce('Sorting works in a list. Open a list first, for example with minus.');
      return;
    }
    const cur = (st.model && st.model.sortedBy) || 'manual';
    for (const r of $('sort-form').querySelectorAll('input[name=sort]')) r.checked = r.value === cur;
    $('sort-title').textContent = `Sort ${listName(id)}`;
    openDialog($('sort-dialog'), st.activeId);
    $('sort-form').querySelector('input:checked').focus();
  }

  $('sort-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = $('sort-form').querySelector('input:checked').value;
    closeDialog($('sort-dialog'));
    const idx = activeIndex();
    try {
      await finish(await post({ op: 'listSort', value: mode, list: curListId() }), idx);
    } catch (err) {
      alertMessage(err.message);
    }
  });
  $('sort-cancel').addEventListener('click', () => closeDialog($('sort-dialog')));

  let masterDone = null;

  async function openMaster(onDone, why) {
    masterDone = onDone || null;
    $('master-error').textContent = '';
    let cfg;
    try {
      cfg = await api('/api/config');
    } catch (err) {
      alertMessage(err.message);
      return;
    }
    $('master-current').textContent = why || (cfg.masterLabel ? `Currently: ${cfg.masterLabel}.` : 'No file chosen yet.');
    $('master-file').replaceChildren(...cfg.files.map((f) => el('option', { value: f.file, text: f.label })));
    $('master-folder').replaceChildren(...cfg.folders.map((f) => el('option', { value: f.path, text: f.path })));
    if (cfg.masterFile) $('master-file').value = cfg.masterFile;
    openDialog($('master-dialog'), st.activeId);
    $('master-file').focus();
  }

  async function masterSave(body) {
    try {
      const res = await api('/api/master', { method: 'POST', body });
      closeDialog($('master-dialog'));
      announce(res.message);
      await loadSummary();
      if (masterDone) {
        const fn = masterDone;
        masterDone = null;
        fn();
      }
    } catch (err) {
      $('master-error').textContent = err.message;
    }
  }
  $('master-use').addEventListener('click', () => {
    if ($('master-file').value) masterSave({ path: $('master-file').value });
    else $('master-error').textContent = 'There are no files to choose from. Create a new one instead.';
  });
  $('master-create').addEventListener('click', () => {
    if ($('master-folder').value) masterSave({ create: { folder: $('master-folder').value, name: $('master-name').value } });
    else $('master-error').textContent = 'Add a folder in Settings first.';
  });
  $('master-close').addEventListener('click', () => {
    masterDone = null;
    closeDialog($('master-dialog'));
  });

  // ---------- keyboard ----------

  function toggleExpand(item, expand) {
    if (!item.hasChildren) return false;
    const collapsed = st.collapsed.has(item.id);
    const want = expand === undefined ? collapsed : expand;
    if (want === !collapsed) return false;
    if (want) st.collapsed.delete(item.id);
    else st.collapsed.add(item.id);
    saveViewState();
    render();
    setActive(item.id, true);
    return true;
  }

  function move(delta, absolute) {
    const vis = visibleItems();
    if (!vis.length) return;
    const i = absolute != null ? absolute : Math.max(0, Math.min(vis.length - 1, activeIndex() + delta));
    setActive(vis[i].id, true);
  }

  function curListId() {
    return st.view.startsWith('list:') ? st.view.slice(5) : null;
  }

  function listName(id) {
    const l = st.summary && st.summary.lists.find((x) => x.id === id);
    return l ? l.name : 'the list';
  }

  function inMyList() {
    return curListId() !== null;
  }

  // One list: l toggles straight away. Several lists: l asks which ones.
  function listKey() {
    const item = currentItem();
    const triageLine = st.view === 'triage' && item && item.type === 'unmarked';
    if (!item || (item.type !== 'task' && !triageLine)) {
      announce('Select a task first.');
      return undefined;
    }
    if (triageLine) return openLists();
    if (st.summary.lists.length === 1) return act('listToggle', null, item, st.summary.lists[0].id);
    return openLists();
  }

  function quickList() {
    const item = currentItem();
    if (!item || item.type !== 'task') return undefined;
    const id = curListId() || st.summary.lastList;
    return act('listToggle', null, item, id);
  }

  function renderListChoices(box, item, checkedIds) {
    box.replaceChildren(...st.summary.lists.map((l, i) => el('div', { class: 'row' },
      el('input', { type: 'checkbox', id: `lc-${i}`, value: l.id, checked: checkedIds.includes(l.id) }),
      el('label', { for: `lc-${i}`, text: l.name }))));
  }

  function openLists() {
    const item = currentItem();
    if (!item || (item.type !== 'task' && item.type !== 'unmarked')) return;
    $('lists-task').textContent = item.type === 'unmarked' ? `${item.text}. It will be marked as a to-do.` : item.text;
    $('lists-new').value = '';
    $('lists-error').textContent = '';
    renderListChoices($('lists-choices'), item, item.lists || []);
    openDialog($('lists-dialog'), item.id);
    const first = $('lists-choices').querySelector('input');
    if (first) first.focus();
  }

  async function saveLists(e) {
    e.preventDefault();
    const item = currentItem();
    const idx = activeIndex();
    const ids = [...$('lists-choices').querySelectorAll('input:checked')].map((c) => c.value);
    const triage = item.type === 'unmarked';
    const nextId = triage ? nextTriageId(item, idx) : null;
    try {
      const res = await api('/api/action', { method: 'POST', body: { id: item.id, op: triage ? 'todoList' : 'listSet', value: { ids, newName: $('lists-new').value } } });
      closeDialog($('lists-dialog'));
      announce(res.message);
      await loadView({ focusId: nextId || res.focusId, keepIndex: idx });
    } catch (err) {
      $('lists-error').textContent = err.message;
      $('lists-new').focus();
    }
  }
  $('lists-form').addEventListener('submit', saveLists);
  speakOnHover($('lists-choices'));
  // Up and Down move through the lists, Space ticks one, Enter saves.
  $('lists-form').addEventListener('keydown', (e) => {
    const stops = [...$('lists-choices').querySelectorAll('input'), $('lists-new')];
    const i = stops.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const to = stops[i + (e.key === 'ArrowDown' ? 1 : -1)];
      e.preventDefault();
      if (to) to.focus();
    } else if (e.key === 'Enter' && document.activeElement.type === 'checkbox') {
      e.preventDefault();
      $('lists-form').requestSubmit();
    }
  });
  $('lists-cancel').addEventListener('click', () => closeDialog($('lists-dialog')));

  // ---------- buckets ----------

  // Moving the mouse over a choice focuses its checkbox, so VoiceOver reads it. Keys work as before.
  function speakOnHover(box) {
    box.addEventListener('pointermove', (e) => {
      const row = e.target.closest && e.target.closest('.row');
      const input = row && box.contains(row) ? row.querySelector('input') : null;
      if (input && document.activeElement !== input) input.focus({ preventScroll: true });
    });
  }

  let bucketCtx = null;

  /** y: on a task, choose its buckets; on a file's row (By file, triage, All lists), choose the file's default buckets. */
  async function openBuckets(forFile, returnSel) {
    const item = currentItem();
    const file = forFile || (item && (item.type === 'group' || item.type === 'list') ? item.file : null);
    if (!file && (!item || item.type !== 'task')) {
      if (item && (item.type === 'group' || item.type === 'list')) announce('The y key sets default buckets on a file. Open the By file view (v) or All lists, then press y on a file or list that has one.');
      return;
    }
    let data;
    try {
      data = await api(file ? `/api/buckets?file=${encodeURIComponent(file)}` : `/api/buckets?id=${encodeURIComponent(item.id)}`);
    } catch (err) {
      alertMessage(err.message);
      return;
    }
    bucketCtx = { file, id: file ? null : item.id, back: st.activeId, returnSel: returnSel || null };
    $('buckets-title').textContent = file ? 'Default buckets for a list' : 'Choose buckets';
    $('buckets-legend').textContent = file ? 'Tasks in this file without buckets of their own inherit' : 'This task is in';
    $('buckets-task').textContent = file
      ? `${data.task}. Saved on the file's first line.`
      : `${data.task}.${data.inherited.length ? ` Without buckets of its own it inherits from ${data.inheritedFrom}. Ticking exactly those again removes its own.` : ''}`;
    $('buckets-error').textContent = '';
    $('buckets-empty').hidden = data.buckets.length > 0;
    $('buckets-choices').replaceChildren(...data.buckets.map((b, i) => el('div', { class: 'row' },
      el('input', { type: 'checkbox', id: `gc-${i}`, value: b.id, checked: b.checked }),
      el('label', { for: `gc-${i}`, text: `${b.text}${b.done ? ' (done)' : ''}${b.inherited ? `, inherited from ${data.inheritedFrom.replace(/:.*$/, '')}` : ''}, ${b.count === 1 ? '1 task' : `${b.count} tasks`}` }))));
    openDialog($('buckets-dialog'), returnSel ? null : st.activeId);
    const first = $('buckets-choices').querySelector('input') || $('buckets-cancel');
    first.focus();
  }

  async function saveBuckets(e) {
    e.preventDefault();
    const idx = activeIndex();
    const ids = [...$('buckets-choices').querySelectorAll('input:checked')].map((c) => c.value);
    const body = bucketCtx.file
      ? { id: `f:${bucketCtx.file}`, op: 'listBucketSet', value: { ids } }
      : { id: bucketCtx.id, op: 'bucketSet', value: { ids } };
    try {
      const res = await api('/api/action', { method: 'POST', body });
      closeDialog($('buckets-dialog'));
      announce(res.message);
      if ($('manage-dialog').open) {
        await loadView({ focus: false });
        renderManage();
        const back = bucketCtx.returnSel && document.querySelector(bucketCtx.returnSel);
        if (back) back.focus();
      } else await loadView({ focusId: res.focusId || bucketCtx.back, keepIndex: idx });
    } catch (err) {
      $('buckets-error').textContent = err.message;
      const first = $('buckets-choices').querySelector('input');
      if (first) first.focus();
    }
  }
  $('buckets-form').addEventListener('submit', saveBuckets);
  speakOnHover($('buckets-choices'));
  // Up and Down move through the buckets, Space ticks one, Enter saves.
  $('buckets-form').addEventListener('keydown', (e) => {
    const stops = [...$('buckets-choices').querySelectorAll('input')];
    const i = stops.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const to = stops[i + (e.key === 'ArrowDown' ? 1 : -1)];
      e.preventDefault();
      if (to) to.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      $('buckets-form').requestSubmit();
    }
  });
  $('buckets-cancel').addEventListener('click', () => closeDialog($('buckets-dialog')));
  // Opened from Manage lists: focus goes back to that list's button.
  $('buckets-dialog').addEventListener('close', () => {
    const back = bucketCtx && bucketCtx.returnSel ? document.querySelector(bucketCtx.returnSel) : null;
    if (back) back.focus();
  });

  // ---------- blocked by ----------

  async function openBlockers() {
    const item = currentItem();
    if (!item || item.type !== 'task') return;
    let data;
    try {
      data = await api(`/api/blockers?id=${encodeURIComponent(item.id)}`);
    } catch (err) {
      alertMessage(err.message);
      return;
    }
    $('blockers-task').textContent = item.text;
    $('blockers-error').textContent = '';
    $('blockers-filter').value = '';
    $('blockers-empty').hidden = data.tasks.length > 0;
    const rows = [...data.tasks].sort((a, b) => Number(b.linked) - Number(a.linked));
    $('blockers-choices').replaceChildren(...rows.map((c, i) => el('div', { class: 'row', 'data-text': `${c.text} ${c.file}`.toLowerCase() },
      el('input', { type: 'checkbox', id: `bc-${i}`, value: c.id, checked: c.linked }),
      el('label', { for: `bc-${i}`, text: `${c.text}${c.done ? ' (done)' : ''}, list ${c.file}, line ${c.line}` }))));
    updateBlockerCount();
    openDialog($('blockers-dialog'), item.id);
    $('blockers-filter').focus();
  }

  const visibleBlockers = () => [...$('blockers-choices').querySelectorAll('.row:not([hidden]) input')];

  function updateBlockerCount() {
    const all = $('blockers-choices').querySelectorAll('input').length;
    const shown = visibleBlockers().length;
    const ticked = $('blockers-choices').querySelectorAll('input:checked').length;
    $('blockers-count').textContent = `${ticked} ticked. Showing ${shown} of ${all} tasks.`;
  }

  $('blockers-filter').addEventListener('input', () => {
    const terms = $('blockers-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const row of $('blockers-choices').querySelectorAll('.row')) row.hidden = !terms.every((t) => row.dataset.text.includes(t));
    updateBlockerCount();
  });
  $('blockers-choices').addEventListener('change', updateBlockerCount);
  speakOnHover($('blockers-choices'));

  async function saveBlockers(e) {
    e.preventDefault();
    const item = currentItem();
    const idx = activeIndex();
    const ids = [...$('blockers-choices').querySelectorAll('input:checked')].map((c) => c.value);
    try {
      const res = await api('/api/action', { method: 'POST', body: { id: item.id, op: 'blockSet', value: { ids } } });
      closeDialog($('blockers-dialog'));
      announce(res.message);
      await loadView({ focusId: res.focusId, keepIndex: idx });
    } catch (err) {
      $('blockers-error').textContent = err.message;
      $('blockers-filter').focus();
    }
  }
  $('blockers-form').addEventListener('submit', saveBlockers);
  $('blockers-form').addEventListener('keydown', (e) => {
    const stops = visibleBlockers();
    const active = document.activeElement;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const i = stops.indexOf(active);
      if (i < 0 && active !== $('blockers-filter')) return;
      const to = active === $('blockers-filter') ? (e.key === 'ArrowDown' ? stops[0] : null) : stops[i + (e.key === 'ArrowDown' ? 1 : -1)] || (e.key === 'ArrowUp' ? $('blockers-filter') : null);
      e.preventDefault();
      if (to) to.focus();
    } else if (e.key === 'Enter' && active.tagName !== 'BUTTON') {
      e.preventDefault();
      $('blockers-form').requestSubmit();
    }
  });
  $('blockers-cancel').addEventListener('click', () => closeDialog($('blockers-dialog')));

  // ---------- manage lists ----------

  async function manageCall(body, focusSel) {
    try {
      const res = await api('/api/action', { method: 'POST', body });
      announce(res.message);
      $('manage-error').textContent = '';
      await loadView({ focus: false });
      renderManage();
      if (focusSel) {
        const f = $('manage-lists').querySelector(focusSel) || $('manage-new');
        f.focus();
      }
      return res;
    } catch (err) {
      $('manage-error').textContent = err.message;
      return null;
    }
  }

  const notesPlace = () => {
    const where = $('manage-where').value;
    const sub = $('manage-sub').value.trim().replace(/^[\\/]+|[\\/]+$/g, '');
    return where && sub ? `${where}/${sub}` : where;
  };

  const NOT_ACTIONABLE_LABEL = 'Not actionable (events, meetings, ideas): keep this list\'s tasks out of My Day and Next actions';
  const SYNC_LABEL = 'Sync to Jira: Sync with Jira (shift and j) includes the tasks in this file';
  const FILE_TASKS_LABEL = 'Keep tasks in this file: the list shows every task in it, putting a task on the list moves its lines here, and reordering the list reorders the file';
  let watchedFiles = [];
  const fileSelect = (id, current) => el('select', { id },
    ...(current ? [] : [el('option', { value: '', text: 'No file' })]),
    ...watchedFiles.map((f) => el('option', { value: f.file, text: f.label, selected: f.file === current })));

  function renderManage() {
    const box = $('manage-lists');
    box.replaceChildren(...st.summary.lists.map((l, i) => {
      const nameIn = el('input', { type: 'text', id: `ml-${i}`, value: l.name, autocomplete: 'off', spellcheck: 'false' });
      const folderIn = el('input', { type: 'text', id: `mf-${i}`, value: l.folder || '', autocomplete: 'off', spellcheck: 'false' });
      const fs = el('fieldset', {},
        el('legend', { text: `${l.name}, ${l.count} open ${l.count === 1 ? 'task' : 'tasks'}` }),
        el('div', { class: 'row' }, el('label', { for: `ml-${i}`, text: 'Name' }), nameIn,
          el('button', { type: 'button', text: `Rename ${l.name}`, onclick: () => manageCall({ op: 'listRename', list: l.id, value: nameIn.value }, `#ml-${i}`) })),
        el('div', { class: 'row' }, el('label', { for: `mf-${i}`, text: 'Folder' }), folderIn,
          el('button', { type: 'button', text: `Set folder of ${l.name}`, onclick: () => manageCall({ op: 'listEdit', list: l.id, value: { folder: folderIn.value } }, `#mf-${i}`) })),
        el('div', { class: 'row' }, el('span', { text: l.notesFile ? `${l.fileTasks ? 'Tasks kept in' : 'Notes file'}: ${l.notesFile}.` : 'No notes file.' }),
          el('button', { type: 'button', text: `Create a notes file for ${l.name} in the notes location below`, onclick: () => manageCall({ op: 'listEdit', list: l.id, value: { notesFolder: notesPlace() } }, null) })));
      const fileSel = fileSelect(`mfile-${i}`, l.file);
      const tasksCb = el('input', { type: 'checkbox', id: `mt-${i}`, checked: !!l.fileTasks });
      const syncCb = el('input', { type: 'checkbox', id: `mj-${i}`, checked: !!l.jiraSync });
      const actCb = el('input', { type: 'checkbox', id: `mna-${i}`, checked: !!l.notActionable });
      const labelsIn = el('input', { type: 'text', id: `mjl-${i}`, value: (l.jiraLabels || []).join(', '), autocomplete: 'off', spellcheck: 'false' });
      const statusIn = el('input', { type: 'text', id: `mjs-${i}`, value: l.jiraStatus || '', autocomplete: 'off', spellcheck: 'false' });
      fs.append(
        el('div', { class: 'row' }, el('label', { for: `mfile-${i}`, text: `File for ${l.name}` }), fileSel),
        el('div', { class: 'row' }, tasksCb, el('label', { for: `mt-${i}`, text: FILE_TASKS_LABEL })),
        el('div', { class: 'row' }, actCb, el('label', { for: `mna-${i}`, text: NOT_ACTIONABLE_LABEL })),
        el('div', { class: 'row' }, syncCb, el('label', { for: `mj-${i}`, text: SYNC_LABEL })),
        el('div', { class: 'row' }, el('label', { for: `mjl-${i}`, text: `Extra Jira labels for ${l.name} (optional, separated by commas)` }), labelsIn),
        el('div', { class: 'row' }, el('label', { for: `mjs-${i}`, text: `Jira status for open tasks in ${l.name} (optional, for example In Discovery)` }), statusIn),
        el('button', { type: 'button', text: `Save file settings for ${l.name}`, onclick: () => {
          const value = { fileTasks: tasksCb.checked, notActionable: actCb.checked, jiraSync: syncCb.checked, jiraLabels: labelsIn.value, jiraStatus: statusIn.value };
          if (fileSel.value && fileSel.value !== l.file) value.file = fileSel.value;
          return manageCall({ op: 'listEdit', list: l.id, value }, `#mt-${i}`);
        } }));
      if (l.file) {
        fs.append(el('button', { type: 'button', id: `mbk-${i}`, text: `Default buckets for ${l.name} (y on its row in All lists)`, onclick: () => openBuckets(l.file, `#mbk-${i}`) }));
      }
      if (l.id !== 'mylist') {
        fs.append(el('button', { type: 'button', text: `Delete ${l.name}`, onclick: () => {
          if (window.confirm(`Delete the list ${l.name}? Your tasks and text files are not changed.`)) manageCall({ op: 'listDelete', list: l.id }, null);
        } }));
      }
      return el('li', {}, fs);
    }));
  }

  async function openManage(focusNew) {
    $('manage-error').textContent = '';
    $('manage-new').value = '';
    $('manage-folder').value = '';
    $('manage-sub').value = '';
    $('manage-makefile').checked = false;
    try {
      const cfg = await api('/api/config');
      $('manage-where').replaceChildren(...cfg.folders.map((f) => el('option', { value: f.path, text: f.path })));
      watchedFiles = cfg.files || [];
      $('manage-file').replaceChildren(...fileSelect('x', '').children);
      $('manage-filetasks').checked = false;
      $('manage-notactionable').checked = false;
    } catch (err) {
      alertMessage(err.message);
    }
    renderManage();
    openDialog($('manage-dialog'), st.activeId);
    if (focusNew === true) $('manage-new').focus();
    else $('manage-lists').querySelector('input').focus();
  }
  $('manage-btn').addEventListener('click', () => openManage());
  $('manage-close').addEventListener('click', () => closeDialog($('manage-dialog')));
  $('manage-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = { name: $('manage-new').value, folder: $('manage-folder').value };
    if ($('manage-makefile').checked) value.notesFolder = notesPlace();
    else if ($('manage-file').value) value.file = $('manage-file').value;
    if ($('manage-filetasks').checked) value.fileTasks = true;
    if ($('manage-notactionable').checked) value.notActionable = true;
    if ($('manage-jira').checked) {
      value.jiraSync = true;
      value.jiraLabels = $('manage-jira-labels').value;
      value.jiraStatus = $('manage-jira-status').value;
    }
    const res = await manageCall({ op: 'listCreate', value }, '#manage-new');
    if (res) {
      $('manage-new').value = '';
      $('manage-folder').value = '';
      $('manage-file').value = '';
      $('manage-filetasks').checked = false;
      $('manage-notactionable').checked = false;
      $('manage-jira').checked = false;
      $('manage-jira-labels').value = '';
      $('manage-jira-status').value = '';
    }
  });

  function cycleList(dir) {
    const lists = st.summary.views.filter((v) => v.id.startsWith('list:'));
    const cur = lists.findIndex((v) => v.id === st.view);
    const next = cur < 0 ? (dir > 0 ? 0 : lists.length - 1) : (cur + dir + lists.length) % lists.length;
    switchView(lists[next].id);
  }

  function startGrab() {
    const item = currentItem();
    if (!inMyList()) {
      announce('Reordering works in a list. Press minus to open My list, or open a list from the view menu.');
      return;
    }
    if (!item || (item.type !== 'task' && item.type !== 'note')) return;
    if (st.model.sortedBy && st.model.sortedBy !== 'manual') {
      announce(`This list is sorted by ${SORT_LABELS[st.model.sortedBy]}. Press shift and o and choose manual order to reorder it yourself.`);
      return;
    }
    st.grab = item.id;
    render();
    setActive(item.id, true);
    const vis = visibleItems();
    announce(`Picked up: ${item.text}. Position ${activeIndex() + 1} of ${vis.length}. Up and Down move it. Enter drops it.`);
  }

  function drop(cancelMsg) {
    if (!st.grab) return;
    const item = currentItem();
    st.grab = null;
    render();
    setActive(st.activeId, true);
    announce(`${cancelMsg || 'Dropped'} at position ${activeIndex() + 1} of ${visibleItems().length}${item ? `: ${item.text}` : ''}.`);
  }

  async function moveInList(how) {
    const item = currentItem();
    if (!inMyList()) {
      announce('Moving works in a list. Press minus to open My list, or open a list from the view menu.');
      return;
    }
    if (!item || (item.type !== 'task' && item.type !== 'note')) return;
    if (st.model.sortedBy && st.model.sortedBy !== 'manual') {
      announce(`This list is sorted by ${SORT_LABELS[st.model.sortedBy]}. Press shift and o and choose manual order to reorder it yourself.`);
      return;
    }
    await act('listMove', how, item, curListId());
    if (st.grab) {
      st.grab = st.activeId;
      render();
      setActive(st.activeId, true);
    }
  }

  function nextFile(dir = 1) {
    const heads = visibleItems().filter((i) => i.type === 'group' && i.file);
    if (!heads.length) {
      announce('Open the triage view with 0 to step through files.');
      return;
    }
    const cur = activeIndex();
    const vis = visibleItems();
    const pick = dir > 0 ? heads.find((h) => vis.indexOf(h) > cur) : [...heads].reverse().find((h) => vis.indexOf(h) < cur);
    if (!pick) {
      announce(dir > 0 ? 'No more files.' : 'This is the first file.');
      return;
    }
    setActive(pick.id, true);
  }

  async function toggleChanged() {
    st.changedOnly = !st.changedOnly;
    store.set('changed', st.changedOnly ? '1' : '0');
    const model = await loadView({ focus: true });
    announce(`${st.changedOnly ? 'Showing only files not yet reviewed or changed since review' : 'Showing all files'}. ${model.count} ${model.count === 1 ? 'unmarked line' : 'unmarked lines'}.`);
  }

  const ACTION_KEYS = {
    l: () => listKey(),
    L: () => quickList(),
    g: () => startGrab(),
    n: () => (st.view === 'triage' ? nextFile(1) : openNewTask(true)),
    f: () => (st.view === 'triage' ? toggleChanged() : announce('The f key filters the triage view to new or changed files. Press 0 to open triage.')),
    R: () => reviewFile(),
    x: () => act('toggleDone'),
    '+': () => statusKey('toggleDone', 'done', 'Done'),
    '<': () => statusKey('waitingOnMe', 'waitingOnMe', 'Waiting on me'),
    '>': () => statusKey('waitingOnOthers', 'waitingOnOthers', 'Waiting on others'),
    '%': () => statusKey('inProgress', 'inProgress', 'In progress'),
    '*': () => statusKey('important', 'important', 'Important'),
    w: () => act('waitingOnOthers'),
    i: () => act('important'),
    p: () => act('inProgress'),
    m: () => openNewTask(false),
    N: () => (st.view === 'triage' ? nextFile(-1) : openListNote()),
    O: () => openSort(),
    k: () => openDue(true),
    b: () => act('ongoing'),
    '~': () => act('ongoing'),
    d: () => openDue(),
    j: () => openJira(),
    y: () => openBuckets(),
    t: () => act('today'),
    P: () => act('priority'),
    B: () => openBlockers(),
    o: () => act('open'),
    u: () => undo(),
    a: () => markTodo(),
    '@': () => markTodo(),
    s: () => noteKey(),
    '&': () => noteKey(),
    S: () => (st.view === 'triage' ? skipFile() : announce('Shift and s marks every remaining line in a file as a note in the triage view. Press 0 to open triage.')),
  };

  function markTodo() {
    if (st.view === 'triage') act('todo');
    else announce('The at sign or a key marks unmarked lines as to-dos in the triage view. Press 0 to open triage.');
  }

  function statusKey(op, flag, label) {
    const item = currentItem();
    if (!item) return;
    const turningOn = (item.type === 'task' || item.type === 'unmarked') && !(item.flags && item.flags[flag]);
    if (!turningOn) {
      act(op);
      return;
    }
    noteCtx = { mode: 'status', item, op, label };
    $('note-title').textContent = `${label}: add a note?`;
    $('note-task').textContent = item.text;
    $('note-hint').textContent = 'Optional. Type who or why, then Enter. Enter with nothing typed sets the status without a note. Escape cancels and changes nothing. The note is saved under the task.';
    $('note-stamp').parentElement.hidden = true;
    $('note-save').textContent = 'Set status';
    showNote(item.id);
  }

  // In a list, Delete takes the item off that list. Anywhere else it deletes the task: the text stays in the file, marked with $.
  // A list that keeps its tasks in a file shows everything in it, so there Delete deletes the task.
  function deleteKey() {
    const item = currentItem();
    if (!item) return undefined;
    const listId = curListId();
    if (listId && !item.kept && (item.type === 'task' || item.type === 'note')) return act('listToggle', null, item, listId);
    return act('exclude');
  }

  function noteKey() {
    const item = currentItem();
    if (!item) return;
    if (item.type === 'unmarked') act('note');
    else if (item.type === 'task') openNote();
    else announce('Select a task to add a note to it, or an unmarked line in triage to mark it as a note.');
  }

  function reviewFile() {
    if (st.view !== 'triage') {
      announce('Shift and r marks a file as reviewed in the triage view. Press 0 to open triage.');
      return;
    }
    const item = currentItem();
    if (!item) return;
    const file = item.type === 'group' ? item.file : fileOf(item);
    if (file) act('reviewFile', null, { id: `f:${file}`, type: 'group' });
  }

  function skipFile() {
    const item = currentItem();
    if (!item) return;
    const file = item.type === 'group' ? item.file : fileOf(item);
    if (file) act('dismissFile', null, { id: `f:${file}`, type: 'group' });
  }

  // ---------- Jira sync ----------

  const SYNC_SECTIONS = [
    ['conflict', 'Conflicts: changed on both sides, or different on the first sync'],
    ['create', 'Create in Jira'],
    ['push', 'Update Jira'],
    ['pull', 'Update files from Jira'],
  ];
  let syncPlan = null;

  function syncCount() {
    if (!syncPlan) return;
    const form = $('sync-form');
    const total = syncPlan.items.length;
    const boxes = [...form.querySelectorAll('input[type=checkbox]:checked')].length;
    const radios = [...form.querySelectorAll('input[type=radio]:checked')].filter((r) => r.value !== 'skip').length;
    $('sync-count').textContent = `${boxes + radios} of ${total} ${total === 1 ? 'change' : 'changes'} chosen.`;
  }

  function renderSync(plan) {
    syncPlan = plan;
    const sections = [];
    const present = SYNC_SECTIONS.filter(([g]) => plan.items.some((i) => i.group === g));
    present.forEach(([group, title], si) => {
      const its = plan.items.filter((i) => i.group === group);
      const n = its.length;
      const fs = el('fieldset', { class: 'sync-section' },
        el('legend', { text: `${title}, ${n} ${n === 1 ? 'change' : 'changes'}. Section ${si + 1} of ${present.length}` }));
      const setAll = (fn) => () => { for (const inp of fs.querySelectorAll('input')) fn(inp); syncCount(); announce('Done. ' + $('sync-count').textContent); };
      if (group === 'conflict') {
        fs.append(el('p', {},
          el('button', { type: 'button', text: 'Keep file for all conflicts', onclick: setAll((r) => { r.checked = r.value === 'file'; }) }), ' ',
          el('button', { type: 'button', text: 'Take Jira for all conflicts', onclick: setAll((r) => { r.checked = r.value === 'jira'; }) }), ' ',
          el('button', { type: 'button', text: 'Skip all conflicts', onclick: setAll((r) => { r.checked = r.value === 'skip'; }) })));
      } else {
        fs.append(el('p', {},
          el('button', { type: 'button', text: `Tick all in ${title}`, onclick: setAll((c) => { c.checked = true; }) }), ' ',
          el('button', { type: 'button', text: `Untick all in ${title}`, onclick: setAll((c) => { c.checked = false; }) })));
      }
      const byTask = new Map();
      for (const it of its) {
        if (!byTask.has(it.taskId)) byTask.set(it.taskId, []);
        byTask.get(it.taskId).push(it);
      }
      let k = 0;
      for (const list of byTask.values()) {
        const first = list[0];
        const box = el('fieldset', { class: 'sync-task' },
          el('legend', { text: `${first.task}${first.key ? `, ${first.key}` : ''}, ${first.file} line ${first.line}` }));
        for (const it of list) {
          k += 1;
          const id = `sy-${group}-${k}`;
          const pos = `${k} of ${n}`;
          if (group === 'conflict') {
            const radios = el('fieldset', { class: 'sync-choice', 'data-item': it.id },
              el('legend', { text: `${it.label}, ${pos}` }));
            for (const [value, text] of [['file', it.choices.file], ['jira', it.choices.jira], ['skip', 'Skip for now']]) {
              radios.append(el('div', { class: 'row' },
                el('input', { type: 'radio', name: id, id: `${id}-${value}`, value, checked: value === it.choice, onchange: syncCount }),
                el('label', { for: `${id}-${value}`, text }) ));
            }
            box.append(radios);
          } else {
            box.append(el('div', { class: 'row' },
              el('input', { type: 'checkbox', id, 'data-item': it.id, checked: !!it.checked, onchange: syncCount }),
              el('label', { for: id, text: `${it.label}, ${pos}` })));
          }
        }
        fs.append(box);
      }
      sections.push(fs);
    });
    if (plan.info && plan.info.length) {
      sections.push(el('section', {}, el('h3', { text: `Not synced, ${plan.info.length}` }),
        el('ul', {}, ...plan.info.map((x) => el('li', { text: `${x.task}, ${x.file} line ${x.line}: ${x.text}` })))));
    }
    $('sync-sections').replaceChildren(...sections);
    $('sync-form').hidden = plan.items.length === 0;
    syncCount();
    const n = plan.items.length;
    const SHORT = { conflict: ['conflict', 'conflicts'], create: ['to create in Jira', 'to create in Jira'], push: ['to update in Jira', 'to update in Jira'], pull: ['to update in files', 'to update in files'] };
    const counts = present.map(([g]) => { const c = plan.items.filter((i) => i.group === g).length; return `${c} ${SHORT[g][c === 1 ? 0 : 1]}`; }).join(', ');
    $('sync-status').textContent = plan.message
      || (n ? `${n} ${n === 1 ? 'change' : 'changes'} found: ${counts}. Files checked: ${plan.synced.join(', ')}.` : `Everything is in sync. Files checked: ${plan.synced.join(', ')}.`);
    $('sync-started').hidden = !plan.startedNotes;
    $('sync-started-text').textContent = `${plan.startedNotes} ${plan.startedNotes === 1 ? 'task has' : 'tasks have'} a "& Started" date note. Converting moves each date onto the task line as start:, which syncs to the start date in Jira.`;
  }

  async function checkSync() {
    $('sync-error').textContent = '';
    $('sync-done').hidden = true;
    $('sync-form').hidden = true;
    $('sync-again').hidden = true;
    $('sync-started').hidden = true;
    $('sync-status').textContent = 'Checking Jira…';
    try {
      renderSync(await api('/api/jira/sync/preview', { method: 'POST', body: {} }));
      $('sync-again').hidden = false;
      const first = $('sync-sections').querySelector('input') || $('sync-close');
      first.focus();
    } catch (err) {
      $('sync-status').textContent = '';
      $('sync-error').textContent = err.message;
      $('sync-again').hidden = false;
      $('sync-close').focus();
    }
  }

  function openSync() {
    $('sync-sections').replaceChildren();
    openDialog($('sync-dialog'), st.activeId);
    $('sync-close').focus();
    checkSync();
  }

  $('sync-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!syncPlan) return;
    const choices = {};
    const nodes = new Map([...$('sync-form').querySelectorAll('[data-item]')].map((n) => [n.getAttribute('data-item'), n]));
    for (const it of syncPlan.items) {
      const node = nodes.get(it.id);
      let choice = 'skip';
      if (node && node.type === 'checkbox') choice = node.checked ? 'apply' : 'skip';
      else if (node) choice = (node.querySelector('input:checked') || {}).value || 'skip';
      choices[it.id] = { choice, sig: it.sig };
    }
    $('sync-apply').disabled = true;
    $('sync-status').textContent = 'Sending changes to Jira…';
    try {
      const res = await api('/api/jira/sync/apply', { method: 'POST', body: { choices } });
      $('sync-form').hidden = true;
      $('sync-status').textContent = res.message;
      $('sync-results').replaceChildren(...res.results.map((r) => el('li', { text: `${r.ok ? 'Done' : 'Not done'}: ${r.text}` })));
      $('sync-done').hidden = !res.results.length;
      syncPlan = null;
      announce(res.message);
      await loadView({ focus: false });
      ($('sync-done').hidden ? $('sync-close') : $('sync-done-title')).focus();
    } catch (err) {
      $('sync-error').textContent = err.message;
    } finally {
      $('sync-apply').disabled = false;
    }
  });
  $('sync-started-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/jira/sync/started', { method: 'POST', body: {} });
      announce(res.message);
      await loadView({ focus: false });
      await checkSync();
      $('sync-status').textContent = `${res.message} ${$('sync-status').textContent}`;
    } catch (err) {
      $('sync-error').textContent = err.message;
    }
  });
  $('sync-again').addEventListener('click', checkSync);
  $('sync-close').addEventListener('click', () => closeDialog($('sync-dialog')));
  $('sync-btn').addEventListener('click', openSync);

  function globalKey(e) {
    if (e.key === '/') {
      e.preventDefault();
      $('search').focus();
      $('search').select();
      return true;
    }
    if (e.key === 'v') {
      e.preventDefault();
      $('view').focus();
      return true;
    }
    if (e.key === 'c' || e.key === 'h') {
      toggleCompleted();
      return true;
    }
    if (e.key === ']' || e.key === '[') {
      cycleList(e.key === ']' ? 1 : -1);
      return true;
    }
    if (e.key === 'G') {
      switchView('buckets');
      return true;
    }
    if (e.key === 'T') {
      switchView('myday');
      return true;
    }
    if (e.key === 'A') {
      switchView('next');
      return true;
    }
    if (e.key === 'J') {
      openSync();
      return true;
    }
    if (e.key === 'M') {
      openManage();
      return true;
    }
    if (e.key === '?') {
      openHelp(st.activeId);
      return true;
    }
    if (e.key === 'r') {
      api('/api/action', { method: 'POST', body: { op: 'refresh' } }).then(() => loadView({ focus: false })).then(() => announce('List refreshed.'));
      return true;
    }
    if (/^[0-9=-]$/.test(e.key) && VIEW_KEYS[e.key]) {
      switchView(VIEW_KEYS[e.key]);
      return true;
    }
    return false;
  }

  tree.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveInList(e.key === 'ArrowUp' ? 'up' : 'down');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (st.grab) {
      const moves = { ArrowUp: 'up', ArrowDown: 'down', Home: 'top', End: 'bottom' };
      e.preventDefault();
      if (moves[e.key]) moveInList(moves[e.key]);
      else if (e.key === 'Enter' || e.key === 'g' || e.key === ' ') drop('Dropped');
      else if (e.key === 'Escape') drop('Dropped');
      else announce('Reordering. Up and Down move the task. Enter drops it.');
      return;
    }
    const item = currentItem();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        return move(1);
      case 'ArrowUp':
        e.preventDefault();
        return move(-1);
      case 'Home':
        e.preventDefault();
        return move(0, 0);
      case 'End':
        e.preventDefault();
        return move(0, visibleItems().length - 1);
      case 'PageDown':
        e.preventDefault();
        return move(10);
      case 'PageUp':
        e.preventDefault();
        return move(-10);
      case 'ArrowRight': {
        e.preventDefault();
        if (!item) return undefined;
        if (item.hasChildren && st.collapsed.has(item.id)) toggleExpand(item, true);
        else if (item.hasChildren) move(1);
        return undefined;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (!item) return undefined;
        if (item.hasChildren && !st.collapsed.has(item.id)) {
          toggleExpand(item, false);
          return undefined;
        }
        const vis = visibleItems();
        for (let i = activeIndex() - 1; i >= 0; i -= 1) {
          if (vis[i].level < item.level) {
            setActive(vis[i].id, true);
            break;
          }
        }
        return undefined;
      }
      case 'Tab':
        if (item && (item.type === 'task' || item.type === 'unmarked')) {
          e.preventDefault();
          act(e.shiftKey ? 'outdent' : 'indent');
        }
        return undefined;
      case 'Enter':
        e.preventDefault();
        return openActions();
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        return deleteKey();
      case ' ':
        e.preventDefault();
        if (item && item.type === 'group') toggleExpand(item);
        return undefined;
      default:
    }
    if (ACTION_KEYS[e.key]) {
      e.preventDefault();
      ACTION_KEYS[e.key]();
      return;
    }
    if (globalKey(e)) e.preventDefault();
  });

  tree.addEventListener('focusin', (e) => {
    const node = e.target.closest && e.target.closest('[data-id]');
    if (node && node.dataset.id !== st.activeId) setActive(node.dataset.id, false);
  });

  tree.addEventListener('click', (e) => {
    const node = e.target.closest('[data-id]');
    if (node) setActive(node.dataset.id, true);
  });
  tree.addEventListener('dblclick', () => openActions());

  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyN' && st.model && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      openManage(true);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target !== document.body && e.target !== $('empty') && e.target !== $('list-heading')) return;
    if (globalKey(e)) e.preventDefault();
  });

  $('empty').addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (globalKey(e)) e.preventDefault();
  });

  // ---------- header controls ----------

  $('view').addEventListener('change', (e) => switchView(e.target.value, { fromSelect: true }));
  $('toggle-completed').addEventListener('click', toggleCompleted);
  $('toggle-completed').setAttribute('aria-pressed', String(st.showCompleted));
  $('toggle-completed').textContent = st.showCompleted ? 'Hide completed' : 'Show completed';

  let searchTimer = null;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      st.q = e.target.value.trim();
      const model = await loadView({ focus: false });
      announce(`${model.count} ${model.count === 1 ? 'result' : 'results'}.`);
    }, 300);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if ($('search').value) {
        $('search').value = '';
        st.q = '';
        loadView({ focus: false }).then((m) => announce(`Search cleared. ${m.count} ${m.count === 1 ? 'task' : 'tasks'}.`));
      } else if (st.activeId) setActive(st.activeId, true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      st.q = $('search').value.trim();
      loadView({ focus: true });
    }
  });

  // ---------- live updates ----------

  let reloadTimer = null;
  function connectEvents() {
    const es = new EventSource(`/api/events?t=${encodeURIComponent(window.PT.token)}`);
    es.addEventListener('changed', (e) => {
      const data = JSON.parse(e.data);
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        const hadFocus = tree.contains(document.activeElement);
        const idx = activeIndex();
        const before = st.model ? st.model.items.map((i) => i.id).join() : '';
        await loadView({ focus: hadFocus, keepIndex: idx });
        const after = st.model.items.map((i) => i.id).join();
        if (!data.recentlyWrote && before !== after) announce('The list was updated because a file changed.');
      }, 300);
    });
  }

  async function init() {
    try {
      const problems = await loadSummary();
      if (!st.summary.folders) {
        $('list-heading').textContent = 'Welcome';
        $('empty').hidden = false;
        $('empty').replaceChildren('No folders are being watched yet. ', el('a', { href: '/setup', text: 'Open settings to add a folder' }), '.');
        return;
      }
      await loadView({ focus: !location.hash.includes('nofocus') });
      if (problems) announce(`${problems} ${problems === 1 ? 'file was' : 'files were'} skipped. See settings for details.`);
      connectEvents();
      if (params.get('master')) openMaster();
    } catch (err) {
      alertMessage(err.message);
    }
  }

  init();
})();
