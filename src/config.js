'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const UNMARKED_MODES = ['notes', 'tasks'];

function configDir(env = process.env) {
  return env.PLAINTASKS_CONFIG_DIR || path.join(os.homedir(), '.config', 'plaintasks');
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${file}: ${err.message}`);
  }
}

function cleanRel(rel) {
  if (typeof rel !== 'string') throw new Error('Paths must be strings');
  const norm = path.posix.normalize(rel.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '');
  if (!norm || norm === '.' || norm.startsWith('..') || path.posix.isAbsolute(norm)) throw new Error(`Invalid relative path: ${rel}`);
  return norm;
}

/** Validate and normalise one watched-folder entry. Throws with a readable message. */
function normalizeFolder(f, { mustExist = true } = {}) {
  if (!f || typeof f.path !== 'string') throw new Error('Folder path is required');
  const abs = path.resolve(expandHome(f.path.trim()));
  if (mustExist) {
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new Error(`Folder or file not found: ${abs}`);
    }
    if (st.isFile()) {
      const ext = path.extname(abs).toLowerCase();
      if (ext === '.rtf') throw new Error('RTF files must be converted to .txt first. Add the folder that contains it to get the conversion offer.');
      if (!['.txt', '.md', '.text'].includes(ext)) throw new Error(`Only .txt, .md and .text files can be added: ${abs}`);
    } else if (!st.isDirectory()) throw new Error(`Not a folder or text file: ${abs}`);
  }
  const unmarked = f.unmarked || 'notes';
  if (!UNMARKED_MODES.includes(unmarked)) throw new Error('Unmarked lines must be "notes" or "tasks"');
  const overrides = {};
  for (const [rel, mode] of Object.entries(f.overrides || {})) {
    if (!UNMARKED_MODES.includes(mode)) throw new Error('Unmarked lines must be "notes" or "tasks"');
    overrides[cleanRel(rel)] = mode;
  }
  return {
    path: abs,
    unmarked,
    excluded: [...new Set((f.excluded || []).map(cleanRel))].sort(),
    overrides,
  };
}

function defaultConfig() {
  return { folders: [], jira: null, masterFile: null };
}

function loadConfig(dir) {
  const raw = readJson(path.join(dir, 'config.json'), defaultConfig());
  const cfg = { ...defaultConfig(), ...raw };
  if (typeof cfg.masterFile !== 'string' || !cfg.masterFile) cfg.masterFile = null;
  cfg.folders = (cfg.folders || []).map((f) => {
    try {
      return normalizeFolder(f, { mustExist: false });
    } catch {
      return null;
    }
  }).filter(Boolean);
  return cfg;
}

function saveConfig(dir, cfg) {
  writeJsonAtomic(path.join(dir, 'config.json'), cfg);
}

const DEFAULT_LIST = 'mylist';
const SORT_MODES = ['manual', 'due', 'checkin', 'created', 'type', 'name'];

function loadState(dir) {
  const s = readJson(path.join(dir, 'state.json'), { dismissed: {} });
  s.dismissed = s.dismissed || {};
  const clean = (keys) => (Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : []);
  const lists = Array.isArray(s.lists)
    ? s.lists.filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string').map((l) => ({
      id: l.id,
      name: l.name,
      keys: clean(l.keys),
      folder: typeof l.folder === 'string' ? l.folder : '',
      file: typeof l.file === 'string' ? l.file : '',
      sort: SORT_MODES.includes(l.sort) ? l.sort : 'manual',
    }))
    : [];
  const mine = lists.find((l) => l.id === DEFAULT_LIST);
  if (mine) lists.splice(lists.indexOf(mine), 1);
  lists.unshift(mine || { id: DEFAULT_LIST, name: 'My list', keys: clean(s.mylist), folder: '', file: '', sort: 'manual' });
  s.lists = lists;
  delete s.mylist;
  if (typeof s.lastList !== 'string' || !lists.some((l) => l.id === s.lastList)) s.lastList = DEFAULT_LIST;
  s.noteOf = s.noteOf && typeof s.noteOf === 'object' ? s.noteOf : {};
  s.created = s.created && typeof s.created === 'object' ? s.created : {};
  s.reviewed = s.reviewed && typeof s.reviewed === 'object' ? s.reviewed : {};
  return s;
}

function saveState(dir, state) {
  writeJsonAtomic(path.join(dir, 'state.json'), state);
}

/** A random token kept in the config folder (mode 0600) so pages left open stay valid across restarts. */
function sessionToken(dir) {
  const file = path.join(dir, 'session-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(existing)) return existing;
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

module.exports = { sessionToken, DEFAULT_LIST, SORT_MODES, configDir, loadConfig, saveConfig, loadState, saveState, normalizeFolder, expandHome, cleanRel, UNMARKED_MODES };
