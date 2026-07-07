import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const baseEnv = {
  CONFLUENCE_BASE_URL: "https://confluence.example.test",
  CONFLUENCE_TOKEN: "test-token",
  CONFLUENCE_CONNECTION_ID: "test",
  CONFLUENCE_ALLOWED_SPACES: "*"
};

test("Data Center ignores an unresolved Cloud-only email placeholder", () => {
  const config = loadConfig({
    ...baseEnv,
    CONFLUENCE_DEPLOYMENT: "data_center",
    CONFLUENCE_EMAIL: "{env:CONFLUENCE_EMAIL}"
  });
  assert.equal(config.email, undefined);
});

test("Cloud still requires a resolved email address", () => {
  assert.throws(() => loadConfig({
    ...baseEnv,
    CONFLUENCE_DEPLOYMENT: "cloud",
    CONFLUENCE_EMAIL: "{env:CONFLUENCE_EMAIL}"
  }), /required for Confluence Cloud/);
});
