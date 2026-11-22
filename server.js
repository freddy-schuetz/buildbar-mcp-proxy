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

// Seiten des Hubs nicht in fremde Rahmen einbetten lassen (Klick-Untergeschoben).
app.use((req, res, next) => { res.setHeader('X-Frame-Options', 'DENY'); next(); });

// Formulare, die n8n-Adresse und Schluessel setzen, nur von der eigenen Seite annehmen. Browser schicken bei
// einem POST von einer fremden Seite immer einen Origin-Kopf mit (oder "null"); ohne diese Pruefung koennte eine
// fremde Seite nach einer bereits erteilten GitHub-Freigabe still eine andere n8n hinterlegen.
const HUB_ORIGIN = (() => { try { return new URL(HUB_BASE).origin; } catch (e) { return ''; } })();
function fremdeHerkunft(req) {
  const o = req.headers.origin;
  return o !== undefined && o !== HUB_ORIGIN;
}

// ---------- Onboarding: Formular -> GitHub-Anmeldung -> fertiges Repo ----------
app.get('/', (req, res) => res.type('html').send(formHtml()));
app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.post('/start', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
  if (fremdeHerkunft(req)) return res.status(403).type('html').send(errHtml('Bitte das Formular direkt auf ' + HUB_BASE + ' abschicken.'));
  const url = String((req.body && req.body.url) || '').trim().replace(/\/+$/, '');
  const key = String((req.body && req.body.key) || '').trim();
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return res.status(400).type('html').send(errHtml('Bitte eine gültige n8n-URL (https://…) eingeben.'));
  if (key.length < 20) return res.status(400).type('html').send(errHtml('Der API-Key sieht zu kurz aus. Bitte prüfen.'));
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

// Deploy-Key nachtragen: startet dieselbe GitHub-Anmeldung wie beim Anlegen, macht aber NUR
// den Schluessel. Der Assistent der Person kann diesen Link erzeugen und weiterreichen -
// klicken muss ihn die Person selbst, denn ohne ihre Zustimmung darf niemand einen
// Deploy-Key in ihr Repository setzen.
app.get('/schluessel/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  const rec = store.get(token);
  if (!rec || !rec.repo) return res.status(404).type('html').send(errHtml('Unbekannter Zugang oder noch kein Repository hinterlegt.'));
  if (!GH_CLIENT_ID || !GH_CLIENT_SECRET) return res.status(503).type('html').send(errHtml('Die GitHub-Anmeldung ist auf diesem Hub nicht konfiguriert.'));
  const authUrl = 'https://github.com/login/oauth/authorize'
    + '?client_id=' + encodeURIComponent(GH_CLIENT_ID)
    + '&scope=repo'
    + '&state=' + encodeURIComponent('fix:' + token)
    + '&redirect_uri=' + encodeURIComponent(HUB_BASE + '/auth/callback');
  res.redirect(authUrl);
});

// Der Assistent holt sich den Link hier ab, statt ihn zusammenzubauen.
app.post('/deploykey', express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  const rec = store.get(token);
  if (!rec) return res.status(404).json({ error: 'unbekannter Token' });
  if (!rec.repo) return res.status(409).json({ error: 'Zu diesem Zugang ist kein Repository hinterlegt.' });
  const link = HUB_BASE + '/schluessel/' + token;
  if (rec.deployKeyUuid || DEPLOY_KEY_UUID) {
    return res.json({ status: 'vorhanden', repo: rec.repo, link,
      hinweis: 'Ein Deploy-Key ist hinterlegt. Scheitert das Veroeffentlichen trotzdem am Klonen, fehlt der oeffentliche Teil im Repository - dann diesen Link einmal oeffnen.' });
  }
  res.json({ status: 'fehlt', repo: rec.repo, link,
    hinweis: 'Diesen Link der Person geben. Sie meldet sich einmal bei GitHub an, danach traegt der Hub den Deploy-Key selbst ein. Anschliessend /deploy wiederholen.' });
});

