'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./app');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/setup.js': ['setup.js', 'text/javascript; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const PAGES = { '/': 'index.html', '/setup': 'setup.html' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createServer(app, { token = crypto.randomBytes(24).toString('hex') } = {}) {
  const clients = new Set();
  let server;

  app.index.on('change', (rev) => {
    for (const res of clients) res.write(`event: changed\ndata: ${JSON.stringify({ rev, recentlyWrote: Date.now() - app.lastWriteAt < 3000 })}\n\n`);
  });

  const hostOk = (req) => {
    const port = server.address() && server.address().port;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(req.headers.host)) return false;
    const origin = req.headers.origin;
    return !origin || allowed.some((h) => origin === `http://${h}`);
  };

  const route = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const q = url.searchParams;

    if (req.method === 'GET' && PAGES[p]) {
      const html = fs.readFileSync(path.join(PUBLIC, PAGES[p]), 'utf8').replace('__TOKEN__', token);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && STATIC[p]) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, STATIC[p][0])), STATIC[p][1]);
    }
    if (!p.startsWith('/api/')) return send(res, 404, { ok: false, message: 'Not found' });

    const supplied = req.headers['x-plaintasks-token'] || q.get('t');
    const a = Buffer.from(String(supplied || ''));
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'Missing or wrong session token. Reload the page.');

    if (req.method === 'GET') {
      switch (p) {
        case '/api/events':
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', ...SECURITY_HEADERS });
          res.write(': connected\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return undefined;
        case '/api/summary':
          return send(res, 200, app.summary());
        case '/api/view':
          return send(res, 200, app.view({ view: q.get('view'), q: q.get('q') || '', showCompleted: q.get('completed') === '1', changedOnly: q.get('changed') === '1' }));
        case '/api/search':
          return send(res, 200, app.searchTasks(q.get('q') || ''));
        case '/api/detail':
          return send(res, 200, app.detail(q.get('id')));
        case '/api/goals':
          return send(res, 200, app.goalChoices(q.get('id')));
        case '/api/config':
          return send(res, 200, app.publicConfig());
        case '/api/browse':
          return send(res, 200, app.browse(q.get('path')));
        case '/api/tree':
          return send(res, 200, app.folderTree(Number(q.get('i'))));
        case '/api/rtf':
          return send(res, 200, app.rtfScan(Number(q.get('i'))));
        case '/api/jira/issue':
          return send(res, 200, await app.jiraIssue(q.get('key') || ''));
        default:
          return send(res, 404, { ok: false, message: 'Not found' });
      }
    }

    if (req.method === 'POST') {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON required');
      const body = await readBody(req);
      switch (p) {
        case '/api/action':
          return send(res, 200, await app.action(body));
        case '/api/undo':
          return send(res, 200, app.undo());
        case '/api/master':
          return send(res, 200, app.setMaster(body));
        case '/api/folders':
          return send(res, 200, app.setFolders(body.folders));
        case '/api/rtf/convert':
          return send(res, 200, app.rtfConvert(Number(body.i), body.files, body.confirm));
        case '/api/jira/config':
          return send(res, 200, app.setJira(body));
        case '/api/jira/create':
          return send(res, 200, await app.jiraCreate(body));
        default:
          return send(res, 404, { ok: false, message: 'Not found' });
      }
    }
    return send(res, 405, { ok: false, message: 'Method not allowed' });
  };

  server = http.createServer((req, res) => {
    if (!hostOk(req)) return send(res, 403, { ok: false, message: 'Forbidden host' });
    return route(req, res).catch((err) => {
      if (err instanceof HttpError) return send(res, err.status, { ok: false, message: err.message, code: err.code });
      console.error(err);
      return send(res, 500, { ok: false, message: 'Unexpected error' });
    });
  });
  server.token = token;
  server.on('close', () => {
    for (const r of clients) r.end();
  });
  return server;
}

module.exports = { createServer };
