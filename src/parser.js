'use strict';

const { findDateTokens } = require('./dates');

const DEFAULT_SYMBOLS = {
  '+': 'done',
  '@': 'todo',
  '<': 'waitingOnMe',
  '>': 'waitingOnOthers',
  '•': 'subtask',
  '~': 'ongoing',
  '*': 'important',
  '%': 'inProgress',
  $: 'excluded',
};

const MARKER_CHARS = '+@<>•~*%$';
const MARK_RE = /^([ \t]*)([+@<>•~*%$]+)([ \t]*)(.*)$/;
// Without a space after the marker, only these symbols count, so "**bold**", "%", "$5", "~/path" and "~~strike~~" stay plain text.
const STRONG_MARKERS = /[+@<>•]/;
// A line starting with & is a note of the nearest task above it, however many lines lie between.
const NOTE_RE = /^[ \t]*&[ \t]*(.*)$/;
const JIRA_RE = /(^|\s)jira:([A-Za-z][A-Za-z0-9_]*-\d+)(?![\w-])/;
// jira:label on a goal line: sync tags linked tasks with a label instead of making the goal an issue.
const JIRA_LABEL_RE = /(^|\s)jira:label(?![\w-])/i;
// goal:some-id. On a ~ (ongoing) line the first one is that goal's own id; every other one links to a goal.
// p:high and p:low set the priority (no token means medium). id:slug names a task so others can wait for it with after:slug.
const PRIORITY_RE = /(^|\s)p:(high|medium|med|low)(?![\w-])/gi;
const ID_RE = /(^|\s)id:([A-Za-z0-9][A-Za-z0-9-]*)(?![\w-])/g;
const AFTER_RE = /(^|\s)after:([A-Za-z0-9][A-Za-z0-9-]*)(?![\w-])/g;
const GOAL_RE = /(^|\s)goal:([A-Za-z0-9][A-Za-z0-9-]*)(?![\w-])/g;
const HAS_WORD_RE = /[\p{L}\p{N}]/u;

function splitLines(text) {
  const lines = [];
  const eols = [];
  const re = /\r\n|\n|\r/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    lines.push(text.slice(last, m.index));
    eols.push(m[0]);
    last = m.index + m[0].length;
  }
  lines.push(text.slice(last));
  eols.push('');
  return { lines, eols };
}

function indentWidth(str) {
  let w = 0;
  for (const ch of str) w += ch === '\t' ? 4 : 1;
  return w;
}

/** The note text of an "& note" line, or null. Without a space, "&&" and entities like "&amp;" stay plain text. */
function ampNote(line) {
  const m = NOTE_RE.exec(line);
  if (!m || !HAS_WORD_RE.test(m[1])) return null;
  if (!/^[ \t]/.test(line.replace(/^[ \t]*&/, '')) && /^(&|[a-z]+;)/i.test(m[1])) return null;
  return m[1].trim();
}

/** Split a line into indent / marker run / gap / body, or null when it has no marker run. */
function markerInfo(line) {
  const m = MARK_RE.exec(line);
  if (!m || !HAS_WORD_RE.test(m[4])) return null;
  // "~~" is markdown strikethrough, never a marker.
  if (m[2].includes('~~')) return null;
  if (!m[3]) {
    // "+1 for that", "<div>" and similar are not markers.
    if (!STRONG_MARKERS.test(m[2]) || /^\d/.test(m[4]) || (m[2] === '<' && /^\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/i.test(m[4]))) return null;
  }
  return { indent: m[1], run: m[2], gap: m[3] || ' ', body: m[4] };
}

const UNMARKED_WORDS = /^(nothing|none|blank|no marker|no symbol|unmarked|plain|no mark)$/i;

function classifyMeaning(right) {
  const r = right.toLowerCase();
  if (/sub-?task/.test(r)) return 'subtask';
  if (/\b(done|complete|completed|finished)\b/.test(r)) return 'done';
  if (/waiting (on|for) me|my turn|on me\b|for me\b/.test(r)) return 'waitingOnMe';
  if (/someone else|other people|others|them\b|waiting/.test(r)) return 'waitingOnOthers';
  if (/in ?progress|started|doing/.test(r)) return 'inProgress';
  if (/important|priority|urgent/.test(r)) return 'important';
  if (/ongoing|major|outcome|project|big\b/.test(r)) return 'ongoing';
  if (/to[- ]?do|task|open|action/.test(r)) return 'todo';
  if (/\bnotes?\b|text|info/.test(r)) return 'note';
  return null;
}

