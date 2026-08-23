# buildbar-mcp-hub

Self-Service-Weiterleitung vor dem Multi-Tenant-n8n-mcp.

**Zweck:** Jeder Teilnehmer nutzt seine **eigene** n8n-Instanz. Auf `https://hub.buildbar.at`
traegt er n8n-URL + API-Key ein und bekommt eine **persoenliche Verbindungs-URL**:

```json
{ "mcpServers": { "n8n-mcp": { "type": "http", "url": "https://hub.buildbar.at/g/<TOKEN>/mcp" } } }
```

Der Hub speichert `{token -> (url, key)}` **server-seitig**, injiziert bei jedem Aufruf
`Authorization` + `x-n8n-url` + `x-n8n-key` und leitet an `mcp.buildbar.at` weiter. Dadurch:

- Teilnehmer-Repo enthaelt **nur die URL** -> kein Key im Repo, Repo darf **public** sein.
- **Keine custom Header** noetig (claude.ai/code reicht die eh nicht durch).
- Eigene n8n pro Teilnehmer, **im Prozess abgefragt** (Formular).

**ENV (Coolify):** `MCP_AUTH_TOKEN` (Token des Multi-Tenant-Servers), `MCP_UPSTREAM`
(Default `https://mcp.buildbar.at`), optional `DATA_FILE` (Default `/data/tokens.json`;
mit Volume ueberleben Registrierungen einen Redeploy).

Node + Express + http-proxy. Laeuft auf :80 hinter Coolifys Traefik.
