# confluence-mcp-safe

A runnable, local-first MCP server for bounded Confluence research and preview-before-apply anchored section updates. It supports Confluence Cloud API tokens and Data Center PATs, enforces an optional space allowlist, pins every upstream request to one origin, and never accepts credentials through MCP arguments.

## Quick start

```bash
npm install
npm run build
CONFLUENCE_BASE_URL=https://example.atlassian.net \
CONFLUENCE_DEPLOYMENT=cloud CONFLUENCE_EMAIL=you@example.com CONFLUENCE_TOKEN=... \
CONFLUENCE_ALLOWED_SPACES=DOCS,ENG \
node dist/src/index.js
```

Copy `.env.example` into your secret-injection system; the process intentionally does not load `.env` files. Configure an MCP client to launch `node /absolute/path/to/dist/src/index.js` with those variables.

## Windows PowerShell setup

Persist the runtime variables once per Windows user profile:

```powershell
$vars = @{
  CONFLUENCE_BASE_URL = 'https://example.atlassian.net'
  CONFLUENCE_DEPLOYMENT = 'cloud' # use 'data_center' for Confluence Server/Data Center
  CONFLUENCE_EMAIL = 'you@example.com' # cloud only
  CONFLUENCE_TOKEN = 'replace-at-runtime'
  CONFLUENCE_CONNECTION_ID = 'work'
  CONFLUENCE_ALLOWED_SPACES = 'DOCS,ENG'
  CONFLUENCE_MAX_RESULTS = '50'
  CONFLUENCE_MAX_CONTENT_BYTES = '200000'
  CONFLUENCE_CHANGESET_TTL_SECONDS = '600'
}

foreach ($pair in $vars.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($pair.Key, $pair.Value, 'User')
}
```

Open a new PowerShell session after running that snippet so the new user variables are visible immediately.

## Deployment modes

| Mode | Base URL | Email | Token | Auth shape |
| --- | --- | --- | --- | --- |
| Cloud | `https://your-domain.atlassian.net` | required | Confluence API token | Basic auth with email + token |
| Data Center | `https://wiki.company.tld[/context]` | omit | Confluence PAT | Bearer token |

`CONFLUENCE_DEPLOYMENT` switches the API paths and auth method. `CONFLUENCE_ALLOWED_SPACES` accepts a comma-separated allowlist or `*`, and `CONFLUENCE_MAX_CONTENT_BYTES` bounds preview payloads.

## Codex and OpenCode

Codex users can keep using `examples/codex-config.toml` or copy the same server block into their local config.

OpenCode users should run the matching installer in each repo they want to expose after the first build:

```powershell
pwsh -ExecutionPolicy Bypass -File .\scripts\install-opencode.ps1
```

The script builds `dist/src/index.js` if it is missing, then merges a `confluence_safe` entry into the shared OpenCode config at `~/.config/opencode/opencode.json`. It keeps unrelated settings intact and points OpenCode at this checkout through the env vars you set above.
Pass `-ConfigPath` if your OpenCode config lives somewhere else.

The checked-in `examples/opencode.jsonc` remains available as a manual fallback, but it no longer needs hand-editing for the local path.

## Safety boundary

This is the local stdio profile. Changesets are in memory and disappear on restart. The section patcher preserves all markup outside one exact heading-bounded section, but clients must provide explicit Confluence storage XHTML for the replacement body. Do not expose this as a multi-user remote service without durable tenant-bound state, independent MCP authentication, and immutable audit storage.
