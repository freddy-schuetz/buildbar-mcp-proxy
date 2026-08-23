# buildbar-mcp-proxy

Capability-URL-Weiterleitung vor den Multi-Tenant-n8n-mcp.

**Zweck:** Teilnehmer-Repos brauchen dann **keinen Token und keine custom Header** in
der `.mcp.json` — nur eine nicht-erratbare URL:

```json
{ "mcpServers": { "n8n-mcp": { "type": "http", "url": "https://hub.buildbar.at/g/<GRUPPEN-KEY>/mcp" } } }
```

Der Proxy (Caddy) injiziert `Authorization`, `x-n8n-url`, `x-n8n-key` **server-seitig**
aus ENV und leitet an `https://mcp.buildbar.at` weiter. Dadurch:

- Teilnehmer-Repo kann **public** sein (kein Geheimnis drin) → eigener GitHub reicht, keine Einladung.
- **Umgeht** die fehlende Custom-Header-Weitergabe von claude.ai/code (das Repo hat gar keine Header).

**ENV (in Coolify setzen, nicht hier committen):**
`DEMO_KEY`, `MCP_AUTH_TOKEN`, `DEMO_N8N_URL`, `DEMO_N8N_KEY`.

Pro weiterer Gruppe: eigenen `@grp`-Block + eigene ENV (eigener KEY, eigene n8n-Creds).
