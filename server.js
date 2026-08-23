'use strict';
// buildbar MCP Hub — Self-Service.
// Teilnehmer traegt EIGENE n8n-URL + API-Key ein -> bekommt eine persoenliche
// Capability-URL https://hub.buildbar.at/g/<token>/mcp . Der Key bleibt server-seitig.
// Der Hub injiziert Authorization + x-n8n-url + x-n8n-key und leitet an den
// Multi-Tenant-n8n-mcp (mcp.buildbar.at) weiter. Das Teilnehmer-Repo enthaelt
// NUR die URL -> kein Secret, keine custom Header (die claude.ai/code eh verwirft).

const express = require('express');
const httpProxy = require('http-proxy');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const UPSTREAM = process.env.MCP_UPSTREAM || 'https://mcp.buildbar.at';
const PORT = parseInt(process.env.PORT || '80', 10);
const DATA_FILE = process.env.DATA_FILE || '/data/tokens.json';

// token -> { url, key }
const store = new Map();
try {
  if (fs.existsSync(DATA_FILE)) {
    const o = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [k, v] of Object.entries(o)) store.set(k, v);
    console.log('loaded', store.size, 'tokens');
  }
} catch (e) { console.error('load failed:', e.message); }
function persist() {
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(store))); }
  catch (e) { /* kein Volume -> nur In-Memory, ok */ }
}

const app = express();
app.disable('x-powered-by');

const proxy = httpProxy.createProxyServer({ changeOrigin: true, secure: true });
proxy.on('proxyReq', (proxyReq, req) => {
  if (req.tenant) {
    proxyReq.setHeader('Authorization', 'Bearer ' + AUTH_TOKEN);
    proxyReq.setHeader('x-n8n-url', req.tenant.url);
    proxyReq.setHeader('x-n8n-key', req.tenant.key);
  }
});
proxy.on('error', (err, req, res) => {
  try { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end('{"error":"upstream error"}'); } catch (e) {}
});

// --- MCP-Proxy: MUSS vor jedem Body-Parser stehen (Stream unangetastet) ---
app.use((req, res, next) => {
  const m = req.path.match(/^\/g\/([a-f0-9]{8,64})\/mcp\/?$/);
  if (!m) return next();
  const t = store.get(m[1]);
  if (!t) { res.status(404).type('application/json').send('{"error":"unbekannter oder abgelaufener Verbindungs-Token"}'); return; }
  req.tenant = t;
  req.url = '/mcp';
  proxy.web(req, res, { target: UPSTREAM });
});

// --- Selbst-enthaltene Capability-URL: /c/<base64url(url|key)>/mcp ---
// Claude im Projekt baut diese URL lokal (kein Server-Round-Trip noetig). Der Hub
// dekodiert url+key aus dem Pfad und injiziert die Header. Muss ebenfalls VOR jedem
// Body-Parser stehen (Stream unangetastet).
app.use((req, res, next) => {
  const m = req.path.match(/^\/c\/([A-Za-z0-9_-]+)\/mcp\/?$/);
  if (!m) return next();
  let url, key;
  try {
    const raw = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const i = raw.indexOf('|');
    if (i < 0) throw new Error('sep');
    url = raw.slice(0, i); key = raw.slice(i + 1);
    if (!/^https:\/\//i.test(url) || key.length < 10) throw new Error('shape');
  } catch (e) { res.status(400).type('application/json').send('{"error":"ungueltige Verbindungs-URL"}'); return; }
  req.tenant = { url, key };
  req.url = '/mcp';
  proxy.web(req, res, { target: UPSTREAM });
});

// --- Self-Service-Registrierung (alternativer Weg ueber die Seite) ---
app.get('/', (req, res) => res.type('html').send(formHtml()));
app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.post('/register', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
  const url = String(req.body.url || '').trim().replace(/\/+$/, '');
  const key = String(req.body.key || '').trim();
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return res.status(400).type('html').send(errHtml('Bitte eine gueltige n8n-URL (https://...) eingeben.'));
  if (key.length < 20) return res.status(400).type('html').send(errHtml('Der API-Key sieht zu kurz aus - bitte pruefen.'));
  const token = crypto.randomBytes(16).toString('hex');
  store.set(token, { url, key });
  persist();
  const mcpUrl = 'https://' + req.headers.host + '/g/' + token + '/mcp';
  res.type('html').send(successHtml(mcpUrl));
});

