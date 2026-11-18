'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { splitLines } = require('./parser');

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.code = 'conflict';
  }
}

class UnsupportedFileError extends Error {
  constructor(message) {
    super(message);
    this.code = 'unsupported';
  }
}

/** Decode file bytes, remembering the encoding so it can be written back identically. */
function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf8-bom', text: buf.subarray(3).toString('utf8') };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf16le', text: buf.subarray(2).toString('utf16le') };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    if (swapped.length % 2) throw new UnsupportedFileError('Malformed UTF-16 file');
    return { encoding: 'utf16be', text: swapped.swap16().toString('utf16le') };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new UnsupportedFileError('Not UTF-8 or UTF-16 text; skipped to avoid corrupting it');
  }
  if (text.includes('\u0000')) throw new UnsupportedFileError('Looks like a binary file');
  return { encoding: 'utf8', text };
}

function encode(text, encoding) {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
    default:
      return Buffer.from(text, 'utf8');
  }
}

function readTextFile(file) {
  const stat = fs.statSync(file);
  const buf = fs.readFileSync(file);
  const { encoding, text } = decode(buf);
  return { encoding, text, stat, hash: crypto.createHash('sha1').update(buf).digest('hex') };
}

function locate(lines, lineIndex, expected) {
  if (lines[lineIndex] === expected) return lineIndex;
  const matches = [];
  lines.forEach((l, i) => {
    if (l === expected) matches.push(i);
  });
  return matches.length === 1 ? matches[0] : -1;
}

/** Re-reads the file, lets `edit(lines, eols)` change it in place, and writes it back atomically with the same encoding. */
function editFile(file, edit) {
  const before = readTextFile(file);
  const { lines, eols } = splitLines(before.text);
  const original = lines.join('\u0000');
  const result = edit(lines, eols);
  if (lines.join('\u0000') === original) return { ...result, changed: false };
  let out = '';
  for (let i = 0; i < lines.length; i += 1) out += lines[i] + eols[i];

  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.plaintasks-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const unchanged = () => {
    const now = fs.statSync(file);
    return now.mtimeMs === before.stat.mtimeMs && now.size === before.stat.size;
  };
  try {
    const fd = fs.openSync(tmp, 'w', before.stat.mode & 0o7777);
    try {
      fs.writeSync(fd, encode(out, before.encoding));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(tmp, before.stat.mode & 0o7777);
    } catch {
      /* best effort */
    }
    if (!unchanged()) throw new ConflictError('The file changed while saving. Nothing was written. The list has been refreshed.');
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already renamed or never created */
    }
  }
  return { ...result, changed: true };
}

const CHANGED = 'That line changed in the file. Nothing was written. The list has been refreshed.';

/**
 * Replace exactly one line in a file.
 *
 * The file is re-read first. `expected` must still be present: at `lineIndex` if unchanged, or at a
 * unique shifted position if the file was edited elsewhere. Otherwise a ConflictError is thrown and
 * nothing is written. All other bytes (line endings, BOM, encoding, other lines) are preserved.
 */
function replaceLine(file, { lineIndex, expected, replacement }) {
  if (/[\r\n]/.test(replacement)) throw new Error('Replacement must be a single line');
  return editFile(file, (lines) => {
    const idx = locate(lines, lineIndex, expected);
    if (idx < 0) throw new ConflictError(CHANGED);
    lines[idx] = replacement;
    return { lineIndex: idx };
  });
}

/** Replace several lines at once. Every line must still be exactly where it was, or nothing is written. */
function replaceLines(file, changes) {
  for (const c of changes) if (/[\r\n]/.test(c.replacement)) throw new Error('Replacement must be a single line');
  return editFile(file, (lines) => {
    for (const c of changes) if (lines[c.lineIndex] !== c.expected) throw new ConflictError(CHANGED);
    for (const c of changes) lines[c.lineIndex] = c.replacement;
    return {};
  });
}

function defaultEol(eols) {
  return eols.find((e) => e) || '\n';
}

/** Insert new lines directly after the line at `afterIndex` (which must still read `expected`). */
function insertLinesAfter(file, { afterIndex, expected, newLines }) {
  if (newLines.some((l) => /[\r\n]/.test(l))) throw new Error('Inserted lines must be single lines');
  return editFile(file, (lines, eols) => {
    const idx = locate(lines, afterIndex, expected);
    if (idx < 0) throw new ConflictError(CHANGED);
    const eol = eols[idx] || defaultEol(eols);
    const last = eols[idx] === '';
    if (last) eols[idx] = eol;
    lines.splice(idx + 1, 0, ...newLines);
    eols.splice(idx + 1, 0, ...newLines.map((_, i) => (last && i === newLines.length - 1 ? '' : eol)));
    return { lineIndex: idx + 1 };
  });
}

/** Add lines at the end of a file, keeping its line endings. */
function appendLines(file, newLines) {
  if (newLines.some((l) => /[\r\n]/.test(l))) throw new Error('Appended lines must be single lines');
  return editFile(file, (lines, eols) => {
    const eol = defaultEol(eols);
    const endsWithNewline = lines.length > 1 && lines[lines.length - 1] === '';
    const empty = lines.length === 1 && lines[0] === '';
    if (empty) {
      lines.splice(0, 1, ...newLines, '');
      eols.splice(0, 1, ...newLines.map(() => eol), '');
      return { lineIndex: 0 };
    }
    if (endsWithNewline) {
      const at = lines.length - 1;
      lines.splice(at, 0, ...newLines);
      eols.splice(at, 0, ...newLines.map(() => eol));
      return { lineIndex: at };
    }
    const at = lines.length;
    eols[at - 1] = eol;
    lines.push(...newLines);
    eols.push(...newLines.map((_, i) => (i === newLines.length - 1 ? '' : eol)));
    return { lineIndex: at };
  });
}

/** Remove a block of lines that must still read exactly `expected` (used to undo insertions). */
function removeLines(file, { lineIndex, expected }) {
  return editFile(file, (lines, eols) => {
    const fits = (at) => at >= 0 && expected.every((l, i) => lines[at + i] === l);
    let at = fits(lineIndex) ? lineIndex : -1;
    if (at < 0) {
      const hits = [];
      for (let i = 0; i < lines.length; i += 1) if (fits(i)) hits.push(i);
      if (hits.length === 1) [at] = hits;
    }
    if (at < 0) throw new ConflictError(CHANGED);
    const lastEol = eols[at + expected.length - 1];
    lines.splice(at, expected.length);
    eols.splice(at, expected.length);
    if (lastEol === '' && at > 0) eols[at - 1] = '';
    return { lineIndex: at };
  });
}

/** Create a new text file. Never overwrites. */
function createTextFile(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', { flag: 'wx' });
}

module.exports = { replaceLine, replaceLines, insertLinesAfter, appendLines, removeLines, createTextFile, readTextFile, decode, encode, ConflictError, UnsupportedFileError };
