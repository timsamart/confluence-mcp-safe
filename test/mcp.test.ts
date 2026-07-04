import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

test("MCP server advertises the safe Confluence vertical slice", async () => {
  const config: Config = { baseUrl: new URL("https://wiki.example.test"), deployment: "data_center", token: "test", connectionId: "test", allowedSpaces: "*", maxResults: 10, maxContentBytes: 10_000, changesetTtlMs: 60_000 };
  const { server } = createServer(config);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["get_context", "list_spaces", "list_templates", "get_template", "search_content", "get_content", "propose_page_create", "propose_page_create_from_page", "propose_page_create_from_template", "propose_page_update", "get_changeset", "discard_changeset", "apply_additive_changeset", "apply_mutating_changeset"]);
  assert.equal(tools.tools.find((tool) => tool.name === "apply_additive_changeset")?.annotations?.destructiveHint, true);
  await client.close();
  await server.close();
});
