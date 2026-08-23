'use strict';
// buildbar MCP Hub.
// Teilnehmer traegt EIGENE n8n-URL + API-Key ein und meldet sich mit GitHub an.
// Der Hub speichert {token -> (url,key)} SERVER-SEITIG, legt dem Teilnehmer ein
// fertiges GitHub-Repo an (mit .mcp.json auf main, nur anonyme URL, KEIN Key) und
// injiziert bei jedem MCP-Aufruf Authorization + x-n8n-url + x-n8n-key Richtung
// mcp.buildbar.at. So oeffnet der Teilnehmer ein bereits verbundenes Projekt in
// claude.ai/code - kein Datei-Basteln, kein Branch-Problem, kein Neu-Oeffnen.

const express = require('express');
const httpProxy = require('http-proxy');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const UPSTREAM = process.env.MCP_UPSTREAM || 'https://mcp.buildbar.at';
const PORT = parseInt(process.env.PORT || '80', 10);
const DATA_FILE = process.env.DATA_FILE || '/data/tokens.json';
const GH_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GH_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const HUB_BASE = process.env.HUB_BASE || 'https://hub.buildbar.at';
const REPO_NAME = process.env.REPO_NAME || 'buildbar-hackathon';
const TEMPLATE_REPO = process.env.TEMPLATE_REPO || 'freddy-schuetz/nrw-tourismus-hackathon-web';
// Frontend-Deploy (on-demand)
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN || '';
const COOLIFY_API = process.env.COOLIFY_API || 'http://coolify:8080/api/v1';
const COOLIFY_PROJECT = process.env.COOLIFY_PROJECT || '';
const COOLIFY_SERVER = process.env.COOLIFY_SERVER || '';
const DEPLOY_KEY_UUID = process.env.DEPLOY_KEY_UUID || '';
const DEPLOY_PUBKEY = process.env.DEPLOY_PUBKEY || '';
const DEPLOY_DOMAIN_BASE = process.env.DEPLOY_DOMAIN_BASE || 'buildbar.at';

// Coolify-API-Helfer (fuer Deploy-Key-Registrierung + App-Erstellung)
const cf = (p, opts = {}) => fetch(COOLIFY_API + p, { ...opts, headers: { 'Authorization': 'Bearer ' + COOLIFY_TOKEN, 'Content-Type': 'application/json', 'Accept': 'application/json', ...(opts.headers || {}) } });

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
  catch (e) { /* kein Volume -> nur In-Memory */ }
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

// --- MCP-Proxy per Token (MUSS vor jedem Body-Parser stehen) ---
app.use((req, res, next) => {
  const m = req.path.match(/^\/g\/([a-f0-9]{8,64})\/mcp\/?$/);
  if (!m) return next();
  const t = store.get(m[1]);
  if (!t) { res.status(404).type('application/json').send('{"error":"unbekannter oder abgelaufener Verbindungs-Token"}'); return; }
  req.tenant = t; req.url = '/mcp';
  proxy.web(req, res, { target: UPSTREAM });
});

