import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "../src/config.js";
import { ConfluenceClient } from "../src/confluence-client.js";

test("Data Center requests preserve the configured context path", async () => {
  let requested = "";
  let authorization = "";
  const fetcher: typeof fetch = async (input, init) => {
    requested = String(input);
    authorization = String((init?.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ username: "ada" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const config: Config = { baseUrl: new URL("https://wiki.example.test/confluence"), deployment: "data_center", token: "secret-value", connectionId: "test", allowedSpaces: "*", maxResults: 10, maxContentBytes: 10_000, changesetTtlMs: 60_000 };
  const result = await new ConfluenceClient(config, fetcher).identity();
  assert.equal(requested, "https://wiki.example.test/confluence/rest/api/user/current");
  assert.equal(authorization, "Bearer secret-value");
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("Data Center page creation uses exact space, ancestor, and storage body", async () => {
  let createBody = "";
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") {
      createBody = String(init.body);
      return new Response(JSON.stringify({ id: "99" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "99", title: "Child", space: { id: "200", key: "ENG" }, ancestors: [{ id: "10" }], version: { number: 1 }, body: { storage: { value: "<p>body</p>" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const config: Config = { baseUrl: new URL("https://wiki.example.test/confluence"), deployment: "data_center", token: "test", connectionId: "test", allowedSpaces: new Set(["ENG"]), maxResults: 10, maxContentBytes: 10_000, changesetTtlMs: 60_000 };
  const page = await new ConfluenceClient(config, fetcher).createPage({ id: "200", key: "ENG" }, "Child", "<p>body</p>", "10");
  assert.deepEqual(JSON.parse(createBody), { type: "page", status: "current", title: "Child", space: { key: "ENG" }, ancestors: [{ id: "10" }], body: { storage: { representation: "storage", value: "<p>body</p>" } } });
  assert.equal(page.parentId, "10");
});

test("Cloud page creation uses native v2 spaceId and parentId", async () => {
  let createBody = "";
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") {
      createBody = String(init.body);
      return new Response(JSON.stringify({ id: "99" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "99", title: "Child", space: { id: "200", key: "ENG" }, ancestors: [{ id: "10" }], version: { number: 1 }, body: { storage: { value: "<p>body</p>" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const config: Config = { baseUrl: new URL("https://example.atlassian.net"), deployment: "cloud", token: "test", email: "a@example.com", connectionId: "test", allowedSpaces: new Set(["ENG"]), maxResults: 10, maxContentBytes: 10_000, changesetTtlMs: 60_000 };
  await new ConfluenceClient(config, fetcher).createPage({ id: "200", key: "ENG" }, "Child", "<p>body</p>", "10");
  assert.deepEqual(JSON.parse(createBody), { spaceId: "200", status: "current", title: "Child", parentId: "10", body: { representation: "storage", value: "<p>body</p>" } });
});

test("content templates use the native template endpoints and storage representation", async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    requested.push(String(input));
    if (String(input).includes("/template/page?")) return new Response(JSON.stringify({ results: [{ templateId: "t1", name: "Runbook", space: { key: "ENG" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ templateId: "t1", name: "Runbook", space: { key: "ENG" }, body: { storage: { value: "<p>template</p>" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const config: Config = { baseUrl: new URL("https://example.atlassian.net"), deployment: "cloud", token: "test", email: "a@example.com", connectionId: "test", allowedSpaces: new Set(["ENG"]), maxResults: 10, maxContentBytes: 10_000, changesetTtlMs: 60_000 };
  const client = new ConfluenceClient(config, fetcher);
  assert.deepEqual(await client.listTemplates("ENG", 5), [{ templateId: "t1", name: "Runbook", spaceKey: "ENG" }]);
  assert.equal((await client.template("t1")).bodyStorage, "<p>template</p>");
  assert.match(requested[0] ?? "", /\/wiki\/rest\/api\/template\/page\?/);
  assert.match(requested[1] ?? "", /\/wiki\/rest\/api\/template\/t1$/);
});
