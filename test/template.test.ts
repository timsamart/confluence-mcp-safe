import assert from "node:assert/strict";
import test from "node:test";
import { resolveTemplateStorage } from "../src/content.js";
import { SafeError } from "../src/core.js";

const template = '<at:declarations><at:string at:name="owner" /><at:textarea at:name="notes" /><at:list at:name="tier"><at:option at:value="one" /><at:option at:value="two" /></at:list></at:declarations><h1><at:var at:name="owner" /></h1><p><at:var at:name="notes" /></p><p><at:var at:name="tier" /></p>';

test("native template variables resolve deterministically as escaped text", () => {
  const result = resolveTemplateStorage(template, { owner: "A&B <Ops>", notes: "line 1\nline 2", tier: "two" });
  assert.equal(result.storage, "<h1>A&amp;B &lt;Ops&gt;</h1><p>line 1<br />line 2</p><p>two</p>");
  assert.deepEqual(result.variables, [
    { name: "owner", type: "string" }, { name: "notes", type: "textarea" }, { name: "tier", type: "list", options: ["one", "two"] }
  ]);
});

test("native template resolution rejects missing, extra, invalid, and undeclared variables", () => {
  assert.throws(() => resolveTemplateStorage(template, { owner: "x", notes: "y" }), (error: unknown) => error instanceof SafeError && error.code === "INVALID_INPUT");
  assert.throws(() => resolveTemplateStorage(template, { owner: "x", notes: "y", tier: "three" }), (error: unknown) => error instanceof SafeError && error.code === "INVALID_INPUT");
  assert.throws(() => resolveTemplateStorage(template, { owner: "x", notes: "y", tier: "one", ghost: "z" }), (error: unknown) => error instanceof SafeError && error.code === "INVALID_INPUT");
  assert.throws(() => resolveTemplateStorage('<p><at:var at:name="ghost" /></p>', {}), (error: unknown) => error instanceof SafeError && error.code === "INVALID_INPUT");
});
