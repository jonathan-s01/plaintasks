'use strict';

const { markerInfo, DEFAULT_SYMBOLS, JIRA_RE, JIRA_LABEL_RE, JIRA_SKIP_RE, JIRA_YES_RE, GOAL_RE, PRIORITY_RE, ID_RE, AFTER_RE, ASK_RE } = require('./parser');
const { findDateTokens, toISO } = require('./dates');

class OpError extends Error {}

function decompose(raw) {
  const mi = markerInfo(raw);
  if (mi) return mi;
  const m = /^([ \t]*)(.*)$/.exec(raw);
  return { indent: m[1], run: '', gap: ' ', body: m[2] };
}

function compose(d) {
  return d.indent + (d.run ? d.run + d.gap : '') + d.body;
}

function symbolFor(flag, symbols) {
  for (const [ch, meaning] of Object.entries(symbols)) if (meaning === flag) return ch;
  const def = Object.entries(DEFAULT_SYMBOLS).find(([, v]) => v === flag);
  return def ? def[0] : null;
}

const runHas = (run, flag, symbols) => [...run].some((c) => symbols[c] === flag);
const runWithout = (run, flag, symbols) => [...run].filter((c) => symbols[c] !== flag).join('');

function runWith(run, flag, symbols) {
  if (runHas(run, flag, symbols)) return run;
  const ch = symbolFor(flag, symbols);
  if (!ch) throw new OpError(`No marker is defined for ${flag}`);
  return flag === 'done' ? ch + run : run + ch;
}

function removeTokens(body, kind, ref) {
  let out = body;
  const toks = findDateTokens(body, ref).filter((t) => t.kind === kind);
  for (const t of toks.sort((a, b) => b.start - a.start)) {
    let s = t.start;
    while (s > 0 && /\s/.test(out[s - 1])) s -= 1;
    out = out.slice(0, s) + out.slice(t.end);
  }
  return out;
}

function appendToken(body, token) {
  const trimmed = body.replace(/\s+$/, '');
  return trimmed ? `${trimmed} ${token}` : token;
}

const TOGGLE_FLAGS = new Set(['waitingOnMe', 'waitingOnOthers', 'important', 'inProgress', 'ongoing', 'question']);

/**
 * Pure line transformation. Returns the new line text (identical to `raw` when nothing changes).
 * ctx: { symbols, unmarkedMode, today }
 */
