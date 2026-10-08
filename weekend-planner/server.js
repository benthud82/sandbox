#!/usr/bin/env node
/**
 * Weekend Planner – zero-dependency local server.
 *
 *   node server.js            → http://localhost:4747
 *   PORT=8080 node server.js  → custom port
 *
 * Serves the static site from this folder and persists the plan to
 * data/plan.json. If data/plan.json does not exist it is created from
 * data/plan.default.json on first load.
 *
 * API:
 *   GET  /api/plan        → current plan (JSON)
 *   PUT  /api/plan        → replace plan (JSON body)
 *   POST /api/reset       → reset to plan.default.json
 *   GET  /api/health      → { ok: true }
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PLAN_FILE = path.join(DATA_DIR, 'plan.json');
const DEFAULT_FILE = path.join(DATA_DIR, 'plan.default.json');
const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function ensurePlan() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PLAN_FILE)) fs.copyFileSync(DEFAULT_FILE, PLAN_FILE);
}

function readPlan() {
  ensurePlan();
  return fs.readFileSync(PLAN_FILE, 'utf8');
}

function writePlan(text) {
  ensurePlan();
  // Keep one rolling backup so a bad save is recoverable.
  if (fs.existsSync(PLAN_FILE)) fs.copyFileSync(PLAN_FILE, PLAN_FILE + '.bak');
  const tmp = PLAN_FILE + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, PLAN_FILE);
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return send(res, 200, '{"ok":true}');

  if (url.pathname === '/api/plan') {
    if (req.method === 'GET') return send(res, 200, readPlan());
    if (req.method === 'PUT' || req.method === 'POST') {
      let text;
      try { text = await readBody(req, 5 * 1024 * 1024); } catch (e) { return send(res, 413, '{"error":"too large"}'); }
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { return send(res, 400, '{"error":"invalid JSON"}'); }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
        return send(res, 400, '{"error":"plan must be an object with an events array"}');
      }
      writePlan(JSON.stringify(parsed, null, 2));
      return send(res, 200, '{"ok":true}');
    }
    return send(res, 405, '{"error":"method not allowed"}');
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    fs.copyFileSync(DEFAULT_FILE, PLAN_FILE);
    return send(res, 200, readPlan());
  }

  return send(res, 404, '{"error":"not found"}');
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');
  // Never serve the live data file or server code directly; the API covers data.
  if (file.startsWith(DATA_DIR) && path.basename(file) !== 'plan.default.json') {
    return send(res, 404, 'not found', 'text/plain');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found', 'text/plain');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => send(res, 500, JSON.stringify({ error: String(e.message || e) })));
  } else {
    serveStatic(req, res, url);
  }
});

ensurePlan();
server.listen(PORT, HOST, () => {
  console.log(`Weekend Planner running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Plan file: ${PLAN_FILE}`);
});
