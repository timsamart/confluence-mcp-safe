import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import type { Page, Space } from "../src/confluence-client.js";
import { createServer } from "../src/server.js";

function textValue(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  if (!("content" in result) || !Array.isArray(result.content)) throw new Error("Expected immediate MCP tool result");
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && "text" in text);
  return JSON.parse(text.text) as Record<string, any>;
}

test("page creation binds exact space/parent, native storage, idempotency, approval, and verification", async () => {
  const bodyStorage = "<h1>Runbook</h1><p>Native <ac:link><ri:page ri:content-title=\"Home\" /></ac:link></p>";
  const parent: Page = { id: "10", title: "Operations", spaceId: "200", spaceKey: "ENG", version: 4, storage: "<p>parent</p>" };
  let created: Page | undefined;
  let createInput: { space: Space; title: string; bodyStorage: string; parentId?: string } | undefined;
  const fakeClient = {
    async identity() { return {}; }, async spaces() { return []; }, async search() { return {}; }, async updatePage() { throw new Error("not used"); },
    async listTemplates() { return []; }, async template() { throw new Error("not used"); },
    async space(id: string, key: string) { assert.equal(id, "200"); assert.equal(key, "ENG"); return { id, key, name: "Engineering" }; },
    async page(id: string) { if (id === "10") return structuredClone(parent); if (created?.id === id) return structuredClone(created); throw new Error("missing page"); },
    async titleExists() { return created !== undefined; },
    async createPage(space: Space, title: string, storage: string, parentId?: string) {
      createInput = { space: structuredClone(space), title, bodyStorage: storage, ...(parentId ? { parentId } : {}) };
      created = { id: "99", title, spaceId: space.id, spaceKey: space.key, ...(parentId ? { parentId } : {}), version: 1, storage };
      return structuredClone(created);
    }
  };
  const config: Config = { baseUrl: new URL("https://wiki.example.test"), deployment: "data_center", token: "test", connectionId: "test", allowedSpaces: new Set(["ENG"]), maxResults: 10, maxContentBytes: 50_000, changesetTtlMs: 60_000 };
  const { server } = createServer(config, fakeClient);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const arguments_ = { spaceId: "200", spaceKey: "ENG", parentId: "10", title: "Service Runbook", bodyStorage, idempotencyKey: "create-page-0001" };
  const proposal = textValue(await client.callTool({ name: "propose_page_create", arguments: arguments_ }));
  assert.equal(proposal.preview.kind, "page.create");
  assert.equal(proposal.preview.bodyStorage, bodyStorage);
  assert.deepEqual(proposal.preview.space, { id: "200", key: "ENG" });
  assert.equal(proposal.preview.parentId, "10");
  assert.deepEqual(proposal.preview.source, { kind: "storage" });
  assert.equal(proposal.policy.applyTool, "apply_additive_changeset");
  const same = textValue(await client.callTool({ name: "propose_page_create", arguments: arguments_ }));
  assert.equal(same.changesetId, proposal.changesetId);
  const conflict = await client.callTool({ name: "propose_page_create", arguments: { ...arguments_, title: "Different" } });
  assert.equal(conflict.isError, true);
  assert.equal(textValue(conflict).error.code, "IDEMPOTENCY_CONFLICT");

  const result = textValue(await client.callTool({ name: "apply_additive_changeset", arguments: { changesetId: proposal.changesetId, digest: proposal.digest } }));
  assert.equal(result.created, true); assert.equal(result.verified, true); assert.equal(result.page.id, "99");
  assert.deepEqual(createInput, { space: { id: "200", key: "ENG", name: "Engineering" }, title: "Service Runbook", bodyStorage, parentId: "10" });

  await client.close(); await server.close();
});

test("page and native content-template sources are explicit, frozen, and revalidated before create", async () => {
  const templateStorage = '<at:declarations><at:string at:name="owner" /></at:declarations><h1>Runbook</h1><p><at:var at:name="owner" /></p>';
  const sourcePage: Page = { id: "44", title: "Page template", spaceId: "200", spaceKey: "ENG", version: 7, storage: "<h1>Checklist</h1><p>Exact body</p>" };
  let created: Page | undefined;
  const fakeClient = {
    async identity() { return {}; }, async spaces() { return []; }, async search() { return {}; }, async updatePage() { throw new Error("not used"); }, async listTemplates() { return [{ templateId: "t1", name: "Runbook", spaceKey: "ENG" }]; },
    async template(id: string) { assert.equal(id, "t1"); return { templateId: "t1", name: "Runbook", spaceKey: "ENG", bodyStorage: templateStorage }; },
    async space(id: string, key: string) { return { id, key }; },
    async page(id: string) { if (id === "44") return structuredClone(sourcePage); if (created?.id === id) return structuredClone(created); throw new Error("missing page"); },
    async titleExists() { return created !== undefined; },
    async createPage(space: Space, title: string, storage: string, parentId?: string) { created = { id: "101", title, spaceId: space.id, spaceKey: space.key, ...(parentId ? { parentId } : {}), version: 1, storage }; return structuredClone(created); }
  };
  const config: Config = { baseUrl: new URL("https://wiki.example.test"), deployment: "data_center", token: "test", connectionId: "test", allowedSpaces: new Set(["ENG"]), maxResults: 10, maxContentBytes: 50_000, changesetTtlMs: 60_000 };
  const { server } = createServer(config, fakeClient);
  const client = new Client({ name: "test-client", version: "1" }); const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);

  const fromPage = textValue(await client.callTool({ name: "propose_page_create_from_page", arguments: { spaceId: "200", spaceKey: "ENG", title: "Checklist copy", sourceContentId: "44", sourceExpectedVersion: 7, idempotencyKey: "from-page-0001" } }));
  assert.equal(fromPage.preview.bodyStorage, sourcePage.storage);
  assert.deepEqual(fromPage.preview.source, { kind: "page", contentId: "44", version: 7, storageHash: fromPage.preview.bodyHash });

  const templateView = textValue(await client.callTool({ name: "get_template", arguments: { templateId: "t1" } }));
  assert.deepEqual(templateView.variables, [{ name: "owner", type: "string" }]);
  assert.equal(templateView.trust, "untrusted_external_content");
  const fromTemplate = textValue(await client.callTool({ name: "propose_page_create_from_template", arguments: { spaceId: "200", spaceKey: "ENG", title: "Runbook copy", templateId: "t1", variables: { owner: "A&B" }, idempotencyKey: "from-template-0001" } }));
  assert.equal(fromTemplate.preview.bodyStorage, "<h1>Runbook</h1><p>A&amp;B</p>");
  assert.equal(fromTemplate.preview.source.kind, "template");
  assert.equal(fromTemplate.preview.source.templateId, "t1");
  const applied = textValue(await client.callTool({ name: "apply_additive_changeset", arguments: { changesetId: fromTemplate.changesetId, digest: fromTemplate.digest } }));
  assert.equal(applied.verified, true);
  assert.equal(created?.storage, "<h1>Runbook</h1><p>A&amp;B</p>");

  await client.close(); await server.close();
});