// ---------- Onboarding: Formular -> GitHub-Anmeldung -> fertiges Repo ----------
app.get('/', (req, res) => res.type('html').send(formHtml()));
app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.post('/start', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
  const url = String((req.body && req.body.url) || '').trim().replace(/\/+$/, '');
  const key = String((req.body && req.body.key) || '').trim();
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return res.status(400).type('html').send(errHtml('Bitte eine gültige n8n-URL (https://…) eingeben.'));
  if (key.length < 20) return res.status(400).type('html').send(errHtml('Der API-Key sieht zu kurz aus – bitte prüfen.'));
  if (!GH_CLIENT_ID || !GH_CLIENT_SECRET) return res.status(503).type('html').send(errHtml('Die GitHub-Anmeldung ist auf diesem Hub noch nicht konfiguriert.'));
  const token = crypto.randomBytes(16).toString('hex');
  store.set(token, { url, key });
  persist();
  const authUrl = 'https://github.com/login/oauth/authorize'
    + '?client_id=' + encodeURIComponent(GH_CLIENT_ID)
    + '&scope=repo'
    + '&state=' + token
    + '&redirect_uri=' + encodeURIComponent(HUB_BASE + '/auth/callback');
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  const tenant = store.get(state);
  if (!code || !tenant) return res.status(400).type('html').send(errHtml('Sitzung abgelaufen oder ungueltig. Bitte von vorne beginnen.'));
  try {
    const tr = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET, code, redirect_uri: HUB_BASE + '/auth/callback' })
    });
    const tj = await tr.json();
    const ght = tj.access_token;
    if (!ght) throw new Error('GitHub hat kein Zugriffstoken geliefert.');
    const gh = (p, opts = {}) => fetch('https://api.github.com' + p, {
      ...opts, headers: { 'Authorization': 'Bearer ' + ght, 'Accept': 'application/vnd.github+json', 'User-Agent': 'buildbar-hub', 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });

    // Teilnehmer-Login ermitteln (fuer generate-owner)
    const meRes = await gh('/user');
    const login = meRes.ok ? (await meRes.json()).login : null;
    if (!login) throw new Error('GitHub-Login nicht ermittelbar.');
    const tParts = TEMPLATE_REPO.split('/');

    // Repo AUS DEM TEMPLATE generieren (alles drin: Skills, Docs, Starter) - bei Kollision Suffix
    let repo = null;
    for (let a = 0; a < 4; a++) {
      const nm = a === 0 ? REPO_NAME : REPO_NAME + '-' + crypto.randomBytes(2).toString('hex');
      let cr;
      if (tParts.length === 2) {
        cr = await gh('/repos/' + tParts[0] + '/' + tParts[1] + '/generate', {
          method: 'POST', headers: { 'Accept': 'application/vnd.github+json' },
          body: JSON.stringify({ owner: login, name: nm, private: true, include_all_branches: false })
        });
      } else {
        cr = await gh('/user/repos', { method: 'POST', body: JSON.stringify({ name: nm, private: true, auto_init: true }) });
      }
      if (cr.status === 201) { repo = await cr.json(); break; }
      if (cr.status !== 422) throw new Error('Repo-Erstellung fehlgeschlagen (' + cr.status + '): ' + (await cr.text()).slice(0, 200));
    }
    if (!repo) throw new Error('Konnte keinen freien Repo-Namen finden.');
    const owner = repo.owner.login, name = repo.name;

    // WICHTIG: GitHub-"generate" ist ASYNCHRON. Erst warten, bis das Repo wirklich
    // befuellt ist (Template-.mcp.json existiert -> sha), DANN ueberschreiben. Sonst
    // legt der generate-Initial-Commit unsere .mcp.json wieder platt (Race-Condition).
    const mcpUrl = HUB_BASE + '/g/' + state + '/mcp';
    const mcp = JSON.stringify({ mcpServers: { 'n8n-mcp': { type: 'http', url: mcpUrl } } }, null, 2) + '\n';
    let sha = null;
    for (let a = 0; a < 30; a++) {
      const g = await gh('/repos/' + owner + '/' + name + '/contents/.mcp.json');
      if (g.ok) { sha = (await g.json()).sha; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    let done = false, lastErr = '';
    for (let a = 0; a < 5 && !done; a++) {
      const put1 = await gh('/repos/' + owner + '/' + name + '/contents/.mcp.json', {
        method: 'PUT', body: JSON.stringify({ message: 'n8n verbunden', content: Buffer.from(mcp).toString('base64'), ...(sha ? { sha } : {}) })
      });
      if (put1.status < 300) { done = true; break; }
      lastErr = put1.status + ' ' + (await put1.text()).slice(0, 150);
      const g = await gh('/repos/' + owner + '/' + name + '/contents/.mcp.json'); // sha evtl. veraltet -> neu holen
      if (g.ok) sha = (await g.json()).sha;
      await new Promise(r => setTimeout(r, 1500));
    }
    if (!done) throw new Error('.mcp.json setzen fehlgeschlagen: ' + lastErr);

    // EINDEUTIGER read-only Deploy-Key pro Repo -> On-Demand-Frontend-Deploy moeglich.
    // (GitHub erlaubt denselben Deploy-Key nur bei EINEM Repo global -> pro Repo ein eigener!)
    if (COOLIFY_TOKEN) {
      try {
        const fs = require('fs');
        const kp = '/tmp/dk-' + state;
        require('child_process').execSync("ssh-keygen -t ed25519 -N '' -q -f " + kp + " -C buildbar-" + name);
        const pub = fs.readFileSync(kp + '.pub', 'utf8').trim();
        const priv = fs.readFileSync(kp, 'utf8');
        try { fs.unlinkSync(kp); fs.unlinkSync(kp + '.pub'); } catch (e) {}
        const kr = await cf('/security/keys', { method: 'POST', body: JSON.stringify({ name: 'deploy-' + name, private_key: priv }) });
        const kj = await kr.json().catch(() => ({}));
        await gh('/repos/' + owner + '/' + name + '/keys', { method: 'POST', body: JSON.stringify({ title: 'buildbar-deploy', key: pub, read_only: true }) });
        if (kj && kj.uuid) tenant.deployKeyUuid = kj.uuid;
      } catch (e) { /* nicht kritisch */ }
    }
    // Repo (+ Deploy-Key-UUID) mit dem Verbindungs-Token merken (fuer /deploy)
    tenant.repo = owner + '/' + name;
    store.set(state, tenant);
    persist();

    res.type('html').send(doneHtml(repo.html_url, repo.full_name));
  } catch (e) {
    res.status(500).type('html').send(errHtml('Etwas ist schiefgelaufen: ' + String((e && e.message) || e)));
  }
});