// ---------- n8n-Schluessel erneuern (TCF) ----------
// Schluessel in one.intelligence laufen ab. Damit das Projekt nach dem Bootcamp verbunden bleibt,
// hinterlegt die Person hier einen neuen. Wer sie ist, zeigt die GitHub-Anmeldung: Geaendert werden
// nur Zugaenge, deren Repository diesem GitHub-Konto gehoert. Der neue Schluessel wartet hoechstens
// 15 Minuten im Speicher und wird nirgends ausgegeben.
const erneuernOffen = new Map(); // state -> { url, key, t }
const ERNEUERN_FRIST_MS = 15 * 60 * 1000;

app.get('/erneuern', (req, res) => res.type('html').send(erneuernHtml()));

app.post('/erneuern', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
  if (fremdeHerkunft(req)) return res.status(403).type('html').send(errHtml('Bitte das Formular direkt auf ' + HUB_BASE + ' abschicken.'));
  const url = String((req.body && req.body.url) || '').trim().replace(/\/+$/, '');
  const key = String((req.body && req.body.key) || '').trim();
  if (url && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return res.status(400).type('html').send(errHtml('Bitte eine gültige Adresse (https://…) eingeben oder das Feld leer lassen.'));
  if (key.length < 20) return res.status(400).type('html').send(errHtml('Der API-Schlüssel sieht zu kurz aus. Bitte prüfen.'));
  if (!GH_CLIENT_ID || !GH_CLIENT_SECRET) return res.status(503).type('html').send(errHtml('Die GitHub-Anmeldung ist auf diesem Hub noch nicht konfiguriert.'));
  const jetzt = Date.now();
  for (const [k, v] of erneuernOffen) if (jetzt - v.t > ERNEUERN_FRIST_MS) erneuernOffen.delete(k);
  const state = 'neu:' + crypto.randomBytes(16).toString('hex');
  erneuernOffen.set(state, { url, key, t: jetzt });
  const authUrl = 'https://github.com/login/oauth/authorize'
    + '?client_id=' + encodeURIComponent(GH_CLIENT_ID)
    + '&scope=read%3Auser'
    + '&state=' + encodeURIComponent(state)
    + '&redirect_uri=' + encodeURIComponent(HUB_BASE + '/auth/callback');
  res.redirect(authUrl);
});

async function erneuernCallback(code, state, res) {
  const offen = erneuernOffen.get(state);
  erneuernOffen.delete(state);
  if (!code || !offen || Date.now() - offen.t > ERNEUERN_FRIST_MS) {
    return res.status(400).type('html').send(errHtml('Sitzung abgelaufen oder ungültig. Bitte <a href="/erneuern">von vorne beginnen</a>.'));
  }
  try {
    const tr = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET, code, redirect_uri: HUB_BASE + '/auth/callback' }),
    });
    const ght = (await tr.json()).access_token;
    if (!ght) throw new Error('GitHub hat kein Zugriffstoken geliefert.');
    const me = await fetch('https://api.github.com/user', {
      headers: { Authorization: 'Bearer ' + ght, Accept: 'application/vnd.github+json', 'User-Agent': 'buildbar-hub' },
    });
    const login = me.ok ? (await me.json()).login : null;
    if (!login) throw new Error('GitHub-Login nicht ermittelbar.');
    const praefix = String(login).toLowerCase() + '/';
    const geaendert = [];
    for (const [token, rec] of store) {
      if (!rec || !rec.repo || !String(rec.repo).toLowerCase().startsWith(praefix)) continue;
      rec.key = offen.key;
      if (offen.url) rec.url = offen.url;
      store.set(token, rec);
      geaendert.push(rec.repo);
    }
    if (!geaendert.length) {
      return res.status(404).type('html').send(errHtml('Zu deinem GitHub-Konto (' + login + ') gibt es auf diesem Hub kein Projekt. Leg es über das <a href="/">Formular</a> neu an.'));
    }
    persist();
    console.log('n8n-Schluessel erneuert fuer', geaendert.length, 'Projekt(e) von', login);
    res.type('html').send(page('buildbar: Schlüssel erneuert', '<h1>Neuer Schlüssel hinterlegt</h1>' +
      '<p>Für ' + (geaendert.length === 1 ? 'dein Projekt' : 'deine Projekte') + ' gilt ab sofort der neue n8n-Schlüssel:</p>' +
      '<div class="box"><code>' + geaendert.join('</code><br><code>') + '</code></div>' +
      '<p>Starte in Claude eine neue Sitzung, dann ist die Verbindung wieder da.</p>'));
  } catch (e) {
    res.status(500).type('html').send(errHtml('Der Schlüssel konnte nicht erneuert werden: ' + String((e && e.message) || e)));
  }
}

