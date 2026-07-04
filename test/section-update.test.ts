import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import type { Page } from "../src/confluence-client.js";
import { createServer } from "../src/server.js";

function resultValue(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  if (!("content" in result) || !Array.isArray(result.content)) throw new Error("Expected immediate MCP tool result");
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && "text" in text);
  return JSON.parse(text.text) as Record<string, any>;
}

test("MCP proposal/apply preserves the exact page outside one replacement body", async () => {
  const original = "\r\n<ac:structured-macro ac:name=\"info\"><ac:rich-text-body><p>KEEP-MACRO</p></ac:rich-text-body></ac:structured-macro>\r\n<h1 data-anchor=\"stable\">Target</h1>\r\n<p>old body</p>\r\n<h1>Next</h1><ri:user ri:account-id=\"KEEP-USER\" />\r\n";
  const replacementBody = "\r\n<p><strong>new body</strong></p><h2>Child</h2><p>child body</p>\r\n";
  let state: Page = { id: "42", title: "Runbook", spaceKey: "ENG", version: 7, storage: original };
  let writtenStorage: string | undefined;
  const fakeClient = {
    async listTemplates() { return []; }, async template() { throw new Error("not used"); },
    async identity() { return { accountId: "test" }; },
    async spaces() { return []; },
    async space() { throw new Error("not used"); },
    async search() { return {}; },
    async titleExists() { return false; },
    async createPage() { throw new Error("not used"); },
    async page() { return structuredClone(state); },
    async updatePage(page: Page, storage: string): Promise<Page> {
      assert.equal(page.version, state.version);
      writtenStorage = storage;
      state = { ...state, version: state.version + 1, storage };
      return structuredClone(state);
    }
  };
  const config: Config = { baseUrl: new URL("https://wiki.example.test"), deployment: "data_center", token: "test", connectionId: "test", allowedSpaces: new Set(["ENG"]), maxResults: 10, maxContentBytes: 50_000, changesetTtlMs: 60_000 };
  const { server } = createServer(config, fakeClient);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const outline = resultValue(await client.callTool({ name: "get_content", arguments: { contentId: "42", view: "outline" } }));
  const target = (outline.sections as Array<Record<string, any>>).find((section) => section.heading === "Target");
  assert.ok(target);
  const proposalResponse = await client.callTool({
    name: "propose_page_update",
    arguments: { contentId: "42", expectedVersion: 7, sectionId: target.id, sectionHash: target.hash, replacementStorage: replacementBody, versionMessage: "Update target only" }
  });
  assert.equal(proposalResponse.isError, undefined);
  const changeset = resultValue(proposalResponse);
  assert.equal(changeset.preview.replacementStorage, replacementBody);
  assert.equal("action" in changeset, false);
  assert.equal(JSON.stringify(changeset).includes("KEEP-MACRO"), false);
  assert.equal(JSON.stringify(changeset).includes("KEEP-USER"), false);

  const applied = resultValue(await client.callTool({ name: "apply_mutating_changeset", arguments: { changesetId: changeset.changesetId, digest: changeset.digest } }));
  const targetHeadingEnd = original.indexOf("</h1>", original.indexOf("Target")) + "</h1>".length;
  const nextHeadingStart = original.indexOf("<h1>Next</h1>");
  const expected = `${original.slice(0, targetHeadingEnd)}${replacementBody}${original.slice(nextHeadingStart)}`;
  assert.equal(writtenStorage, expected);
  assert.equal(applied.verified, true);
  assert.equal(applied.preservationVerified, true);
  assert.equal(state.storage.startsWith(original.slice(0, targetHeadingEnd)), true);
  assert.equal(state.storage.endsWith(original.slice(nextHeadingStart)), true);

  await client.close();
  await server.close();
});
