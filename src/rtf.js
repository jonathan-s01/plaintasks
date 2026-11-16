'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const defaultExec = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

function within(root, target) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function uniqueTrashPath(trashDir, name) {
  let candidate = path.join(trashDir, name);
  let n = 1;
  const { name: base, ext } = path.parse(name);
  while (fs.existsSync(candidate)) {
    candidate = path.join(trashDir, `${base} ${Date.now()}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

function moveToTrash(file, trashDir) {
  fs.mkdirSync(trashDir, { recursive: true });
  const dest = uniqueTrashPath(trashDir, path.basename(file));
  try {
    fs.renameSync(file, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(file, dest);
    fs.unlinkSync(file);
  }
  return dest;
}

/**
 * Convert .rtf files to .txt in place using macOS textutil. The caller must have obtained explicit
 * confirmation. The original .rtf is moved to the Trash (recoverable) only after the .txt exists.
 * Never overwrites an existing .txt.
 */
function convertRtfFiles({ folderPath, rels, exec = defaultExec, trashDir = path.join(os.homedir(), '.Trash') }) {
  const root = fs.realpathSync(folderPath);
  return rels.map((rel) => {
    try {
      const abs = fs.realpathSync(path.resolve(folderPath, rel));
      if (!within(root, abs) || path.extname(abs).toLowerCase() !== '.rtf') return { rel, status: 'failed', message: 'Not an .rtf file inside the chosen folder' };
      const out = abs.replace(/\.rtf$/i, '.txt');
      if (fs.existsSync(out)) return { rel, status: 'skipped', message: `${path.basename(out)} already exists; left both files alone` };
      const tmp = path.join(path.dirname(abs), `.${path.basename(out)}.plaintasks-convert.tmp`);
      try {
        exec('textutil', ['-convert', 'txt', '-encoding', 'UTF-8', '-output', tmp, abs]);
        if (!fs.existsSync(tmp)) throw new Error('textutil produced no output');
        fs.renameSync(tmp, out);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* nothing to clean */
        }
      }
      try {
        moveToTrash(abs, trashDir);
        return { rel, status: 'converted', message: `Converted to ${path.basename(out)}; the .rtf was moved to the Trash` };
      } catch (err) {
        return { rel, status: 'converted', message: `Converted to ${path.basename(out)}, but the .rtf could not be moved to the Trash (${err.message}) and was left in place` };
      }
    } catch (err) {
      return { rel, status: 'failed', message: err.message.split('\n')[0] };
    }
  });
}

module.exports = { convertRtfFiles };