app.get('/auth/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  if (state.startsWith('fix:')) return schluesselCallback(code, state.slice(4), res);
  if (state.startsWith('neu:')) return erneuernCallback(code, state, res);
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
        else tenant.deployKeyFehler = 'Coolify hat den Schluessel nicht angenommen (HTTP ' + kr.status + ')';
      } catch (e) {
        // NICHT verschlucken: ohne Schluessel scheitert spaeter jedes /deploy mit 503,
        // und niemand weiss mehr, warum. Am 21.09. war der Coolify-Token weg - der
        // Fehlschlag fiel erst zwei Tage spaeter beim Veroeffentlichen auf.
        tenant.deployKeyFehler = String((e && e.message) || e).slice(0, 200);
      }
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

// Legt ein Schluesselpaar an, hinterlegt den privaten Teil in Coolify und merkt sich die UUID.
// Der oeffentliche Teil wird zurueckgegeben - ihn traegt die Person selbst ins Repo ein.
async function schluesselAnlegen(rec, token) {
  // Schon einer vorbereitet? Dann den nehmen, statt bei jedem Versuch einen neuen
  // Schluessel in Coolify liegen zu lassen.
  if (rec.pendingKey && rec.pendingKey.uuid && rec.pendingKey.pub) return rec.pendingKey;
  try {
    const fs = require('fs');
    const kp = '/tmp/dk-nach-' + token.slice(0, 8);
    require('child_process').execSync("ssh-keygen -t ed25519 -N '' -q -f " + kp + ' -C buildbar-nachtrag');
    const pub = fs.readFileSync(kp + '.pub', 'utf8').trim();
    const priv = fs.readFileSync(kp, 'utf8');
    try { fs.unlinkSync(kp); fs.unlinkSync(kp + '.pub'); } catch (e) {}
    const kr = await cf('/security/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'deploy-nachtrag-' + token.slice(0, 8), private_key: priv }),
    });
    const kj = await kr.json().catch(() => ({}));
    if (!kj || !kj.uuid) return null;
    // Noch NICHT als gueltig vermerken: gueltig ist er erst, wenn der oeffentliche Teil
    // im Repository liegt. Sonst laeuft der naechste Build in ein Klon-Problem statt in
    // eine Meldung, die sagt, was zu tun ist.
    rec.pendingKey = { uuid: kj.uuid, pub };
    delete rec.deployKeyFehler;
    store.set(token, rec);
    persist();
    return rec.pendingKey;
  } catch (e) {
    return null;
  }
}

