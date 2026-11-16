(() => {
  'use strict';

  const { api, announce, alertMessage, el } = window.PT;
  const $ = (id) => document.getElementById(id);
  let cfg = { folders: [], jira: null };
  let browsePath = null;
  let browseInfo = null;
  let rtfTarget = null;

  async function loadAll() {
    cfg = await api('/api/config');
    renderFolders();
    renderJira();
    await renderProblems();
  }

  async function saveFolders(folders, message) {
    cfg = await api('/api/folders', { method: 'POST', body: { folders } });
    renderFolders();
    await renderProblems();
    if (message) announce(message);
  }

  // ---------- folders ----------

  function renderFolders() {
    const box = $('folders');
    box.replaceChildren();
    $('no-folders').hidden = cfg.folders.length > 0;
    cfg.folders.forEach((f, i) => {
      const heading = el('h3', { id: `f-h-${i}`, tabindex: '-1', text: f.path });
      const mode = el('select', { id: `f-mode-${i}`, 'aria-describedby': `f-mode-hint-${i}` },
        el('option', { value: 'notes', text: 'Notes: only marked lines are tasks' }),
        el('option', { value: 'tasks', text: 'Tasks: every unmarked line is a task' }));
      mode.value = f.unmarked;
      mode.addEventListener('change', () => {
        const folders = cfg.folders.map((x, j) => (j === i ? { ...x, unmarked: mode.value } : x));
        saveFolders(folders, `Unmarked lines in ${f.path} are now ${mode.value}.`).catch((e) => alertMessage(e.message));
      });
      const treeBox = el('div', { id: `f-tree-${i}` });
      const card = el('section', { class: 'card', 'aria-labelledby': `f-h-${i}` },
        heading,
        el('div', { class: 'field' },
          el('label', { for: `f-mode-${i}`, text: 'Unmarked lines are' }),
          mode,
          el('span', { id: `f-mode-hint-${i}`, class: 'hint', text: 'A legend line in a file, such as "nothing = to do", overrides this for that file.' })),
        el('p', {},
          el('button', { type: 'button', text: 'Choose files and subfolders', onclick: () => showTree(i, treeBox) }), ' ',
          el('button', { type: 'button', text: 'Convert .rtf files', onclick: () => offerRtf(i, { silentIfNone: false }) }), ' ',
          el('button', { type: 'button', text: 'Remove folder from list', onclick: () => removeFolder(i) })),
        treeBox);
      box.append(card);
    });
  }

  async function removeFolder(i) {
    const f = cfg.folders[i];
    if (!window.confirm(`Stop watching ${f.path}? Your files are not touched.`)) return;
    await saveFolders(cfg.folders.filter((_, j) => j !== i), `Removed ${f.path}.`);
    $('folders-h').focus();
  }

  async function showTree(i, host) {
    host.replaceChildren(el('p', { text: 'Loading.' }));
    const t = await api(`/api/tree?i=${i}`);
    const fs = el('fieldset', {}, el('legend', { text: `Files and folders in ${t.path}` }));
    fs.append(el('p', { class: 'hint', text: 'Uncheck anything to leave it out. Unchecking a folder leaves out everything inside it. Each entry can also use its own rule for unmarked lines.' }));
    const rows = [];
    t.entries.forEach((e, n) => {
      const cb = el('input', { type: 'checkbox', id: `t${i}-${n}` });
      cb.checked = !e.excluded && !e.inheritedExcluded;
      if (e.inheritedExcluded) cb.disabled = true;
      const sel = el('select', { id: `t${i}-m${n}`, 'aria-label': `Unmarked lines in ${e.rel}` },
        el('option', { value: '', text: 'Use default' }),
        el('option', { value: 'notes', text: 'Notes' }),
        el('option', { value: 'tasks', text: 'Tasks' }));
      sel.value = e.override;
      const label = el('label', { for: cb.id, text: `${e.type === 'dir' ? 'Folder' : 'File'} ${e.rel}${e.rtf ? ' (rtf, not read until converted)' : ''}${e.inheritedExcluded ? ' (left out by its folder)' : ''}` });
      const row = el('div', { class: 'row' }, cb, label);
      if (e.type === 'file' && !e.rtf) row.append(sel);
      fs.append(row);
      rows.push({ e, cb, sel });
    });
    if (!t.entries.length) fs.append(el('p', { text: 'No text files found here.' }));
    const save = el('button', { type: 'button', text: 'Save selection', onclick: async () => {
      const excluded = rows.filter((r) => !r.cb.checked && !r.cb.disabled).map((r) => r.e.rel);
      const overrides = {};
      for (const r of rows) if (r.sel.value && r.e.type === 'file') overrides[r.e.rel] = r.sel.value;
      const folders = cfg.folders.map((x, j) => (j === i ? { ...x, excluded, overrides } : x));
      try {
        await saveFolders(folders, `Saved. ${excluded.length} left out.`);
      } catch (err) {
        alertMessage(err.message);
      }
    } });
    host.replaceChildren(fs, el('p', {}, save));
    const first = fs.querySelector('input');
    if (first) first.focus();
  }

  // ---------- adding and browsing ----------

  async function addFolder(p) {
    const path = (p || '').trim();
    if (!path) {
      alertMessage('Enter a folder or file path first.');
      $('add-path').focus();
      return;
    }
    const folders = [...cfg.folders, { path, unmarked: 'notes', excluded: [], overrides: {} }];
    try {
      await saveFolders(folders, `Added ${path}.`);
    } catch (err) {
      alertMessage(err.message);
      return;
    }
    $('add-path').value = '';
    const idx = cfg.folders.length - 1;
    const offered = await offerRtf(idx, { silentIfNone: true });
    if (!offered) {
      const h = $(`f-h-${idx}`);
      if (h) h.focus();
    }
  }

  async function browse(p) {
    try {
      browseInfo = await api(`/api/browse?path=${encodeURIComponent(p || '')}`);
    } catch (err) {
      alertMessage(err.message);
      return;
    }
    browsePath = browseInfo.path;
    $('browse-path').textContent = `${browseInfo.path}. ${browseInfo.textFiles} text files here${browseInfo.rtfFiles ? `, ${browseInfo.rtfFiles} .rtf files` : ''}.`;
    $('browse-up').disabled = !browseInfo.parent;
    const ul = $('browse-list');
    ul.replaceChildren();
    for (const d of browseInfo.dirs) {
      ul.append(el('li', {}, el('button', { type: 'button', text: `Open ${d}`, onclick: () => browse(`${browseInfo.path}/${d}`).then(() => $('browse-path').focus()) })));
    }
    if (!browseInfo.dirs.length) ul.append(el('li', { text: 'No subfolders.' }));
    const fl = $('browse-files');
    fl.replaceChildren();
    for (const f of browseInfo.files || []) {
      fl.append(el('li', {}, el('button', { type: 'button', text: `Add file ${f}`, onclick: () => addFolder(`${browseInfo.path}/${f}`) })));
    }
    if (!(browseInfo.files || []).length) fl.append(el('li', { text: 'No text files here.' }));
  }

  $('add-btn').addEventListener('click', () => addFolder($('add-path').value));
  $('add-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addFolder($('add-path').value);
  });
  $('browse-up').addEventListener('click', async () => {
    if (browseInfo && browseInfo.parent) {
      await browse(browseInfo.parent);
      announce(`Now in ${browsePath}.`);
    }
  });
  $('browse-use').addEventListener('click', () => addFolder(browsePath));
  $('browse-path').setAttribute('tabindex', '-1');

  // ---------- rtf ----------

  async function offerRtf(i, { silentIfNone }) {
    const r = await api(`/api/rtf?i=${i}`);
    if (!r.files.length) {
      if (!silentIfNone) announce('No .rtf files in this folder.');
      return false;
    }
    rtfTarget = { i, files: r.files };
    $('rtf-intro').textContent = `${r.folder} has ${r.files.length} .rtf ${r.files.length === 1 ? 'file' : 'files'}. Convert to plain .txt?`;
    $('rtf-list').replaceChildren(...r.files.map((f) => el('li', { text: f })));
    $('rtf-result').textContent = '';
    $('rtf-yes').disabled = false;
    $('rtf-dialog').showModal();
    $('rtf-yes').focus();
    return true;
  }

  $('rtf-no').addEventListener('click', () => $('rtf-dialog').close());
  $('rtf-yes').addEventListener('click', async () => {
    $('rtf-yes').disabled = true;
    try {
      const res = await api('/api/rtf/convert', { method: 'POST', body: { i: rtfTarget.i, files: rtfTarget.files, confirm: true } });
      const ok = res.results.filter((x) => x.status === 'converted').length;
      const bad = res.results.filter((x) => x.status !== 'converted');
      $('rtf-result').textContent = `Converted ${ok} of ${res.results.length}.${bad.length ? ' Notes: ' + bad.map((b) => `${b.rel}: ${b.message}`).join('; ') : ''}`;
      announce($('rtf-result').textContent);
      $('rtf-yes').hidden = true;
      $('rtf-no').textContent = 'Close';
      $('rtf-no').focus();
      await renderProblems();
    } catch (err) {
      $('rtf-result').textContent = err.message;
      $('rtf-yes').disabled = false;
    }
  });
  $('rtf-dialog').addEventListener('close', () => {
    $('rtf-yes').hidden = false;
    $('rtf-no').textContent = 'Not now';
    $('folders-h').focus();
  });

  // ---------- jira ----------

  function renderJira() {
    const j = cfg.jira;
    $('j-type').value = j ? j.type : 'cloud';
    $('j-url').value = j ? j.baseUrl : '';
    $('j-email').value = j ? j.email : '';
    $('j-project').value = j ? j.project : '';
    $('j-issue-type').value = j ? j.issueType : 'Task';
    $('j-token').value = '';
    $('j-state').textContent = j ? `Jira is set up for ${j.baseUrl}. ${j.hasToken ? 'A token is saved.' : 'No token is saved yet.'}` : 'Jira is not set up.';
    syncJiraType();
  }

  function syncJiraType() {
    const cloud = $('j-type').value === 'cloud';
    $('j-email-field').hidden = !cloud;
  }
  $('j-type').addEventListener('change', syncJiraType);

  $('jira-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      cfg = await api('/api/jira/config', {
        method: 'POST',
        body: {
          type: $('j-type').value,
          baseUrl: $('j-url').value.trim(),
          email: $('j-email').value.trim(),
          project: $('j-project').value.trim(),
          issueType: $('j-issue-type').value.trim(),
          token: $('j-token').value,
        },
      });
      renderJira();
      announce('Jira settings saved.');
    } catch (err) {
      alertMessage(err.message);
    }
  });
  $('j-remove').addEventListener('click', async () => {
    if (!window.confirm('Remove the Jira settings and the saved token?')) return;
    cfg = await api('/api/jira/config', { method: 'POST', body: { remove: true } });
    renderJira();
    announce('Jira settings removed.');
  });

  // ---------- problems ----------

  async function renderProblems() {
    const s = await api('/api/summary');
    const ul = $('problems');
    ul.replaceChildren(...s.problems.map((p) => el('li', { text: `${p.label || p.file || p.folder}: ${p.message}` })));
    $('no-problems').hidden = s.problems.length > 0;
  }

  loadAll()
    .then(() => browse(''))
    .catch((err) => alertMessage(err.message));
})();