test("page creation fails closed on title collision and invalid parent location", async () => {
  const config: Config = { baseUrl: new URL("https://wiki.example.test"), deployment: "data_center", token: "test", connectionId: "test", allowedSpaces: new Set(["ENG"]), maxResults: 10, maxContentBytes: 50_000, changesetTtlMs: 60_000 };
  const base = { async identity() { return {}; }, async spaces() { return []; }, async search() { return {}; }, async listTemplates() { return []; }, async template() { throw new Error("not used"); }, async updatePage() { return {} as Page; }, async createPage() { throw new Error("must not create"); }, async space() { return { id: "200", key: "ENG" }; } };
  const collisionServer = createServer(config, { ...base, async page() { return { id: "10", title: "Parent", spaceId: "200", spaceKey: "ENG", version: 1, storage: "" }; }, async titleExists() { return true; } }).server;
  const collisionClient = new Client({ name: "test", version: "1" }); const [ct1, st1] = InMemoryTransport.createLinkedPair(); await collisionServer.connect(st1); await collisionClient.connect(ct1);
  const collision = await collisionClient.callTool({ name: "propose_page_create", arguments: { spaceId: "200", spaceKey: "ENG", title: "Exists", bodyStorage: "<p>x</p>", idempotencyKey: "collision-0001" } });
  assert.equal(textValue(collision).error.code, "TITLE_CONFLICT"); await collisionClient.close(); await collisionServer.close();

  const parentServer = createServer(config, { ...base, async page() { return { id: "10", title: "Wrong", spaceId: "999", spaceKey: "OTHER", version: 1, storage: "" }; }, async titleExists() { return false; } }).server;
  const parentClient = new Client({ name: "test", version: "1" }); const [ct2, st2] = InMemoryTransport.createLinkedPair(); await parentServer.connect(st2); await parentClient.connect(ct2);
  const wrongParent = await parentClient.callTool({ name: "propose_page_create", arguments: { spaceId: "200", spaceKey: "ENG", parentId: "10", title: "Page", bodyStorage: "<p>x</p>", idempotencyKey: "parent-0001" } });
  assert.equal(wrongParent.isError, true); await parentClient.close(); await parentServer.close();
});

test("content-template creation refuses apply after the selected template changes", async () => {
  let templateReads = 0; let createCalls = 0;
  const config: Config = { baseUrl: new URL("https://wiki.example.test"), deployment: "data_center", token: "test", connectionId: "test", allowedSpaces: new Set(["ENG"]), maxResults: 10, maxContentBytes: 50_000, changesetTtlMs: 60_000 };
  const fakeClient = {
    async identity() { return {}; }, async spaces() { return []; }, async listTemplates() { return []; }, async search() { return {}; }, async updatePage() { throw new Error("not used"); }, async page() { throw new Error("not used"); },
    async space(id: string, key: string) { return { id, key }; }, async titleExists() { return false; },
    async template() { templateReads += 1; return { templateId: "t1", name: "Template", spaceKey: "ENG", bodyStorage: templateReads === 1 ? "<p>original</p>" : "<p>changed</p>" }; },
    async createPage() { createCalls += 1; throw new Error("must not create"); }
  };
  const { server } = createServer(config, fakeClient); const client = new Client({ name: "test", version: "1" }); const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  const proposal = textValue(await client.callTool({ name: "propose_page_create_from_template", arguments: { spaceId: "200", spaceKey: "ENG", title: "Page", templateId: "t1", variables: {}, idempotencyKey: "stale-template-1" } }));
  const result = await client.callTool({ name: "apply_additive_changeset", arguments: { changesetId: proposal.changesetId, digest: proposal.digest } });
  assert.equal(result.isError, true); assert.equal(textValue(result).error.code, "VERSION_CONFLICT"); assert.equal(createCalls, 0);
  await client.close(); await server.close();
});
