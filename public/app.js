(() => {
  'use strict';

  const { api, announce, alertMessage, el } = window.PT;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const listMode = params.get('ui') === 'list';
  const VIEW_KEYS = { 1: 'open', 2: 'file', 3: 'group', 4: 'due', 5: 'waitingMe', 6: 'waitingOthers', 7: 'important', 8: 'inProgress', 9: 'completed', 0: 'triage', '-': 'list:mylist' };
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
    activeId: null,
    jira: null,
    pendingFocus: null,
    changedOnly: store.get('changed', '0') === '1',
    grab: null,
  };

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

  function spoken(it) {
    const parts = [];
    if (it.words.length) parts.push(`${it.words.join(', ')}.`);
    parts.push(`${it.text}.`);
    if (it.meta.length) parts.push(`${it.meta.join('. ')}.`);
    return parts.join(' ');
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
        class: [it.type === 'group' ? 'group' : '', it.id === st.grab ? 'grabbed' : '', it.due && it.due.state === 'overdue' ? 'overdue' : ''].filter(Boolean).join(' '),
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
      if (listMode && it.level > 1) node.append(el('span', { class: 'meta', text: `Level ${it.level}. ` }));
      if (it.words.length) node.append(el('span', { class: 'words', text: `${it.words.join(', ')}. ` }));
      node.append(el('span', { class: 'text', text: `${it.text}. ` }));
      if (it.meta.length) node.append(el('span', { class: 'meta', text: `${it.meta.join('. ')}.` }));
      tree.append(node);
    }

    $('list-heading').textContent = st.model.title;
    const gi = st.grab ? vis.findIndex((i) => i.id === st.grab) : -1;
    $('grab-status').hidden = gi < 0;
    $('grab-status').textContent = gi < 0 ? '' : `Reordering "${vis[gi].text}", position ${gi + 1} of ${vis.length}. Up and Down move it. Home and End send it to the top or bottom. Enter or Escape drops it.`;
    const n = st.model.count;
    $('list-status').textContent = `${n} ${st.model.view === 'triage' ? (n === 1 ? 'unmarked line' : 'unmarked lines') : n === 1 ? 'task' : 'tasks'}${st.q ? ` matching "${st.q}"` : ''}${st.showCompleted && st.model.view !== 'completed' ? ', including completed' : ''}${st.changedOnly && st.model.view === 'triage' ? ', new or changed files only' : ''}.`;
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
    for (const id of [...st.collapsed]) if (!ids.has(id)) st.collapsed.delete(id);

    const vis = visibleItems();
    let target = null;
    if (focusId && vis.some((i) => i.id === focusId)) target = focusId;
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

  async function doAct(op, value, item, list) {
    const isTask = item.type === 'task' || item.type === 'unmarked';
    if (!isTask && op !== 'dismissFile') {
      announce('That is a heading, not a task.');
      return;
    }
    const idx = activeIndex();
    try {
      const res = await api('/api/action', { method: 'POST', body: { id: item.id, op, value, list } });
      announce(res.message);
      if (op === 'open') return;
      await loadView({ focusId: res.focusId, keepIndex: idx });
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
    st.view = id;
    store.set('view', id);
    st.collapsed.clear();
    st.grab = null;
    st.activeId = null;
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

  for (const dlg of document.querySelectorAll('dialog')) {
    dlg.addEventListener('close', () => {
      if (dlg.returnId && st.model && !tree.contains(document.activeElement)) {
        const node = nodeFor(dlg.returnId);
        if (node) setActive(dlg.returnId, true);
      }
    });
  }

  const FLAG_LABELS = [
    ['waitingOnMe', 'Mark waiting on me', 'Clear waiting on me', 'm'],
    ['waitingOnOthers', 'Mark waiting on someone else', 'Clear waiting on someone else', 'w'],
    ['important', 'Mark important', 'Clear important', 'i'],
    ['inProgress', 'Mark in progress', 'Clear in progress', 'p'],
    ['ongoing', 'Mark ongoing', 'Clear ongoing', 'b'],
  ];

  async function openActions() {
    const item = currentItem();
    if (!item) return;
    if (item.type === 'group') {
      toggleExpand(item);
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
    if (item.type === 'unmarked') {
      const ctx = item.context || { before: [], after: [] };
      if (ctx.before.length || ctx.after.length) {
        notes.append(el('h3', { text: 'Nearby lines' }), el('ul', {}, ...ctx.before.map((n) => el('li', { text: `Before: ${n}` })), el('li', { text: `This line: ${item.text}` }), ...ctx.after.map((n) => el('li', { text: `After: ${n}` }))));
      }
      add('Mark as to-do (a)', () => act('todo'));
      add('Skip this line (s)', () => act('dismiss'));
      add('Skip all unmarked lines in this file (shift and s)', () => act('dismissFile', null, { id: `f:${fileOf(item)}`, type: 'group' }));
      add('Mark this file as reviewed (shift and r)', () => act('reviewFile'));
    } else {
      add('Choose lists for this task (l)', () => listKey());
      if (curListId()) {
        add('Move up (alt and up)', () => act('listMove', 'up'));
        add('Move down (alt and down)', () => act('listMove', 'down'));
        add('Move to top', () => act('listMove', 'top'));
        add('Move to bottom', () => act('listMove', 'bottom'));
        add('Reorder with arrow keys (g)', () => startGrab());
      }
    }
    add(item.flags.done ? 'Reopen (x)' : 'Mark done (x)', () => act('toggleDone'));
    for (const [flag, on, off, key] of FLAG_LABELS) add(`${item.flags[flag] ? off : on} (${key})`, () => act(flag));
    add('Set or clear due date (d)', () => openDue());
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

  function openDue() {
    const item = currentItem();
    if (!item || item.type === 'group') return;
    $('due-task').textContent = item.text;
    $('due-input').value = item.due ? item.due.iso : '';
    $('due-error').textContent = '';
    openDialog($('due-dialog'), item.id);
    $('due-input').focus();
    $('due-input').select();
  }

  $('due-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = currentItem();
    const idx = activeIndex();
    try {
      const res = await api('/api/action', { method: 'POST', body: { id: item.id, op: 'due', value: $('due-input').value } });
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

  $('help-btn').addEventListener('click', () => openDialog($('help-dialog'), null));
  $('help-close').addEventListener('click', () => closeDialog($('help-dialog')));

  // ---------- keyboard ----------

  function toggleExpand(item, expand) {
    if (!item.hasChildren) return false;
    const collapsed = st.collapsed.has(item.id);
    const want = expand === undefined ? collapsed : expand;
    if (want === !collapsed) return false;
    if (want) st.collapsed.delete(item.id);
    else st.collapsed.add(item.id);
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
    if (!item || item.type !== 'task') {
      announce('Select a task first. Lines in triage need to be marked as to-dos before they can go on a list.');
      return undefined;
    }
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
    if (!item || item.type !== 'task') return;
    $('lists-task').textContent = item.text;
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
    try {
      const res = await api('/api/action', { method: 'POST', body: { id: item.id, op: 'listSet', value: { ids, newName: $('lists-new').value } } });
      closeDialog($('lists-dialog'));
      announce(res.message);
      await loadView({ focusId: res.focusId, keepIndex: idx });
    } catch (err) {
      $('lists-error').textContent = err.message;
      $('lists-new').focus();
    }
  }
  $('lists-form').addEventListener('submit', saveLists);
  $('lists-cancel').addEventListener('click', () => closeDialog($('lists-dialog')));

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

  function renderManage() {
    const box = $('manage-lists');
    box.replaceChildren(...st.summary.lists.map((l, i) => {
      const input = el('input', { type: 'text', id: `ml-${i}`, value: l.name, autocomplete: 'off', spellcheck: 'false' });
      const row = el('li', { class: 'row' },
        el('label', { for: `ml-${i}`, text: `Name of list ${i + 1}, ${l.count} open ${l.count === 1 ? 'task' : 'tasks'}` }), input,
        el('button', { type: 'button', text: `Rename ${l.name}`, onclick: () => manageCall({ op: 'listRename', list: l.id, value: input.value }, `#ml-${i}`) }));
      if (l.id !== 'mylist') {
        row.append(el('button', { type: 'button', text: `Delete ${l.name}`, onclick: () => {
          if (window.confirm(`Delete the list ${l.name}? Your tasks and text files are not changed.`)) manageCall({ op: 'listDelete', list: l.id }, null);
        } }));
      }
      return row;
    }));
  }

  function openManage() {
    $('manage-error').textContent = '';
    $('manage-new').value = '';
    renderManage();
    openDialog($('manage-dialog'), st.activeId);
    $('manage-lists').querySelector('input').focus();
  }
  $('manage-btn').addEventListener('click', openManage);
  $('manage-close').addEventListener('click', () => closeDialog($('manage-dialog')));
  $('manage-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await manageCall({ op: 'listCreate', value: $('manage-new').value }, '#manage-new');
    if (res) $('manage-new').value = '';
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
    if (!item || item.type !== 'task') return;
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
    if (!item || item.type !== 'task') return;
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
    n: () => nextFile(1),
    N: () => nextFile(-1),
    f: () => (st.view === 'triage' ? toggleChanged() : announce('The f key filters the triage view to new or changed files. Press 0 to open triage.')),
    R: () => reviewFile(),
    x: () => act('toggleDone'),
    m: () => act('waitingOnMe'),
    w: () => act('waitingOnOthers'),
    i: () => act('important'),
    p: () => act('inProgress'),
    b: () => act('ongoing'),
    d: () => openDue(),
    j: () => openJira(),
    o: () => act('open'),
    u: () => undo(),
    a: () => (st.view === 'triage' ? act('todo') : announce('The a key marks unmarked lines as to-dos in the triage view. Press 0 to open triage.')),
    s: () => (st.view === 'triage' ? act('dismiss') : announce('The s key skips unmarked lines in the triage view. Press 0 to open triage.')),
    S: () => (st.view === 'triage' ? skipFile() : announce('Shift and s skips a whole file in the triage view. Press 0 to open triage.')),
  };

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
    if (e.key === 'c') {
      toggleCompleted();
      return true;
    }
    if (e.key === ']' || e.key === '[') {
      cycleList(e.key === ']' ? 1 : -1);
      return true;
    }
    if (e.key === 'M') {
      openManage();
      return true;
    }
    if (e.key === '?') {
      openDialog($('help-dialog'), st.activeId);
      return true;
    }
    if (e.key === 'r') {
      api('/api/action', { method: 'POST', body: { op: 'refresh' } }).then(() => loadView({ focus: false })).then(() => announce('List refreshed.'));
      return true;
    }
    if (/^[0-9-]$/.test(e.key) && VIEW_KEYS[e.key]) {
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
      case 'Enter':
        e.preventDefault();
        return openActions();
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
    } catch (err) {
      alertMessage(err.message);
    }
  }

  init();
})();
