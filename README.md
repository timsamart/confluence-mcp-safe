# confluence-mcp-safe

A runnable, local-first MCP server for bounded Confluence research and preview-before-apply anchored section updates. It supports Confluence Cloud API tokens and Data Center PATs, enforces an optional space allowlist, pins every upstream request to one origin, and never accepts credentials through MCP arguments.

## Quick start

```bash
npm install
npm run build
CONFLUENCE_BASE_URL=https://example.atlassian.net \
CONFLUENCE_DEPLOYMENT=cloud CONFLUENCE_EMAIL=you@example.com CONFLUENCE_TOKEN=... \
node dist/src/index.js
```

Copy `.env.example` into your secret-injection system; the process intentionally does not load `.env` files. Configure an MCP client to launch `node /absolute/path/to/dist/src/index.js` with those variables.

## Codex and OpenCode

After building, copy the matching file from `examples/` into your client configuration and replace its checked-in absolute server path with this checkout's `dist/src/index.js`. To install the workflow skill for either client, copy `skills/manage-confluence-safely` to the shared user location `$HOME/.agents/skills/manage-confluence-safely` (or to `.agents/skills/manage-confluence-safely` in a target repository). Restart the client if the skill is not discovered immediately.

The examples allow reads and proposal tools but leave both apply tools behind a one-time UI prompt. The apply tools also advertise `destructiveHint: true`; do not weaken the wildcard/default prompt rule.

The MVP exposes connection context, allowed spaces, bounded page search, metadata/outline/full reads, native content-template discovery, page/content-template/direct-source page creation, immutable section updates, idempotent changesets, and verified additive/mutating apply. Native template variables are escaped plain text; exact page versions can also serve as templates. Use the checked-in Codex/OpenCode examples to require a real UI approval before apply; see [client approvals](docs/CLIENT_APPROVALS.md), [architecture](docs/ARCHITECTURE.md), and the [full product concept](CONCEPT.md).

## Safety boundary

This is the local stdio profile. Changesets are in memory and disappear on restart. The section patcher preserves all markup outside one exact heading-bounded section, but clients must provide explicit Confluence storage XHTML for the replacement body. Do not expose this as a multi-user remote service without durable tenant-bound state, independent MCP authentication, and immutable audit storage.
