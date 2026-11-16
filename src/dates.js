'use strict';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));
const DAY_ABBR = DAYS.map((d) => d.slice(0, 3));

function pad(n) {
  return String(n).padStart(2, '0');
}

function toISO(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, n) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + n);
  return d;
}

function lookup(word, full, abbr, extra = []) {
  const w = word.toLowerCase().replace(/\.$/, '');
  for (let i = 0; i < full.length; i += 1) {
    if (w === full[i] || w === abbr[i] || extra[i] === w) return i;
  }
  return -1;
}

const DAY_ALIASES = { tues: 2, thur: 4, thurs: 4 };
const dayIndex = (w) => {
  const key = w.toLowerCase().replace(/\.$/, '');
  if (key in DAY_ALIASES) return DAY_ALIASES[key];
  return lookup(key, DAYS, DAY_ABBR);
};
const monthIndex = (w) => lookup(w, MONTHS, MONTH_ABBR, MONTHS.map((m, i) => (i === 8 ? 'sept' : null)));

function validDate(y, m, d) {
  const date = new Date(y, m, d);
  return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date : null;
}

// Month/day without a year resolves to the next occurrence on or after ref.
function monthDay(monthIdx, day, year, ref) {
  if (year != null) return validDate(year, monthIdx, day);
  const today = startOfDay(ref);
  let d = validDate(today.getFullYear(), monthIdx, day);
  if (d && d < today) d = validDate(today.getFullYear() + 1, monthIdx, day);
  return d;
}

/**
 * Parse a friendly date into an ISO string (YYYY-MM-DD) or null.
 * Accepts: 2026-11-20, today, tomorrow, fri, friday, nov 20, 20 nov, nov 20 2027, +3d, +2w, in 3 days.
 */
function parseFriendly(input, ref = new Date()) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  const today = startOfDay(ref);

  const iso = fromISO(s);
  if (iso) return toISO(iso);
  if (s === 'today') return toISO(today);
  if (s === 'tomorrow' || s === 'tom') return toISO(addDays(today, 1));
  if (s === 'yesterday') return toISO(addDays(today, -1));

  let m = /^(?:\+|in )\s*(\d{1,3})\s*(d|day|days|w|wk|wks|week|weeks)$/.exec(s);
  if (m) {
    const n = Number(m[1]) * (m[2][0] === 'w' ? 7 : 1);
    return toISO(addDays(today, n));
  }

  m = /^(?:next )?([a-z]+)$/.exec(s);
  if (m) {
    const di = dayIndex(m[1]);
    if (di >= 0) {
      const next = s.startsWith('next ');
      let delta = (di - today.getDay() + 7) % 7;
      if (next && delta === 0) delta = 7;
      return toISO(addDays(today, delta));
    }
  }

  m = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(s);
  if (m) {
    const mi = monthIndex(m[1]);
    if (mi >= 0) {
      const d = monthDay(mi, Number(m[2]), m[3] ? Number(m[3]) : null, today);
      return d ? toISO(d) : null;
    }
  }

  m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?: (\d{4}))?$/.exec(s);
  if (m) {
    const mi = monthIndex(m[2]);
    if (mi >= 0) {
      const d = monthDay(mi, Number(m[1]), m[3] ? Number(m[3]) : null, today);
      return d ? toISO(d) : null;
    }
  }
  return null;
}

const WORD = '[A-Za-z]+\\.?';
const VALUE = [
  '\\d{4}-\\d{2}-\\d{2}',
  '\\+\\d{1,3}[dw]',
  `${WORD}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?(?![\\w-])`,
  `\\d{1,2}(?:st|nd|rd|th)?\\s+${WORD}(?:\\s+\\d{4})?(?![\\w-])`,
  '[A-Za-z]+(?![\\w-])',
].join('|');
const TOKEN_RE = new RegExp(`(^|\\s)(due|done):(${VALUE})`, 'gi');

/**
 * Find `due:` / `done:` tokens. Returns [{kind, start, end, raw, iso}] where start/end span the
 * token only (not the leading whitespace). Tokens whose value cannot be parsed are ignored.
 */
function findDateTokens(text, ref = new Date()) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    const start = m.index + m[1].length;
    // Try the full value first, then just its first word ("due:fri 2 things" -> "fri").
    const candidates = [m[3], m[3].split(/\s+/)[0]];
    for (const raw of candidates) {
      const iso = parseFriendly(raw, ref);
      if (iso) {
        out.push({ kind: m[2].toLowerCase(), start, end: start + m[2].length + 1 + raw.length, raw, iso });
        break;
      }
    }
  }
  return out;
}

function daysBetween(fromIso, toIso) {
  const a = fromISO(fromIso);
  const b = fromISO(toIso);
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

function formatDate(iso, ref = new Date()) {
  const d = fromISO(iso);
  if (!d) return iso;
  const base = `${DAY_ABBR[d.getDay()][0].toUpperCase()}${DAY_ABBR[d.getDay()].slice(1)} ${MONTH_ABBR[d.getMonth()][0].toUpperCase()}${MONTH_ABBR[d.getMonth()].slice(1)} ${d.getDate()}`;
  return d.getFullYear() === ref.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

function relativeDue(iso, ref = new Date()) {
  const n = daysBetween(toISO(ref), iso);
  if (n < -1) return { state: 'overdue', text: `overdue by ${-n} days`, days: n };
  if (n === -1) return { state: 'overdue', text: 'overdue by 1 day', days: n };
  if (n === 0) return { state: 'today', text: 'due today', days: n };
  if (n === 1) return { state: 'soon', text: 'due tomorrow', days: n };
  if (n <= 7) return { state: 'soon', text: `due in ${n} days`, days: n };
  return { state: 'later', text: `due in ${n} days`, days: n };
}

module.exports = { parseFriendly, findDateTokens, toISO, fromISO, addDays, daysBetween, formatDate, relativeDue, startOfDay };
