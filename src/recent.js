'use strict';

/**
 * Recently added: when a task first appears in the index, whichever way it got there
 * (the app, the API, or an edit to the file), its time is kept in state.json under addedAt,
 * keyed by listKey. Tasks present at startup are the baseline and are not counted.
 * A task whose text was edited or that moved to another file keeps its place rather than counting as new.
 */

const RECENT_COUNT = 15;
const KEEP = 200;

const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

function overlap(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n += 1;
  return n / Math.max(x.size, y.size);
}

function snapshot(tasks) {
  return new Map(tasks.map((t) => [t.listKey, { text: t.text, file: t.file }]));
}

/** New keys that are really edits or moves of a vanished task, as [newKey, oldKey] pairs. */
function pairRenames(added, removed) {
  const pairs = [];
  const left = new Map(removed);
  for (const [key, t] of added) {
    let best = null;
    let score = 0;
    for (const [oldKey, o] of left) {
      const s = o.text === t.text ? 2 : o.file === t.file ? overlap(o.text, t.text) : 0;
      if (s > score) {
        best = oldKey;
        score = s;
      }
    }
    if (best && score >= 0.5) {
      pairs.push([key, best]);
      left.delete(best);
    }
  }
  return pairs;
}

function install(App) {
  const proto = App.prototype;

  proto.trackAdded = function trackAdded() {
    if (!this.stateData.addedAt || typeof this.stateData.addedAt !== 'object') this.stateData.addedAt = {};
    this.knownTasks = snapshot(this.index.tasks);
    this.knownFolders = JSON.stringify(this.config.folders);
    this.index.on('change', () => this.noteAdded());
  };

  proto.noteAdded = function noteAdded() {
    const now = snapshot(this.index.tasks);
    const before = this.knownTasks || now;
    this.knownTasks = now;
    // Tasks in a folder that was just added to Settings were not added just now.
    const folders = JSON.stringify(this.config.folders);
    if (folders !== this.knownFolders) {
      this.knownFolders = folders;
      return;
    }
    const added = [...now].filter(([k]) => !before.has(k));
    if (!added.length) return;
    const removed = [...before].filter(([k]) => !now.has(k));
    const at = this.stateData.addedAt;
    const renamed = new Map(pairRenames(added, removed));
    const stamp = this.now().toISOString();
    let changed = false;
    for (const [key] of added) {
      const old = renamed.get(key);
      if (old) {
        if (at[old]) {
          at[key] = at[old];
          delete at[old];
          changed = true;
        }
      } else {
        at[key] = stamp;
        changed = true;
      }
    }
    if (!changed) return;
    const keys = Object.keys(at);
    if (keys.length > KEEP) {
      keys.sort((a, b) => at[b].localeCompare(at[a])).slice(KEEP).forEach((k) => delete at[k]);
    }
    this.saveState();
  };
}

/** The newest tasks first, open and done, at most RECENT_COUNT. */
function recentTasks(index, state) {
  const at = state.addedAt || {};
  return index.tasks
    .filter((t) => at[t.listKey])
    .sort((a, b) => at[b.listKey].localeCompare(at[a.listKey]) || a.line - b.line)
    .slice(0, RECENT_COUNT);
}

module.exports = { install, recentTasks, pairRenames, RECENT_COUNT };