// --- On-Demand Frontend-Deploy: Coolify-App aus dem Repo (nur wenn der Teilnehmer es will) ---
app.post('/deploy', express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  let baseDir = String((req.body && req.body.base_dir) || '').trim() || '/frontend-starter';
  if (baseDir[0] !== '/') baseDir = '/' + baseDir;
  const rec = store.get(token);
  if (!rec || !rec.repo) return res.status(404).json({ error: 'unbekannter Token oder kein Repo hinterlegt' });
  const keyUuid = rec.deployKeyUuid || DEPLOY_KEY_UUID;
  if (!COOLIFY_TOKEN || !COOLIFY_PROJECT || !COOLIFY_SERVER || !keyUuid) return res.status(503).json({ error: 'Deploy ist auf diesem Hub nicht konfiguriert (kein Deploy-Key)' });
  try {
    if (!rec.appUuid) {
      const sub = 'app-' + token.slice(0, 8);
      const domain = 'https://' + sub + '.' + DEPLOY_DOMAIN_BASE;
      const cr = await cf('/applications/private-deploy-key', {
        method: 'POST', body: JSON.stringify({
          project_uuid: COOLIFY_PROJECT, server_uuid: COOLIFY_SERVER, environment_name: 'production',
          git_repository: 'git@github.com:' + rec.repo + '.git', git_branch: 'main',
          private_key_uuid: keyUuid, build_pack: 'nixpacks', ports_exposes: '3000',
          base_directory: baseDir, name: sub, instant_deploy: false
        })
      });
      if (cr.status !== 201) return res.status(500).json({ error: 'App-Erstellung fehlgeschlagen (' + cr.status + '): ' + (await cr.text()).slice(0, 250) });
      const app = await cr.json();
      rec.appUuid = app.uuid; rec.appDomain = domain; rec.baseDir = baseDir;
      await cf('/applications/' + rec.appUuid, { method: 'PATCH', body: JSON.stringify({ domains: domain }) });
      store.set(token, rec); persist();
    }
    await cf('/deploy?uuid=' + rec.appUuid + '&force=false', { method: 'POST' });
    res.json({ url: rec.appDomain, app: rec.appUuid, status: 'deploying', hint: 'Erster Build dauert 1-2 Minuten.' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.listen(PORT, () => console.log('buildbar hub on', PORT, '-> upstream', UPSTREAM, GH_CLIENT_ID ? '(GitHub aktiv)' : '(GitHub NICHT konfiguriert)'));

// ---------- HTML ----------
const CSS = 'body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:660px;margin:6vh auto;padding:0 20px;color:#141414;line-height:1.55}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:26px}label{display:block;font-weight:600;margin:18px 0 6px}input{width:100%;padding:12px;font-size:1rem;border:1px solid #c4c4c4;border-radius:8px;box-sizing:border-box}small{color:#555;display:block;margin-top:5px}button{margin-top:26px;padding:14px 24px;font-size:1rem;font-weight:600;background:#111;color:#fff;border:0;border-radius:8px;cursor:pointer}.box{background:#f5f5f5;border-radius:10px;padding:16px 18px;margin-top:14px;overflow-x:auto}code{background:#ececec;padding:2px 5px;border-radius:4px;word-break:break-all}a{color:#0b57d0}ol li{margin:8px 0}';

function page(title, body) {
  return '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>' + CSS + '</style></head><body>' + body + '</body></html>';
}
function formHtml() {
  return page('buildbar – n8n verbinden',
    '<h1>Dein Hackathon-Projekt einrichten</h1>' +
    '<p>Zwei Angaben, eine GitHub-Anmeldung – danach legen wir dir ein <b>fertig verbundenes</b> Projekt an. Kein Datei-Basteln. Dein API-Key bleibt <b>auf dem Server</b> und landet nie in einem Repo.</p>' +
    '<form method="post" action="/start">' +
    '<label>1. Deine n8n-URL</label>' +
    '<input name="url" inputmode="url" placeholder="https://deine-instanz.app.n8n.cloud" required>' +
    '<small>Die Adresse deiner n8n, ohne / am Ende.</small>' +
    '<label>2. Dein n8n API-Key</label>' +
    '<input name="key" placeholder="eyJ..." required>' +
    '<small>In n8n: Einstellungen → n8n API → API Key erstellen.</small>' +
    '<button type="submit">Weiter mit GitHub →</button>' +
    '<small style="margin-top:14px">Im nächsten Schritt meldest du dich bei GitHub an. buildbar legt dir damit dein privates Projekt-Repo an.</small>' +
    '</form>');
}
function doneHtml(repoUrl, fullName) {
  return page('buildbar – fertig',
    '<h1>Projekt ist fertig &amp; verbunden 🎉</h1>' +
    '<p>Dein privates Projekt-Repo wurde angelegt:</p>' +
    '<div class="box"><code>' + fullName + '</code></div>' +
    '<h2>Jetzt loslegen</h2><ol>' +
    '<li>Öffne <a href="https://claude.ai/code" target="_blank" rel="noopener">claude.ai/code</a> und melde dich an.</li>' +
    '<li>Verbinde dort dein GitHub (falls noch nicht) und wähle das Projekt <b>' + fullName + '</b> aus.</li>' +
    '<li>Tippe einfach: <b>„Los geht\'s"</b> – Claude begrüßt dich, prüft die Verbindung und fragt, was du bauen möchtest.</li>' +
    '</ol>' +
    '<p><a href="' + repoUrl + '" target="_blank" rel="noopener">Repo auf GitHub ansehen</a></p>' +
    '<p><small>Deine n8n-Verbindung ist bereits im Projekt hinterlegt (nur eine anonyme URL, kein Key) – auch die Skills sind schon dabei. Du musst nichts weiter einrichten.</small></p>');
}
function errHtml(msg) {
  return page('buildbar – Hinweis', '<h1>Hoppla</h1><p>' + msg + '</p><p><a href="/">zurück zum Formular</a></p>');
}
