import { createHash, randomUUID } from "node:crypto";

export type ErrorCode =
  | "CONNECTION_AUTH_INVALID" | "POLICY_DENIED" | "NOT_FOUND_OR_NOT_VISIBLE"
  | "CONTENT_TOO_LARGE" | "AMBIGUOUS_LOCATOR" | "CHANGESET_EXPIRED"
  | "CHANGESET_DIGEST_MISMATCH" | "CHANGESET_ALREADY_USED" | "VERSION_CONFLICT"
  | "UPSTREAM_RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "VERIFICATION_FAILED"
  | "TITLE_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "INVALID_INPUT";

export class SafeError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly retryable = false) { super(message); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export type PageUpdateAction = {
  operation: "page.update.section";
  contentId: string;
  title: string;
  spaceKey?: string;
  expectedVersion: number;
  sectionId: string;
  sectionHash: string;
  expectedStorageHash: string;
  replacementStorage: string;
  replacementBodyHash: string;
  unchangedPrefixHash: string;
  unchangedSuffixHash: string;
  resultingStorageHash: string;
  message: string;
};

export type PageCreateAction = {
  operation: "page.create";
  spaceId: string;
  spaceKey: string;
  parentId?: string;
  title: string;
  bodyStorage: string;
  bodyHash: string;
  idempotencyKey: string;
  source:
    | { kind: "storage" }
    | { kind: "page"; contentId: string; version: number; storageHash: string }
    | { kind: "template"; templateId: string; name: string; templateHash: string; variables: Record<string, string> };
};

export type PageAction = PageUpdateAction | PageCreateAction;

export type Changeset = {
  changesetId: string;
  digest: string;
  operation: PageAction["operation"];
  risk: "additive" | "mutating";
  target: { contentId?: string; spaceId?: string; spaceKey?: string; parentId?: string; title: string };
  preconditions:
    | { kind: "page.update.section"; version: number; storageHash: string; sectionId: string; sectionHash: string }
    | { kind: "page.create"; titleAbsent: true; parentId?: string };
  createdAt: string;
  expiresAt: string;
  preview:
    | {
        kind: "page.update.section"; summary: string; replacementStorage: string; replacementBytes: number;
        replacementBodyHash: string; unchangedPrefixHash: string; unchangedSuffixHash: string; resultingStorageHash: string;
      }
    | {
        kind: "page.create"; summary: string; title: string; space: { id: string; key: string }; parentId?: string;
        bodyStorage: string; bodyBytes: number; bodyHash: string; source: PageCreateAction["source"];
      };
  policy: { decision: "require_confirmation"; revision: "local-v1"; enforcement: "client_tool_approval"; applyTool: "apply_additive_changeset" | "apply_mutating_changeset" };
  used: boolean;
};

type StoredChangeset = { view: Changeset; action: PageAction };

export class ChangesetStore {
  readonly #items = new Map<string, StoredChangeset>();
  readonly #idempotency = new Map<string, { actionDigest: string; changesetId: string }>();
  constructor(private readonly ttlMs: number, private readonly now = () => Date.now()) {}
  create(action: PageAction): Changeset {
    if (action.operation === "page.create") {
      const ledgerKey = `page.create:${action.idempotencyKey}`;
      const actionDigest = digest(action);
      const existing = this.#idempotency.get(ledgerKey);
      if (existing) {
        if (existing.actionDigest !== actionDigest) throw new SafeError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different page create request");
        return this.get(existing.changesetId);
      }
    }
    const created = this.now();
    const material = { action, created, nonce: randomUUID() };
    const changeset: Changeset = {
      changesetId: `cs_${randomUUID()}`,
      digest: digest(material), operation: action.operation, risk: action.operation === "page.create" ? "additive" : "mutating",
      target: action.operation === "page.create"
        ? { spaceId: action.spaceId, spaceKey: action.spaceKey, ...(action.parentId ? { parentId: action.parentId } : {}), title: action.title }
        : { contentId: action.contentId, ...(action.spaceKey ? { spaceKey: action.spaceKey } : {}), title: action.title },
      preconditions: action.operation === "page.create"
        ? { kind: "page.create", titleAbsent: true, ...(action.parentId ? { parentId: action.parentId } : {}) }
        : { kind: "page.update.section", version: action.expectedVersion, storageHash: action.expectedStorageHash, sectionId: action.sectionId, sectionHash: action.sectionHash },
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + this.ttlMs).toISOString(),
      preview: action.operation === "page.create"
        ? {
            kind: "page.create", summary: `Create and publish one page in ${action.spaceKey}${action.parentId ? ` under parent ${action.parentId}` : " at the space root"}`,
            title: action.title, space: { id: action.spaceId, key: action.spaceKey }, ...(action.parentId ? { parentId: action.parentId } : {}),
            bodyStorage: action.bodyStorage, bodyBytes: Buffer.byteLength(action.bodyStorage), bodyHash: action.bodyHash,
            source: action.source
          }
        : {
            kind: "page.update.section", summary: `Replace only the body of anchored section ${action.sectionId} on page ${action.contentId}`,
            replacementStorage: action.replacementStorage, replacementBytes: Buffer.byteLength(action.replacementStorage),
            replacementBodyHash: action.replacementBodyHash, unchangedPrefixHash: action.unchangedPrefixHash,
            unchangedSuffixHash: action.unchangedSuffixHash, resultingStorageHash: action.resultingStorageHash
          },
      policy: { decision: "require_confirmation", revision: "local-v1", enforcement: "client_tool_approval", applyTool: action.operation === "page.create" ? "apply_additive_changeset" : "apply_mutating_changeset" }, used: false
    };
    this.#items.set(changeset.changesetId, { view: changeset, action });
    if (action.operation === "page.create") this.#idempotency.set(`page.create:${action.idempotencyKey}`, { actionDigest: digest(action), changesetId: changeset.changesetId });
    return structuredClone(changeset);
  }
  get(id: string): Changeset {
    const item = this.#items.get(id);
    if (!item) throw new SafeError("INVALID_INPUT", "Unknown changeset ID");
    return structuredClone(item.view);
  }
  getAction(id: string): PageAction {
    const item = this.#items.get(id);
    if (!item) throw new SafeError("INVALID_INPUT", "Unknown changeset ID");
    return structuredClone(item.action);
  }
  discard(id: string): { discarded: true } {
    const item = this.#items.get(id);
    if (item?.view.used) throw new SafeError("CHANGESET_ALREADY_USED", "Applied changesets cannot be discarded");
    this.#items.delete(id);
    return { discarded: true };
  }
  consume(id: string, suppliedDigest: string): PageAction {
    const item = this.#items.get(id);
    if (!item) throw new SafeError("INVALID_INPUT", "Unknown changeset ID");
    if (item.view.used) throw new SafeError("CHANGESET_ALREADY_USED", "Changeset has already been applied");
    if (this.now() >= Date.parse(item.view.expiresAt)) throw new SafeError("CHANGESET_EXPIRED", "Changeset has expired");
    if (item.view.digest !== suppliedDigest) throw new SafeError("CHANGESET_DIGEST_MISMATCH", "Changeset digest does not match");
    item.view.used = true;
    return structuredClone(item.action);
  }
}

export type AuditEvent = { id: string; at: string; operation: string; target?: string; outcome: "allowed" | "succeeded" | "failed"; correlationId: string };
export class AuditLog {
  readonly #events: AuditEvent[] = [];
  record(event: Omit<AuditEvent, "id" | "at">): void { this.#events.push({ id: randomUUID(), at: new Date().toISOString(), ...event }); }
  list(): readonly AuditEvent[] { return structuredClone(this.#events); }
}

export function safeResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } };
}
export function errorResult(error: unknown) {
  const safe = error instanceof SafeError ? error : new SafeError("UPSTREAM_UNAVAILABLE", "Unexpected server failure", true);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: safe.code, message: safe.message, retryable: safe.retryable } }, null, 2) }] };
}