// Rueckweg der Schluessel-Nachtragung: NUR den Deploy-Key setzen, kein Repo anlegen,
// keine .mcp.json anfassen. Das GitHub-Token wird nur fuer diesen einen Aufruf benutzt
// und nirgends gespeichert.
async function schluesselCallback(code, token, res) {
  const rec = store.get(token);
  if (!code || !rec || !rec.repo) {
    return res.status(400).type('html').send(errHtml('Sitzung abgelaufen oder ungueltig. Bitte den Link neu anfordern.'));
  }
  try {
    const tr = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET, code, redirect_uri: HUB_BASE + '/auth/callback' }),
    });
    const ght = (await tr.json()).access_token;
    if (!ght) throw new Error('GitHub hat kein Zugriffstoken geliefert.');
    const neu = await schluesselAnlegen(rec, token);
    if (!neu) throw new Error('Der Schluessel liess sich in Coolify nicht hinterlegen.');
    const kr = await fetch('https://api.github.com/repos/' + rec.repo + '/keys', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + ght, Accept: 'application/vnd.github+json', 'User-Agent': 'buildbar-hub', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'buildbar-deploy', key: neu.pub, read_only: true }),
    });
    if (kr.status >= 300) throw new Error('GitHub hat den Deploy-Key abgelehnt (' + kr.status + '): ' + (await kr.text()).slice(0, 160));
    // Jetzt liegt er im Repo - erst damit gilt er.
    rec.deployKeyUuid = neu.uuid;
    delete rec.pendingKey;
    store.set(token, rec);
    persist();
    res.type('html').send(page('Deploy-Key eingetragen', '<h1>Fertig</h1>' +
      '<p>Der Deploy-Key liegt jetzt in <code>' + rec.repo + '</code>, nur mit Leserecht.</p>' +
      '<p>Geh zurueck in deine Sitzung und sag: <strong>„veroeffentliche meine App nochmal"</strong>.</p>'));
  } catch (e) {
    res.status(500).type('html').send(errHtml('Der Deploy-Key konnte nicht gesetzt werden: ' + String((e && e.message) || e)));
  }
}