/** Detect a per-file legend block ("+ = done", "nothing = to do", "• and indenting = subtasks"). */
function parseLegend(lines) {
  const symbols = {};
  const legendLines = new Set();
  let unmarked = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(legend|key)\s*:?\s*$/i.test(line)) {
      legendLines.add(i);
      continue;
    }
    const m = /^\s*(.{1,40}?)\s+=\s+(.{1,80}?)\s*$/.exec(line) || /^\s*([+@<>•~*%]{1,3})\s*=\s*(.{1,80}?)\s*$/.exec(line);
    if (!m) continue;
    const left = m[1].trim();
    const meaning = classifyMeaning(m[2]);
    if (!meaning) continue;
    if (UNMARKED_WORDS.test(left)) {
      if (meaning === 'todo' || meaning === 'note') {
        unmarked = meaning === 'todo' ? 'tasks' : 'notes';
        legendLines.add(i);
      }
      continue;
    }
    const chars = [...left].filter((c) => MARKER_CHARS.includes(c));
    if (!chars.length || meaning === 'note') continue;
    // The remainder of the left side may only be connective words ("and indenting").
    const rest = left.replace(/[+@<>•~*%\s]/g, '').toLowerCase();
    if (rest && !/^(and|or|plus)?(indent\w*|tabs?)?$/.test(rest)) continue;
    for (const c of chars) symbols[c] = meaning;
    legendLines.add(i);
  }
  return { symbols, unmarked, legendLines, hasLegend: legendLines.size > 0 && (Object.keys(symbols).length > 0 || unmarked !== null) };
}

function emptyFlags() {
  return {
    done: false,
    todo: false,
    waitingOnMe: false,
    waitingOnOthers: false,
    ongoing: false,
    important: false,
    inProgress: false,
    subtask: false,
    excluded: false,
  };
}

function stripTokens(origBody, ref) {
  const body = origBody;
  const toks = findDateTokens(body, ref);
  let out = body;
  for (const t of [...toks].sort((x, y) => y.start - x.start)) {
    let s = t.start;
    while (s > 0 && /\s/.test(out[s - 1])) s -= 1;
    out = out.slice(0, s) + out.slice(t.end);
  }
  // Earliest token wins when duplicated.
  const due = toks.find((t) => t.kind === 'due');
  const done = toks.find((t) => t.kind === 'done');
  const checkin = toks.find((t) => t.kind === 'checkin');
  const start = toks.find((t) => t.kind === 'start');
  const picked = toks.find((t) => t.kind === 'today');
  let jira = null;
  const jm = JIRA_RE.exec(out);
  if (jm) {
    jira = jm[2].toUpperCase();
    out = out.slice(0, jm.index) + out.slice(jm.index + jm[0].length);
  }
  let jiraLabel = false;
  out = out.replace(new RegExp(JIRA_LABEL_RE.source, 'gi'), (m, pre) => {
    jiraLabel = true;
    return pre;
  });
  const goals = [];
  out = out.replace(GOAL_RE, (m, pre, id) => {
    if (!goals.includes(id.toLowerCase())) goals.push(id.toLowerCase());
    return pre;
  });
  let priority = 'medium';
  out = out.replace(PRIORITY_RE, (m, pre, v) => {
    if (priority === 'medium') priority = /^low/i.test(v) ? 'low' : /^h/i.test(v) ? 'high' : 'medium';
    return pre;
  });
  let refId = null;
  out = out.replace(ID_RE, (m, pre, id) => {
    refId = refId || id.toLowerCase();
    return pre;
  });
  const waitsFor = [];
  out = out.replace(AFTER_RE, (m, pre, id) => {
    if (!waitsFor.includes(id.toLowerCase())) waitsFor.push(id.toLowerCase());
    return pre;
  });
  return {
    text: out.replace(/\s+/g, ' ').trim(),
    due: due ? due.iso : null,
    dueTime: due ? due.time : null,
    checkin: checkin ? checkin.iso : null,
    checkinTime: checkin ? checkin.time : null,
    doneDate: done ? done.iso : null,
    start: start ? start.iso : null,
    picked: picked ? picked.iso : null,
    priority,
    refId,
    waitsFor,
    jira,
    jiraLabel,
    goals,
  };
}

/**
 * Parse a text file into tasks.
 * options.unmarked: 'notes' | 'tasks' (default for files without a legend)
 * options.today: reference Date for friendly date parsing
 */
