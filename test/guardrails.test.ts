import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import { ConfluenceClient } from "../src/confluence-client.js";
import { createServer } from "../src/server.js";

function textValue(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  if (!("content" in result) || !Array.isArray(result.content)) throw new Error("Expected immediate MCP tool result");
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && "text" in text);
  return JSON.parse(text.text) as Record<string, any>;
}

test("Confluence mutation guardrails fail closed before any upstream write", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ method: init?.method ?? "GET", url: String(input) });
    throw new Error(`unexpected upstream call: ${init?.method ?? "GET"} ${String(input)}`);
  };
  const config: Config = {
    baseUrl: new URL("https://wiki.example.test"),
    deployment: "data_center",
    token: "test",
    connectionId: "test",
    allowedSpaces: new Set(["ENG"]),
    maxResults: 10,
    maxContentBytes: 50_000,
    changesetTtlMs: 60_000
  };
  const { server } = createServer(config, new ConfluenceClient(config, fetcher));
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  for (const [index, spaceKey] of ["OPS", "SEC", "HR", "FIN", "LEGAL"].entries()) {
    const create = await client.callTool({
      name: "propose_page_create",
      arguments: { spaceId: "200", spaceKey, title: `Denied ${index}`, bodyStorage: "<p>Denied</p>", idempotencyKey: `deny-create-${index}` }
    });
    assert.equal(create.isError, true);
    assert.equal(textValue(create).error.code, "POLICY_DENIED");

    const fromPage = await client.callTool({
      name: "propose_page_create_from_page",
      arguments: {
        spaceId: "200",
        spaceKey,
        title: `Denied copy ${index}`,
        sourceContentId: "42",
        sourceExpectedVersion: 1,
        idempotencyKey: `deny-page-${index}`
      }
    });
    assert.equal(fromPage.isError, true);
    assert.equal(textValue(fromPage).error.code, "POLICY_DENIED");

    const fromTemplate = await client.callTool({
      name: "propose_page_create_from_template",
      arguments: {
        spaceId: "200",
        spaceKey,
        title: `Denied template ${index}`,
        templateId: "t1",
        variables: {},
        idempotencyKey: `deny-template-${index}`
      }
    });
    assert.equal(fromTemplate.isError, true);
    assert.equal(textValue(fromTemplate).error.code, "POLICY_DENIED");
  }

  const forgedApply = await client.callTool({ name: "apply_additive_changeset", arguments: { changesetId: "cs_fake", digest: "sha256:deadbeef" } });
  assert.equal(forgedApply.isError, true);
  assert.equal(textValue(forgedApply).error.code, "INVALID_INPUT");

  assert.equal(calls.length, 0);

  await client.close();
  await server.close();
});