function applyOp(raw, op, arg, ctx) {
  const symbols = ctx.symbols || DEFAULT_SYMBOLS;
  const today = ctx.today || new Date();
  const d = decompose(raw);
  const todoChar = symbolFor('todo', symbols);

  const fixEmptyRun = () => {
    if (d.run === '' && ctx.unmarkedMode !== 'tasks') d.run = todoChar;
  };

  switch (op) {
    case 'toggleDone':
      return applyOp(raw, runHas(d.run, 'done', symbols) ? 'reopen' : 'done', arg, ctx);
    case 'done': {
      if (runHas(d.run, 'done', symbols) && !arg) return raw;
      d.run = runWith(d.run, 'done', symbols);
      // arg may be the date it was done (YYYY-MM-DD), e.g. a resolution date from Jira.
      const when = typeof arg === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : toISO(today);
      d.body = appendToken(removeTokens(d.body, 'done', today), `done:${when}`);
      return compose(d);
    }
    case 'reopen': {
      if (!runHas(d.run, 'done', symbols)) return raw;
      d.run = runWithout(d.run, 'done', symbols);
      d.body = removeTokens(d.body, 'done', today);
      fixEmptyRun();
      return compose(d);
    }
    case 'exclude': {
      const ch = symbolFor('excluded', symbols);
      if (runHas(d.run, 'excluded', symbols)) return raw;
      d.run = ch;
      return compose(d);
    }
    case 'clearSubtask': {
      if (!runHas(d.run, 'subtask', symbols)) return raw;
      d.run = runWithout(d.run, 'subtask', symbols);
      fixEmptyRun();
      return compose(d);
    }
    case 'todo': {
      if (d.run) return raw;
      d.run = todoChar;
      return compose(d);
    }
    case 'text': {
      // Rewords the task, keeping its tokens (dates, jira:, jira:label, jira:skip, jira:yes, goal:, p:, id:, after:, ask:) in their order.
      const text = String(arg || '').replace(/\s+/g, ' ').trim();
      if (!text) throw new OpError('The new text is empty');
      const spans = findDateTokens(d.body, today).map((t) => [t.start, t.end]);
      for (const re of [new RegExp(JIRA_RE.source, 'g'), new RegExp(JIRA_LABEL_RE.source, 'gi'), new RegExp(JIRA_SKIP_RE.source, 'gi'), new RegExp(JIRA_YES_RE.source, 'gi'), new RegExp(GOAL_RE.source, 'g'), new RegExp(PRIORITY_RE.source, 'gi'), new RegExp(ID_RE.source, 'g'), new RegExp(AFTER_RE.source, 'g'), new RegExp(ASK_RE.source, 'gu')]) {
        let m;
        while ((m = re.exec(d.body))) spans.push([m.index + m[1].length, m.index + m[0].length]);
      }
      const tokens = spans.sort((a, b) => a[0] - b[0]).map(([s, e]) => d.body.slice(s, e).trim());
      d.body = [text, ...tokens].join(' ');
      return compose(d);
    }
    case 'start':
    case 'due':
    case 'checkin': {
      d.body = removeTokens(d.body, op, today);
      if (arg) d.body = appendToken(d.body, `${op}:${arg}`);
      return compose(d);
    }
    case 'today': {
      // arg: YYYY-MM-DD to pick the task for that day, or null to unpick it.
      d.body = removeTokens(d.body, 'today', today);
      if (arg) d.body = appendToken(d.body, `today:${arg}`);
      return compose(d);
    }
    case 'priority': {
      // arg: 'high' or 'low' writes p:high or p:low; anything else (medium) removes the token.
      d.body = d.body.replace(new RegExp(PRIORITY_RE.source, 'gi'), () => '').replace(/[ \t]+$/, '');
      if (arg === 'high' || arg === 'low') d.body = appendToken(d.body, `p:${arg}`);
      return compose(d);
    }
    case 'refId': {
      // arg: the slug for this task's id: token, or null to remove it.
      if (arg && !/^[a-z0-9][a-z0-9-]*$/.test(arg)) throw new OpError('Task ids use lowercase letters, digits and hyphens');
      d.body = d.body.replace(new RegExp(ID_RE.source, 'g'), () => '').replace(/[ \t]+$/, '');
      if (arg) d.body = appendToken(d.body, `id:${arg}`);
      return compose(d);
    }
    case 'after': {
      // arg: ids of the tasks this one waits for. Rewrites every after: token.
      const ids = arg || [];
      if (ids.some((x) => !/^[a-z0-9][a-z0-9-]*$/.test(x))) throw new OpError('Task ids use lowercase letters, digits and hyphens');
      let body = d.body.replace(new RegExp(AFTER_RE.source, 'g'), () => '').replace(/[ \t]+$/, '');
      for (const x of ids) body = appendToken(body, `after:${x}`);
      d.body = body;
      return compose(d);
    }
    case 'jira': {
      let body = d.body;
      const m = JIRA_RE.exec(body);
      if (m) body = body.slice(0, m.index) + body.slice(m.index + m[0].length);
      if (arg) {
        if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(arg)) throw new OpError('Jira keys look like ABC-123');
        body = appendToken(body, `jira:${arg.toUpperCase()}`);
      }
      d.body = body;
      return compose(d);
    }
    case 'jiraSkip': {
      // arg: true adds jira:skip, false removes it.
      d.body = d.body.replace(new RegExp(JIRA_SKIP_RE.source, 'gi'), () => '').replace(/[ \t]+$/, '');
      if (arg) d.body = appendToken(d.body, 'jira:skip');
      return compose(d);
    }
    case 'jiraYes': {
      // arg: true adds jira:yes, false removes it.
      d.body = d.body.replace(new RegExp(JIRA_YES_RE.source, 'gi'), () => '').replace(/[ \t]+$/, '');
      if (arg) d.body = appendToken(d.body, 'jira:yes');
      return compose(d);
    }
    case 'goals': {
      // arg: { own: id of this goal or null, links: ids of goals this task belongs to }. Rewrites every goal: token.
      const ids = [arg && arg.own, ...((arg && arg.links) || [])].filter(Boolean);
      if (ids.some((x) => !/^[a-z0-9][a-z0-9-]*$/.test(x))) throw new OpError('Bucket ids use lowercase letters, digits and hyphens');
      let body = d.body.replace(new RegExp(GOAL_RE.source, 'g'), () => '').replace(/[ \t]+$/, '');
      for (const x of ids) body = appendToken(body, `goal:${x}`);
      d.body = body;
      return compose(d);
    }
    default:
      if (!TOGGLE_FLAGS.has(op)) throw new OpError(`Unknown action ${op}`);
  }

  if (runHas(d.run, op, symbols)) {
    d.run = runWithout(d.run, op, symbols);
    fixEmptyRun();
  } else {
    d.run = runWith(d.run, op, symbols);
    if (op === 'waitingOnMe') d.run = runWithout(d.run, 'waitingOnOthers', symbols);
    if (op === 'waitingOnOthers') d.run = runWithout(d.run, 'waitingOnMe', symbols);
  }
  return compose(d);
}

module.exports = { applyOp, OpError, symbolFor };
