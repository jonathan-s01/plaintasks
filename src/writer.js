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

/**
 * Replace exactly one line in a file.
 *
 * The file is re-read first. `expected` must still be present: at `lineIndex` if unchanged, or at a
 * unique shifted position if the file was edited elsewhere. Otherwise a ConflictError is thrown and
 * nothing is written. All other bytes (line endings, BOM, encoding, other lines) are preserved.
 */
function replaceLine(file, { lineIndex, expected, replacement }) {
  if (/[\r\n]/.test(replacement)) throw new Error('Replacement must be a single line');
  const before = readTextFile(file);
  const { lines, eols } = splitLines(before.text);

  let idx = -1;
  if (lines[lineIndex] === expected) idx = lineIndex;
  else {
    const matches = [];
    lines.forEach((l, i) => {
      if (l === expected) matches.push(i);
    });
    if (matches.length === 1) idx = matches[0];
  }
  if (idx < 0) throw new ConflictError('That line changed in the file. Nothing was written. The list has been refreshed.');
  if (lines[idx] === replacement) return { lineIndex: idx, changed: false };

  lines[idx] = replacement;
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
  return { lineIndex: idx, changed: true };
}

module.exports = { replaceLine, readTextFile, decode, encode, ConflictError, UnsupportedFileError };
