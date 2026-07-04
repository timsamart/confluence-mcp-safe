import assert from "node:assert/strict";
import test from "node:test";
import { digest, SafeError } from "../src/core.js";
import { publicSection, replaceSection, sectionsFromStorage } from "../src/content.js";

const storage = "<p>intro</p><h1>One</h1><p>A</p><h2>Nested</h2><p>B</p><h1>Two</h1><p>C</p>";

test("replacement changes only the selected section body", () => {
  const nested = sectionsFromStorage(storage)[1]!;
  const result = replaceSection(storage, nested.id, nested.hash, "<p>Changed</p>");
  assert.equal(result.storage, "<p>intro</p><h1>One</h1><p>A</p><h2>Nested</h2><p>Changed</p><h1>Two</h1><p>C</p>");
  assert.equal(result.storage.slice(0, nested.bodyStart), storage.slice(0, nested.bodyStart));
  assert.equal(result.storage.slice(nested.bodyStart + "<p>Changed</p>".length), storage.slice(nested.end));
  assert.equal(result.preservation.unchangedPrefixHash, digest(storage.slice(0, nested.bodyStart)));
  assert.equal(result.preservation.unchangedSuffixHash, digest(storage.slice(nested.end)));
});

test("identical repeated sections target the requested occurrence", () => {
  const repeated = "<p>prefix</p><h1>Same</h1><p>A</p><h1>Same</h1><p>A</p><h1>End</h1><p>suffix</p>";
  const sections = sectionsFromStorage(repeated);
  assert.equal(sections[0]!.storage, sections[1]!.storage);
  const result = replaceSection(repeated, sections[1]!.id, sections[1]!.hash, "<p>SECOND</p>");
  assert.equal(result.storage, "<p>prefix</p><h1>Same</h1><p>A</p><h1>Same</h1><p>SECOND</p><h1>End</h1><p>suffix</p>");
});

test("unknown macros, whitespace, entities, and siblings remain byte-identical", () => {
  const complex = "\r\n<ac:structured-macro ac:name=\"info\"><ac:rich-text-body><p>Keep&nbsp;me</p></ac:rich-text-body></ac:structured-macro>\r\n<h1 data-x=\"1\">Target</h1>\r\n<p>old</p>\r\n<h1>Next</h1><ri:user ri:account-id=\"abc\" />\r\n";
  const target = sectionsFromStorage(complex)[0]!;
  const result = replaceSection(complex, target.id, target.hash, "\r\n<p><strong>new</strong></p>\r\n");
  assert.equal(result.storage.slice(0, target.bodyStart), complex.slice(0, target.bodyStart));
  assert.equal(result.storage.slice(target.bodyStart + "\r\n<p><strong>new</strong></p>\r\n".length), complex.slice(target.end));
});

test("replacement may contain only subordinate headings", () => {
  const parent = sectionsFromStorage(storage)[0]!;
  assert.doesNotThrow(() => replaceSection(storage, parent.id, parent.hash, "<h2>Child</h2><p>x</p>"));
  assert.throws(() => replaceSection(storage, parent.id, parent.hash, "<h1>Escapes section</h1>"), (error: unknown) => error instanceof SafeError && error.code === "INVALID_INPUT");
});

test("malformed and active replacement storage is rejected", () => {
  const section = sectionsFromStorage(storage)[0]!;
  for (const replacement of ["<p>unclosed", "<script>alert(1)</script>", "<p onclick=\"x()\">x</p>", "<ac:structured-macro ac:name=\"html\" />"]) {
    assert.throws(() => replaceSection(storage, section.id, section.hash, replacement), (error: unknown) => error instanceof SafeError && error.code === "INVALID_INPUT");
  }
});

test("stale section hashes fail closed", () => {
  const section = sectionsFromStorage(storage)[0]!;
  assert.throws(() => replaceSection(storage, section.id, "sha256:stale", "<p>x</p>"), (error: unknown) => error instanceof SafeError && error.code === "VERSION_CONFLICT");
});

test("public outlines do not expose source storage or byte offsets", () => {
  const section = publicSection(sectionsFromStorage(storage)[0]!);
  assert.deepEqual(Object.keys(section).sort(), ["hash", "heading", "id", "level"]);
});
