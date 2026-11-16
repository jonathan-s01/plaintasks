'use strict';

const { execFileSync } = require('node:child_process');

const SERVICE = 'plaintasks-jira';
const ACCOUNT = 'default';
const defaultExec = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).toString();

/** Jira token lookup: PLAINTASKS_JIRA_TOKEN env var first, then the macOS Keychain. Never a file. */
function getJiraToken({ env = process.env, exec = defaultExec, platform = process.platform } = {}) {
  if (env.PLAINTASKS_JIRA_TOKEN) return env.PLAINTASKS_JIRA_TOKEN;
  if (platform !== 'darwin') return null;
  try {
    return exec('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']).trim() || null;
  } catch {
    return null;
  }
}

function setJiraToken(token, { exec = defaultExec, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('Keychain is only available on macOS. Set the PLAINTASKS_JIRA_TOKEN environment variable instead.');
  exec('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', token]);
}

function clearJiraToken({ exec = defaultExec, platform = process.platform } = {}) {
  if (platform !== 'darwin') return;
  try {
    exec('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
  } catch {
    /* nothing stored */
  }
}

module.exports = { getJiraToken, setJiraToken, clearJiraToken };