// --- Ausgang des letzten Builds: ohne das sieht die Person nur eine Fehlerseite ---
app.post('/status', express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  const rec = store.get(token);
  if (!rec) return res.status(404).json({ error: 'unbekannter Token' });
  if (!rec.appUuid) return res.json({ status: 'noch nichts veroeffentlicht' });
  if (!rec.lastDeployment) return res.json({ url: rec.appDomain, status: 'unbekannt', hinweis: 'Nach dem naechsten /deploy steht der Ausgang hier.' });
  try {
    const r = await cf('/deployments/' + rec.lastDeployment);
    const j = await r.json().catch(() => ({}));
    let zeilen = [];
    try {
      zeilen = JSON.parse(j.logs || '[]').map((e) => String(e.output || '').replace(/\s+$/, '')).filter(Boolean);
    } catch (e) { zeilen = []; }
    res.json({
      url: rec.appDomain,
      status: j.status || 'unbekannt',
      commit: (j.commit || '').slice(0, 7),
      // Fehlerzeilen nur bei echtem Fehlschlag: erfolgreiche Builds enthalten harmlose
      // Aufraeum-Meldungen, die sonst falschen Alarm ausloesen.
      fehlerzeilen: j.status === 'failed'
        ? zeilen.filter((z) => /error|failed|not a directory|exit code/i.test(z)).slice(-8).map((z) => z.slice(0, 300))
        : [],
      letzte_zeilen: zeilen.slice(-20).map((z) => z.slice(0, 300)),
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// --- On-Demand Frontend-Deploy: Coolify-App aus dem Repo (nur wenn der Teilnehmer es will) ---
app.post('/deploy', express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  let baseDir = String((req.body && req.body.base_dir) || '').trim() || '/frontend-starter';
  if (baseDir[0] !== '/') baseDir = '/' + baseDir;
  const rec = store.get(token);
  if (!rec || !rec.repo) return res.status(404).json({ error: 'unbekannter Token oder kein Repo hinterlegt' });
  if (!COOLIFY_TOKEN || !COOLIFY_PROJECT || !COOLIFY_SERVER) {
    return res.status(503).json({ error: 'Deploy ist auf diesem Hub nicht konfiguriert (Coolify fehlt)' });
  }
  // Ein vorbereiteter Schluessel gilt erst, wenn sein oeffentlicher Teil im Repo liegt.
  // Genau das erledigt der Link unten; danach genuegt derselbe /deploy-Aufruf noch einmal.
  let keyUuid = rec.deployKeyUuid || DEPLOY_KEY_UUID;
  if (!keyUuid) {
    // Frueher endete das hier mit 503 und niemand kam weiter. Jetzt legt der Hub den
    // Schluessel nach und sagt genau, was noch fehlt: der oeffentliche Teil im Repo.
    // Den kann nur die Person selbst setzen - der Hub hat ihren GitHub-Zugang nicht mehr.
    return res.status(409).json({
      error: 'Es fehlt der Deploy-Key im Repository.',
      link: HUB_BASE + '/schluessel/' + token,
      so_gehts: 'Gib der Person diesen Link. Sie meldet sich dort einmal bei GitHub an, danach traegt der Hub den Deploy-Key selbst ein (nur Leserecht). Anschliessend denselben /deploy-Aufruf wiederholen.',
    });
  }
  let envFailed = [];
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
      // optionale Env-Variablen (KEY=VALUE je Zeile) VOR dem ersten Build setzen (z.B. NEXT_PUBLIC_SUPABASE_URL, Anon-Key, n8n-Webhook)
      // ENV per Bulk-Upsert. Frueher Einzel-POST mit is_build_time -> Coolify 4.3.10: 422, verschluckt,
      // jede Variable ging lautlos verloren. Ohne das Feld gilt sie fuer Build UND Laufzeit.
      const envRaw = String((req.body && req.body.env) || '');
      const envData = [];
      for (const line of envRaw.split(/\r?\n/)) {
        const i = line.indexOf('='); if (i < 1) continue;
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (!k) continue;
        envData.push({ key: k, value: v, is_preview: false });
      }
      if (envData.length) {
        try {
          const er = await cf('/applications/' + rec.appUuid + '/envs/bulk', { method: 'PATCH', body: JSON.stringify({ data: envData }) });
          if (!er.ok) envFailed = envData.map((d) => d.key + ' (HTTP ' + er.status + ')');
        } catch (e) { envFailed = envData.map((d) => d.key); }
      }
      store.set(token, rec); persist();
    }
    const dr = await cf('/deploy?uuid=' + rec.appUuid + '&force=false', { method: 'POST' });
    const dj = await dr.json().catch(() => ({}));
    const du = dj && dj.deployments && dj.deployments[0] && dj.deployments[0].deployment_uuid;
    if (du) { rec.lastDeployment = du; store.set(token, rec); persist(); }
    const out = { url: rec.appDomain, app: rec.appUuid, status: 'deploying', hint: 'Erster Build dauert 1-2 Minuten.' };
    out.pruefen = 'Antwortet die Adresse nicht: POST /status mit demselben token zeigt Ausgang und Fehlerzeilen des Builds.';
    if (envFailed.length) { out.env_failed = envFailed; out.warning = 'Diese Umgebungsvariablen konnten nicht gesetzt werden. Die App startet ohne sie.'; }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.listen(PORT, () => console.log('buildbar hub on', PORT, '-> upstream', UPSTREAM, GH_CLIENT_ID ? '(GitHub aktiv)' : '(GitHub NICHT konfiguriert)'));

// ---------- HTML ----------
const CSS = 'body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:660px;margin:6vh auto;padding:0 20px;color:#141414;line-height:1.55}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:26px}label{display:block;font-weight:600;margin:18px 0 6px}input{width:100%;padding:12px;font-size:1rem;border:1px solid #c4c4c4;border-radius:8px;box-sizing:border-box}small{color:#555;display:block;margin-top:5px}button{margin-top:26px;padding:14px 24px;font-size:1rem;font-weight:600;background:#db0b0b;color:#fff;border:0;border-radius:8px;cursor:pointer}.box{background:#f5f5f5;border-radius:10px;padding:16px 18px;margin-top:14px;overflow-x:auto}code{background:#ececec;padding:2px 5px;border-radius:4px;word-break:break-all}a{color:#ae0f0a}ol li{margin:8px 0}';

function page(title, body) {
  return '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>' + CSS + '</style></head><body>' + body + '</body></html>';
}
function erneuernHtml() {
  return page('buildbar: n8n-Schlüssel erneuern',
    '<h1>n8n-Schlüssel erneuern</h1>' +
    '<p>Ist dein API-Schlüssel abgelaufen oder hast du einen neuen angelegt? Hier hinterlegst du ihn für dein bestehendes Projekt. Mit der GitHub-Anmeldung zeigst du, dass es deins ist.</p>' +
    '<form method="post" action="/erneuern">' +
    '<label>1. Dein neuer n8n-API-Schlüssel</label>' +
    '<input name="key" placeholder="eyJ..." required>' +
    '<small>In n8n unter Einstellungen, dann „n8n API“, dann „Create API Key“. Wähl eine lange Laufzeit.</small>' +
    '<label>2. Adresse deiner n8n (nur wenn sie sich geändert hat)</label>' +
    '<input name="url" inputmode="url" placeholder="leer lassen, wenn gleich">' +
    '<button type="submit">Weiter mit GitHub →</button>' +
    '</form>');
}
function formHtml() {
  return page('buildbar: n8n verbinden',
    '<h1>Dein Bootcamp-Projekt einrichten</h1>' +
    '<p>AI Automation Bootcamp der Tourismus+Congress GmbH Frankfurt am Main. Zwei Angaben und eine GitHub-Anmeldung, danach bekommst du ein <b>fertig verbundenes</b> Projekt. Der API-Schlüssel bleibt <b>auf dem Server</b> und landet nie in einem Repository.</p>' +
    '<form method="post" action="/start">' +
    '<label>1. Adresse deiner n8n in one.intelligence</label>' +
    '<input name="url" inputmode="url" placeholder="https://…" required>' +
    '<small>Die Adresse eurer n8n, wie sie oben im Browser steht, aber nur der Anfang ohne / am Ende.</small>' +
    '<label>2. Dein n8n-API-Schlüssel</label>' +
    '<input name="key" placeholder="eyJ..." required>' +
    '<small>In n8n unter Einstellungen, dann „n8n API“, dann „Create API Key“. Wähl eine lange Laufzeit, damit dein Projekt auch nach dem Bootcamp verbunden bleibt.</small>' +
    '<button type="submit">Weiter mit GitHub →</button>' +
    '<small style="margin-top:14px">Im nächsten Schritt meldest du dich bei GitHub an. buildbar legt dir damit dein privates Projekt-Repository an.</small>' +
    '<small style="margin-top:14px">Schon ein Projekt und nur einen neuen n8n-Schlüssel? <a href="/erneuern">Schlüssel erneuern</a></small>' +
    '</form>');
}
function doneHtml(repoUrl, fullName) {
  return page('buildbar: fertig',
    '<h1>Projekt ist fertig &amp; verbunden 🎉</h1>' +
    '<p>Dein privates Projekt-Repo wurde angelegt:</p>' +
    '<div class="box"><code>' + fullName + '</code></div>' +
    '<h2>Jetzt loslegen</h2><ol>' +
    '<li>Öffne <a href="https://claude.ai/code" target="_blank" rel="noopener">claude.ai/code</a> und melde dich an.</li>' +
    '<li>Verbinde dort dein GitHub (falls noch nicht) und wähle das Projekt <b>' + fullName + '</b> aus.</li>' +
    '<li>Vor der ersten Nachricht: Netzwerkzugriff auf <b>„Voll“</b> stellen. Klick unter dem Eingabefeld auf „Default“ mit dem Wolkensymbol, dann auf das Zahnrad daneben, wähl unter „Netzwerkzugriff“ die Stufe „Voll“ und speichere. Sonst erreicht Claude deine n8n nicht.</li>' +
    '<li>Tippe einfach: <b>„Los geht\'s"</b>. Claude begrüßt dich, prüft die Verbindung und fragt nach deinem Vorhaben.</li>' +
    '</ol>' +
    '<p><a href="' + repoUrl + '" target="_blank" rel="noopener">Repo auf GitHub ansehen</a></p>' +
    '<p><small>Die n8n-Verbindung ist bereits im Projekt hinterlegt (nur eine anonyme Adresse, kein Key), die Skills sind schon dabei. Du musst nichts weiter einrichten.</small></p>');
}
function errHtml(msg) {
  return page('buildbar: Hinweis', '<h1>Hoppla</h1><p>' + msg + '</p><p><a href="/">zurück zum Formular</a></p>');
}
