import assert from "node:assert/strict";
import test from "node:test";
import { ChangesetStore, SafeError } from "../src/core.js";

const action = { operation: "page.update.section" as const, contentId: "42", title: "Runbook", expectedVersion: 3, sectionId: "sec_1", sectionHash: "sha256:before", expectedStorageHash: "sha256:page", replacementStorage: "<p>B</p>", replacementBodyHash: "sha256:body", unchangedPrefixHash: "sha256:prefix", unchangedSuffixHash: "sha256:suffix", resultingStorageHash: "sha256:result", message: "Safe update" };

test("changesets are digest-bound and one-time", () => {
  const store = new ChangesetStore(60_000);
  const item = store.create(action);
  assert.throws(() => store.consume(item.changesetId, "sha256:nope"), (error: unknown) => error instanceof SafeError && error.code === "CHANGESET_DIGEST_MISMATCH");
  const consumed = store.consume(item.changesetId, item.digest);
  assert.equal(consumed.operation === "page.update.section" ? consumed.contentId : undefined, "42");
  assert.throws(() => store.consume(item.changesetId, item.digest), (error: unknown) => error instanceof SafeError && error.code === "CHANGESET_ALREADY_USED");
});
