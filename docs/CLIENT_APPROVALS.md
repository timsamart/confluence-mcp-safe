# Human approval before Confluence writes

`confluence-mcp-safe` makes every update or creation a digest-bound, expiring changeset. Creation binds an idempotency key, exact space ID/key, optional parent page, title, and complete storage-XHTML body; updates revalidate the exact page version and storage hash. That protects the target and payload, but an MCP server cannot independently prove that a human clicked a button: a normal tool call carries the client request, not a cryptographically trusted human-confirmation claim.

Enforce the human boundary in the MCP client. The checked-in examples fail safely for new tools and require approval for both `apply_additive_changeset` and `apply_mutating_changeset`:

- `examples/codex-config.toml` sets the server default to `prompt`, then allows only known reads and local changeset operations automatically.
- `examples/opencode.jsonc` sets every `confluence_safe_*` tool to `ask`, then allows only known reads and local changeset operations.

Review the exact replacement fragment or complete new-page body, source provenance, and hashes before approving. Template discovery and proposal tools are safe to run without a prompt because they cannot publish; `apply_additive_changeset` remains gated. In OpenCode, choose **once**, not **always**, for apply calls. A `confirmed: true` argument or confirmation phrase is deliberately not accepted because the model could supply it.

For clients without per-tool approval, disable write tools or integrate an external approval service bound to the changeset digest and authenticated human identity. Skill instructions are not a security boundary.
