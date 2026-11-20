'use strict';

// Goals: any ~ (ongoing) task. A task links to a goal with a goal:id token on its own line; the goal's line carries
// that id as its first goal: token, added from a slug of its text the first time something links to it, so the link
// survives the goal being reworded. Installed onto App.prototype by app.js.

const isGoal = (t) => t.kind === 'task' && t.flags.ongoing;

function slugOf(text) {
  const words = text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) || [];
  let out = '';
  for (const w of words) {
    if (out && out.length + w.length + 1 > 32) break;
    out = out ? `${out}-${w}` : w.slice(0, 32);
  }
  return out || 'goal';
}

/** Goals in index order, and a map from goal id to the goal (first one wins when an id is duplicated). */
function goalIndex(index) {
  const goals = index.tasks.filter(isGoal);
  const byId = new Map();
  for (const g of goals) if (g.goalId && !byId.has(g.goalId)) byId.set(g.goalId, g);
  return { goals, byId };
}

/** The goals a task is linked to, in token order. Tokens that match no goal are skipped. */
function linkedGoals(index, t, byId = goalIndex(index).byId) {
  return (t.goalLinks || []).map((id) => byId.get(id)).filter((g) => g && g.id !== t.id);
}

/** Tasks linked to a goal, in index order. */
function goalMembers(index, g) {
  if (!g.goalId) return [];
  return index.tasks.filter((t) => t.id !== g.id && (t.goalLinks || []).includes(g.goalId));
}

function install(App, HttpError) {
  /** Goals for the chooser: open goals, plus done ones the task is already linked to. */
  App.prototype.goalChoices = function goalChoices(id) {
    const t = this.task(id);
    const { goals } = goalIndex(this.index);
    const mine = new Set(t.goalLinks || []);
    return {
      task: t.text,
      goals: goals
        .filter((g) => g.id !== t.id && (!g.flags.done || (g.goalId && mine.has(g.goalId))))
        .map((g) => ({
          id: g.id,
          text: g.text,
          done: g.flags.done,
          file: g.fileLabel,
          linked: !!(g.goalId && mine.has(g.goalId)),
          count: goalMembers(this.index, g).length,
        })),
    };
  };

  /** Sets which goals a task belongs to. value.ids: the goal task ids to keep or link; every other goal is unlinked. */
  App.prototype.goalSet = function goalSet(t, value) {
    const wanted = [...new Set(Array.isArray(value && value.ids) ? value.ids.map(String) : [])];
    if (wanted.includes(t.id)) throw new HttpError(400, 'A goal cannot belong to itself.');
    const goals = wanted.map((gid) => {
      const g = this.index.get(gid);
      if (!g) throw new HttpError(409, 'A goal changed since the list was shown. Nothing was written. The list has been refreshed.', 'conflict');
      if (!isGoal(g)) throw new HttpError(400, `Not a goal: ${g.text}. Goals are ongoing tasks, marked with ~.`);
      return g;
    });
    const fileOf = t.file;
    const lineOf = t.lineIndex;
    // Collect this action's writes on a fresh stack, so they become one undo step (lineWrite trims the real stack).
    const saved = this.undoStack;
    this.undoStack = [];
    const finish = () => {
      const steps = this.undoStack;
      this.undoStack = saved;
      if (steps.length) this.pushUndo(steps.length === 1 ? steps[0] : { type: 'multi', steps, text: t.text });
      return steps.length;
    };
    const ids = [];
    try {
      for (const g0 of goals) {
        let g = g0;
        if (!g.goalId) {
          const taken = new Set();
          for (const x of this.index.tasks) {
            for (const v of [x.goalId, x.refId, ...(x.goalLinks || []), ...(x.waitsFor || [])]) if (v) taken.add(v);
          }
          const base = slugOf(g.text);
          let slug = base;
          for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
          const r = this.lineWrite(g, 'goals', { own: slug, links: g.goalLinks || [] });
          g = r ? this.index.get(r.focusId) : g;
          if (!g || g.goalId !== slug) throw new HttpError(500, `Could not give the goal an id: ${g0.text}`);
        }
        ids.push(g.goalId);
      }
      // Re-read the task: writing a goal id may have changed its line (when the goal sits in the same file).
      const cur = this.index.get(this.idAt(fileOf, lineOf)) || this.index.get(t.id);
      if (!cur || cur.text !== t.text) throw new HttpError(409, 'The file changed since the list was shown. Nothing was written. The list has been refreshed.', 'conflict');
      const { byId } = goalIndex(this.index);
      // Keep tokens that point at no known goal, so a goal in a file that is not indexed right now is not lost.
      const unknown = (cur.goalLinks || []).filter((x) => !byId.has(x));
      const links = [...ids, ...unknown.filter((x) => !ids.includes(x))];
      const r = this.lineWrite(cur, 'goals', { own: cur.goalId, links });
      const wrote = finish();
      const names = goals.map((g) => g.text);
      const message = names.length
        ? `Linked to ${names.length > 1 ? 'goals' : 'goal'}: ${names.join('; ')}. Task: ${t.text}`
        : `Not linked to any goal: ${t.text}`;
      if (!wrote) return { ok: true, message: `No change. ${message}` };
      return { ok: true, message, undo: true, focusId: r ? r.focusId : this.idAt(fileOf, lineOf) };
    } catch (err) {
      // Roll back goal ids already written, so a failure leaves the files as they were.
      if (this.undoStack !== saved && finish()) {
        try { this.undo(); } catch { /* the error below explains the first failure */ }
      }
      throw err;
    }
  };
}

module.exports = { install, isGoal, slugOf, goalIndex, linkedGoals, goalMembers };
