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

OpenCode users should run the matching installer in each repo they want to expose:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\install-opencode.ps1
# Or, when PowerShell 7 is installed:
pwsh -File .\scripts\install-opencode.ps1
```

The script installs both parts of the integration:

- `confluence_safe` is merged into the shared OpenCode MCP config.
- `manage-confluence-safely` is copied to `~/.config/opencode/skills/` for global discovery.

Existing `opencode.json` and `opencode.jsonc` files are supported. The installer validates the update before touching either destination, preserves JSONC comments and unrelated settings, keeps permission rules in their security-sensitive order, writes through a verified temporary file, and creates a timestamped backup whenever it changes an existing config or skill. Re-running it with the same version is idempotent.

Pass `-ConfigPath` or `-SkillsPath` to override either destination. If both `opencode.json` and `opencode.jsonc` exist in the default directory, the installer refuses to guess; pass `-ConfigPath` explicitly.

The checked-in `examples/opencode.jsonc` remains available as a manual fallback, but it no longer needs hand-editing for the local path.

## Safety boundary

This is the local stdio profile. Changesets are in memory and disappear on restart. The section patcher preserves all markup outside one exact heading-bounded section, but clients must provide explicit Confluence storage XHTML for the replacement body. Do not expose this as a multi-user remote service without durable tenant-bound state, independent MCP authentication, and immutable audit storage.
