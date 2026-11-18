#!/usr/bin/env node
'use strict';

const { execFile } = require('node:child_process');
const { App } = require('../src/app');
const { createServer } = require('../src/server');
const { configDir, sessionToken } = require('../src/config');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('help') || flag('h')) {
  console.log(`plaintasks - accessible to-do manager for your plain-text notes

Usage: plaintasks [--port 4747] [--no-open]

Config: ${configDir()}/config.json (folders to watch, Jira URL; the Jira token lives in the macOS Keychain)
Env:    PLAINTASKS_CONFIG_DIR, PLAINTASKS_PORT, PLAINTASKS_JIRA_TOKEN`);
  process.exit(0);
}

const port = Number(opt('port') || process.env.PLAINTASKS_PORT || 4747);
const app = new App();
const server = createServer(app, { token: sessionToken(configDir()) });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Is plaintasks already running? Try --port ${port + 1}.`);
  else console.error(err.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}/${app.config.folders.length ? '' : 'setup'}`;
  app.start();
  console.log(`plaintasks is running at ${url}`);
  console.log(`Watching ${app.config.folders.length} folder(s). Press Control-C to stop.`);
  if (!flag('no-open') && process.platform === 'darwin') execFile('open', ['-a', 'Safari', url], () => {});
});

const shutdown = () => {
  app.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