function parseText(text, options = {}) {
  const ref = options.today || new Date();
  const { lines, eols } = splitLines(text);
  const legend = parseLegend(lines);
  // A legend's "nothing = to do" is recognised (and its line skipped) but never decides the mode: the folder and per-file settings do.
  const unmarkedMode = options.unmarked || 'notes';
  const symbols = { ...DEFAULT_SYMBOLS, ...legend.symbols };

  const info = lines.map((l, i) => (legend.legendLines.has(i) ? null : markerInfo(l)));
  const isBlank = (i) => lines[i].trim() === '';
  const nextNonBlank = (i) => {
    for (let j = i + 1; j < lines.length && j <= i + 2; j += 1) if (!isBlank(j)) return j;
    return -1;
  };

  const items = [];
  const groups = [];
  let stack = [];
  let prevWasGroup = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (legend.legendLines.has(i)) continue;
    if (isBlank(i)) {
      stack = [];
      prevWasGroup = false;
      continue;
    }
    const ampBody = ampNote(line);
    if (ampBody) {
      let host = null;
      for (let k = items.length - 1; k >= 0; k -= 1) {
        if (items[k].kind === 'task') {
          host = items[k];
          break;
        }
      }
      if (host) {
        host.notes.push({ lineIndex: i, text: ampBody, amp: true });
        continue;
      }
    }
    const mi = info[i];
    const indentStr = /^[ \t]*/.exec(line)[0];
    const indent = indentWidth(indentStr);

    if (mi) {
      prevWasGroup = false;
      const flags = emptyFlags();
      for (const ch of mi.run) {
        const meaning = symbols[ch];
        if (meaning && meaning in flags) flags[meaning] = true;
      }
      const parsed = stripTokens(mi.body, ref);
      const item = makeTask(i, line, indent, flags, parsed, groups, false);
      attach(item, stack, items);
      continue;
    }

    // Unmarked line. A deleted ($) line only keeps what is indented under it; later lines are no longer its notes.
    const cut = stack.findIndex((s) => s.flags.excluded && s.indent >= indent);
    if (cut >= 0) stack = stack.slice(0, cut);
    const trimmed = line.trim();
    const nn = nextNonBlank(i);
    const nextIsMarked = nn >= 0 && info[nn] !== null;
    const endsColon = /:$/.test(trimmed);
    const canBeGroup =
      unmarkedMode === 'notes'
        ? (stack.length === 0 || endsColon || prevWasGroup) && nextIsMarked
        : endsColon && nn >= 0;
    if (canBeGroup) {
      while (groups.length && groups[groups.length - 1].indent >= indent) groups.pop();
      groups.push({ indent, text: trimmed.replace(/:$/, '').trim() });
      stack = [];
      prevWasGroup = true;
      continue;
    }
    prevWasGroup = false;

    if (unmarkedMode === 'tasks') {
      const flags = emptyFlags();
      flags.todo = true;
      const parsed = stripTokens(trimmed, ref);
      const item = makeTask(i, line, indent, flags, parsed, groups, true);
      attach(item, stack, items);
      continue;
    }

    if (stack.length) {
      let target = null;
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].indent < indent) {
          target = stack[k];
          break;
        }
      }
      target = target || stack[stack.length - 1];
      target.notes.push({ lineIndex: i, text: trimmed });
      continue;
    }

    items.push({
      kind: 'unmarked',
      lineIndex: i,
      raw: line,
      indent,
      text: trimmed,
      group: groupPath(groups),
      parent: -1,
      children: [],
      flags: emptyFlags(),
      notes: [],
    });
  }

  // A line marked $ is deleted from the app but kept in the file; so is everything nested under it.
  const exclude = (it) => {
    it.kind = 'excluded';
    for (const c of it.children) exclude(items[c]);
  };
  for (const it of items) if (it.kind === 'task' && it.flags.excluded) exclude(it);

  return { lines, eols, items, legend: { symbols, unmarked: legend.unmarked, hasLegend: legend.hasLegend, lines: [...legend.legendLines] }, unmarkedMode, symbols };
}

function groupPath(groups) {
  return groups.map((g) => g.text).join(' › ');
}

function makeTask(lineIndex, raw, indent, flags, parsed, groups, implicit) {
  return {
    kind: 'task',
    lineIndex,
    raw,
    indent,
    text: parsed.text,
    flags,
    due: parsed.due,
    dueTime: parsed.dueTime,
    checkin: parsed.checkin,
    checkinTime: parsed.checkinTime,
    doneDate: parsed.doneDate,
    start: parsed.start,
    picked: parsed.picked,
    priority: parsed.priority,
    refId: parsed.refId,
    waitsFor: parsed.waitsFor,
    jira: parsed.jira,
    jiraLabel: parsed.jiraLabel,
    goalId: flags.ongoing && parsed.goals.length ? parsed.goals[0] : null,
    goalLinks: flags.ongoing ? parsed.goals.slice(1) : parsed.goals,
    implicit,
    group: groupPath(groups),
    parent: -1,
    children: [],
    notes: [],
    depth: 0,
  };
}

function attach(item, stack, items) {
  if (item.flags.subtask) {
    while (stack.length && (stack[stack.length - 1].indent > item.indent || (stack[stack.length - 1].indent === item.indent && stack[stack.length - 1].flags.subtask))) stack.pop();
  } else {
    while (stack.length && stack[stack.length - 1].indent >= item.indent) stack.pop();
  }
  const parent = stack.length ? stack[stack.length - 1] : null;
  item.index = items.length;
  if (parent) {
    item.parent = parent.index;
    item.depth = parent.depth + 1;
    parent.children.push(item.index);
  }
  items.push(item);
  stack.push(item);
}

module.exports = {
  GOAL_RE, ampNote, parseText, splitLines, markerInfo, indentWidth, DEFAULT_SYMBOLS, MARKER_CHARS, stripTokens, JIRA_RE, JIRA_LABEL_RE, PRIORITY_RE, ID_RE, AFTER_RE };
