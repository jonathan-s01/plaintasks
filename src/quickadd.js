'use strict';

// Quick-add shorthand for the new task box: "call sam; > wayne; due oct 14 2027; pri h; *; inprogress".
// The first part is the task name. Every other part, split on ";", sets one option. Words may be written in full or
// as their first three letters (sta, due, che, pri, imp, inp, ong, que, ask, jir, buc, blo, not, tod).

class QuickError extends Error {}

const SYMBOLS = {
  '*': 'important',
  '+': 'done',
  '<': 'waitingOnMe',
  '>': 'waitingOnOthers',
  '~': 'ongoing',
  '%': 'inProgress',
  '?': 'question',
};

const LABELS = {
  done: 'Done',
  waitingOnMe: 'Waiting on me',
  waitingOnOthers: 'Waiting on others',
  important: 'Important',
  inProgress: 'In progress',
  ongoing: 'Ongoing',
};

const WORDS = [
  { key: 'start', names: ['start'] },
  { key: 'due', names: ['due', 'end'] },
  { key: 'checkin', names: ['checkin', 'check-in', 'check in'] },
  { key: 'today', names: ['today', 'my day', 'myday'] },
  { key: 'priority', names: ['priority'] },
  { key: 'important', names: ['important'] },
  { key: 'inProgress', names: ['inprogress', 'in progress', 'progress'] },
  { key: 'ongoing', names: ['ongoing'] },
  { key: 'waitingOnOthers', names: ['waiting on others', 'waiting others', 'waitingonothers'] },
  { key: 'waitingOnMe', names: ['waiting on me', 'waiting me', 'waitingonme'] },
  { key: 'question', names: ['question'] },
  { key: 'ask', names: ['ask'] },
  { key: 'done', names: ['done'] },
  { key: 'jira', names: ['jira'] },
  { key: 'bucket', names: ['bucket', 'goal'] },
  { key: 'blocked', names: ['blocked by', 'blocked', 'after'] },
  { key: 'note', names: ['note'] },
];

const wordMatches = (w, full) => w === full || (w.length >= 3 && w.length < full.length && full.startsWith(w) && full.length > 2);

/** Matches the start of a part to a keyword. Returns { key, rest } or null. */
function matchWord(part) {
  const tokens = part.split(/\s+/);
  let best = null;
  for (const { key, names } of WORDS) {
    for (const name of names) {
      const nt = name.split(' ');
      if (nt.length > tokens.length) continue;
      if (!nt.every((n, i) => wordMatches(tokens[i].toLowerCase(), n))) continue;
      if (!best || nt.length > best.used) best = { key, used: nt.length };
    }
  }
  return best ? { key: best.key, rest: tokens.slice(best.used).join(' ').trim() } : null;
}

const names = (s) => s.split(/[,\s]+/).filter((x) => x && x.toLowerCase() !== 'and');

function priorityOf(arg) {
  const c = arg.toLowerCase();
  if (['h', 'hi', 'high'].includes(c)) return 'high';
  if (['m', 'med', 'medium', 'normal'].includes(c)) return 'medium';
  if (['l', 'lo', 'low'].includes(c)) return 'low';
  throw new QuickError(`Priority is high, medium or low, not "${arg}".`);
}

function jiraOf(arg) {
  const c = arg.toLowerCase();
  if (['y', 'yes', 'send', 'go'].includes(c)) return 'yes';
  if (['s', 'skip', 'n', 'no', 'never'].includes(c)) return 'skip';
  if (['d', 'default', 'auto', ''].includes(c)) return 'default';
  throw new QuickError(`Jira is yes, skip or default, not "${arg}".`);
}

/**
 * Splits the typed text into the task name and its options. Returns { text, options } where options uses the same
 * keys as the new task form: start, due, checkin, today, priority, flags, waitingNote, asks, jira, buckets, blockedBy, notes.
 */
function parseQuick(input) {
  const parts = String(input == null ? '' : input).split(';').map((p) => p.trim());
  const text = parts.shift() || '';
  const o = { flags: [], notes: [], buckets: [], blockedBy: [], asks: [] };
  const flag = (f) => {
    if (f === 'waitingOnMe') o.flags = o.flags.filter((x) => x !== 'waitingOnOthers');
    if (f === 'waitingOnOthers') o.flags = o.flags.filter((x) => x !== 'waitingOnMe');
    if (!o.flags.includes(f)) o.flags.push(f);
  };
  for (const part of parts) {
    if (!part) continue;
    const sym = /^([*+<>~%?]+)\s*(.*)$/.exec(part);
    if (sym) {
      const fl = [...sym[1]].map((c) => SYMBOLS[c]);
      fl.forEach(flag);
      if (sym[2]) {
        if (fl.includes('question')) o.asks.push(...names(sym[2]));
        else o.notes.push(`${LABELS[fl[0]]}: ${sym[2]}`);
      }
      continue;
    }
    const m = matchWord(part);
    if (!m) throw new QuickError(`Did not understand "${part}". Use words such as due, start, checkin, priority, important, inprogress, ask, jira, bucket, blocked, note, or symbols such as * > < % ~ ?. A task name cannot contain ";".`);
    const { key, rest } = m;
    const need = (what) => {
      if (!rest) throw new QuickError(`"${part}" needs ${what} after it.`);
      return rest;
    };
    switch (key) {
      case 'start':
      case 'due':
      case 'checkin':
        o[key] = need('a date');
        break;
      case 'today':
        o.today = true;
        break;
      case 'priority':
        o.priority = priorityOf(need('high, medium or low'));
        break;
      case 'question':
        flag('question');
        o.asks.push(...names(rest));
        break;
      case 'ask':
        flag('question');
        o.asks.push(...names(need('a name')));
        break;
      case 'jira':
        o.jira = jiraOf(rest);
        break;
      case 'bucket':
        o.buckets.push(...need('a bucket name').split(',').map((x) => x.trim()).filter(Boolean));
        break;
      case 'blocked':
        o.blockedBy.push(need('the name of the task it waits for'));
        break;
      case 'note':
        o.notes.push(need('the note text'));
        break;
      default:
        flag(key);
        if (rest) o.notes.push(`${LABELS[key]}: ${rest}`);
    }
  }
  return { text, options: o };
}

module.exports = { parseQuick, QuickError, LABELS };