// --- JSON-API fuer connect.sh: registriert url+key server-seitig, gibt anonyme URL zurueck ---
app.post('/api/register', express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), (req, res) => {
  const url = String((req.body && req.body.url) || '').trim().replace(/\/+$/, '');
  const key = String((req.body && req.body.key) || '').trim();
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return res.status(400).json({ error: 'ungueltige n8n-URL' });
  if (key.length < 20) return res.status(400).json({ error: 'API-Key zu kurz' });
  const token = crypto.randomBytes(16).toString('hex');
  store.set(token, { url, key });
  persist();
  res.json({ mcpUrl: 'https://' + req.headers.host + '/g/' + token + '/mcp' });
});

app.listen(PORT, () => console.log('buildbar hub on', PORT, '-> upstream', UPSTREAM));

// ---------- HTML ----------
const CSS = 'body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:660px;margin:6vh auto;padding:0 20px;color:#141414;line-height:1.55}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:28px}label{display:block;font-weight:600;margin:18px 0 6px}input{width:100%;padding:12px;font-size:1rem;border:1px solid #c4c4c4;border-radius:8px;box-sizing:border-box}small{color:#555;display:block;margin-top:5px}button{margin-top:26px;padding:14px 24px;font-size:1rem;font-weight:600;background:#111;color:#fff;border:0;border-radius:8px;cursor:pointer}.box{background:#f5f5f5;border-radius:10px;padding:16px 18px;margin-top:14px;overflow-x:auto}code{background:#ececec;padding:2px 5px;border-radius:4px;word-break:break-all}pre{margin:0;white-space:pre;font-size:.9rem}a{color:#0b57d0}';

function page(title, body) {
  return '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>' + CSS + '</style></head><body>' + body + '</body></html>';
}
function formHtml() {
  return page('buildbar - n8n verbinden',
    '<h1>Deine n8n verbinden</h1>' +
    '<p>Trag deine <b>eigene</b> n8n-Instanz ein. Du bekommst danach <b>eine Verbindungs-URL</b> fuer dein Hackathon-Projekt. Dein API-Key bleibt <b>auf dem Server</b> und landet nie in einem Repo.</p>' +
    '<form method="post" action="/register">' +
    '<label>n8n-URL</label>' +
    '<input name="url" inputmode="url" placeholder="https://deine-instanz.app.n8n.cloud" required>' +
    '<small>Die Adresse deiner n8n, ohne / am Ende.</small>' +
    '<label>n8n API-Key</label>' +
    '<input name="key" placeholder="eyJ..." required>' +
    '<small>In n8n: Einstellungen -> n8n API -> API Key erstellen.</small>' +
    '<button type="submit">Verbinden</button></form>');
}
function successHtml(mcpUrl) {
  const snippet = '{\n  "mcpServers": {\n    "n8n-mcp": {\n      "type": "http",\n      "url": "' + mcpUrl + '"\n    }\n  }\n}';
  return page('buildbar - bereit',
    '<h1>Verbindung bereit</h1>' +
    '<p>Deine persoenliche Verbindungs-URL:</p><div class="box"><code>' + mcpUrl + '</code></div>' +
    '<h2>So nutzt du sie</h2><ol>' +
    '<li>Erstelle dein Projekt aus der Vorlage: <a href="https://github.com/freddy-schuetz/buildbar-demo/generate" target="_blank" rel="noopener">buildbar-demo -> Use this template</a> (in deinem GitHub-Account).</li>' +
    '<li>Oeffne im Projekt die Datei <code>.mcp.json</code> und setze <b>deine</b> URL ein - so:<div class="box"><pre>' + snippet + '</pre></div></li>' +
    '<li>Oeffne das Projekt in <a href="https://claude.ai/code" target="_blank" rel="noopener">claude.ai/code</a>, lass <code>n8n-mcp</code> zu und tippe: <b>"pruefe meine n8n-Verbindung"</b>.</li>' +
    '</ol><p><small>Bewahr die URL wie ein Passwort auf - wer sie hat, kann ueber den Hub deine n8n ansprechen. Sie enthaelt aber nicht deinen API-Key.</small></p>');
}
function errHtml(msg) {
  return page('buildbar - Fehler', '<h1>Hoppla</h1><p>' + msg + '</p><p><a href="/">zurueck zum Formular</a></p>');
}
