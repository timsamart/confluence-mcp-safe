import type { Config } from "./config.js";
import { SafeError } from "./core.js";

type Json = Record<string, unknown>;

export type Page = { id: string; title: string; spaceId?: string; spaceKey?: string; parentId?: string; version: number; storage: string; webUrl?: string };
export type Space = { id: string; key: string; name?: string };
export type ContentTemplate = { templateId: string; name: string; description?: string; spaceKey?: string; bodyStorage: string };
export type ContentTemplateSummary = Omit<ContentTemplate, "bodyStorage">;

export class ConfluenceClient {
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, init: RequestInit = {}): Promise<Json> {
    const target = new URL(path.replace(/^\//, ""), `${this.config.baseUrl.href.replace(/\/$/, "")}/`);
    if (target.origin !== this.config.baseUrl.origin) throw new SafeError("INVALID_INPUT", "Request escaped configured Confluence origin");
    const auth = this.config.deployment === "cloud"
      ? `Basic ${Buffer.from(`${this.config.email}:${this.config.token}`).toString("base64")}` : `Bearer ${this.config.token}`;
    let response: Response;
    try {
      response = await this.fetcher(target, { ...init, signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json", Authorization: auth, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    } catch { throw new SafeError("UPSTREAM_UNAVAILABLE", "Confluence is unavailable", true); }
    if (response.status === 401) throw new SafeError("CONNECTION_AUTH_INVALID", "Confluence rejected the configured credential");
    if (response.status === 403) throw new SafeError("POLICY_DENIED", "Confluence denied this operation");
    if (response.status === 404) throw new SafeError("NOT_FOUND_OR_NOT_VISIBLE", "Content was not found or is not visible");
    if (response.status === 409 || response.status === 412) throw new SafeError("VERSION_CONFLICT", "Content changed; create a new proposal");
    if (response.status === 429) throw new SafeError("UPSTREAM_RATE_LIMITED", "Confluence rate limit reached", true);
    if (!response.ok) throw new SafeError("UPSTREAM_UNAVAILABLE", `Confluence request failed with status ${response.status}`, response.status >= 500);
    return response.status === 204 ? {} : await response.json() as Json;
  }
  private enforceSpace(key?: string): void {
    if (key && this.config.allowedSpaces !== "*" && !this.config.allowedSpaces.has(key.toUpperCase())) throw new SafeError("POLICY_DENIED", `Space ${key} is outside CONFLUENCE_ALLOWED_SPACES`);
  }
  async identity() {
    return this.request(this.config.deployment === "cloud" ? "/wiki/rest/api/user/current" : "/rest/api/user/current");
  }
  async spaces(limit: number) {
    const bounded = Math.min(limit, this.config.maxResults);
    const path = this.config.deployment === "cloud" ? `/wiki/api/v2/spaces?limit=${bounded}` : `/rest/api/space?limit=${bounded}`;
    const data = await this.request(path);
    const items = (Array.isArray(data.results) ? data.results : []) as Json[];
    return this.config.allowedSpaces === "*" ? items : items.filter((item) => typeof item.key === "string" && this.config.allowedSpaces !== "*" && this.config.allowedSpaces.has(item.key.toUpperCase()));
  }
  async space(id: string, key: string): Promise<Space> {
    this.enforceSpace(key);
    const path = this.config.deployment === "cloud" ? `/wiki/api/v2/spaces/${encodeURIComponent(id)}` : `/rest/api/space/${encodeURIComponent(key)}`;
    const raw = await this.request(path);
    if (String(raw.id) !== id || raw.key !== key) throw new SafeError("INVALID_INPUT", "Confluence space ID and key did not resolve to the same exact space");
    return { id, key, ...(typeof raw.name === "string" ? { name: raw.name } : {}) };
  }
  async search(text: string, limit: number) {
    const bounded = Math.min(limit, this.config.maxResults);
    const escaped = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const allow = this.config.allowedSpaces === "*" ? "" : ` AND space in (${[...this.config.allowedSpaces].map((key) => `"${key}"`).join(",")})`;
    const cql = `type=page AND text~"${escaped}"${allow}`;
    const prefix = this.config.deployment === "cloud" ? "/wiki" : "";
    return this.request(`${prefix}/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${bounded}`);
  }
  async page(id: string): Promise<Page> {
    const prefix = this.config.deployment === "cloud" ? "/wiki" : "";
    const path = `${prefix}/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,version,space,ancestors`;
    const raw = await this.request(path);
    const body = raw.body as Json | undefined;
    const storage = (body?.storage as Json | undefined)?.value;
    const version = typeof raw.version === "number" ? raw.version : (raw.version as Json | undefined)?.number;
    const space = raw.space as Json | undefined;
    const spaceKey = typeof space?.key === "string" ? space.key : undefined;
    const spaceId = typeof space?.id === "string" || typeof space?.id === "number" ? String(space.id) : undefined;
    const ancestors = Array.isArray(raw.ancestors) ? raw.ancestors as Json[] : [];
    const parent = ancestors.at(-1);
    const parentId = typeof parent?.id === "string" || typeof parent?.id === "number" ? String(parent.id) : undefined;
    if (typeof raw.id !== "string" || typeof raw.title !== "string" || typeof storage !== "string" || typeof version !== "number") throw new SafeError("UPSTREAM_UNAVAILABLE", "Confluence returned an unsupported page representation");
    if (Buffer.byteLength(storage) > this.config.maxContentBytes) throw new SafeError("CONTENT_TOO_LARGE", "Page exceeds CONFLUENCE_MAX_CONTENT_BYTES");
    this.enforceSpace(spaceKey);
    return { id: raw.id, title: raw.title, ...(spaceId ? { spaceId } : {}), ...(spaceKey ? { spaceKey } : {}), ...(parentId ? { parentId } : {}), version, storage };
  }

  async listTemplates(spaceKey: string | undefined, limit: number): Promise<ContentTemplateSummary[]> {
    if (spaceKey) this.enforceSpace(spaceKey);
    const bounded = Math.min(limit, this.config.maxResults);
    const prefix = this.config.deployment === "cloud" ? "/wiki" : "";
    const query = new URLSearchParams({ start: "0", limit: String(bounded) });
    if (spaceKey) query.set("spaceKey", spaceKey);
    const data = await this.request(`${prefix}/rest/api/template/page?${query}`);
    const items = (Array.isArray(data.results) ? data.results : []) as Json[];
    return items.flatMap((item) => {
      const id = typeof item.templateId === "string" || typeof item.templateId === "number" ? String(item.templateId) : undefined;
      const space = item.space as Json | undefined;
      const key = typeof space?.key === "string" ? space.key : undefined;
      if (!id || typeof item.name !== "string") return [];
      if (key && this.config.allowedSpaces !== "*" && !this.config.allowedSpaces.has(key.toUpperCase())) return [];
      return [{ templateId: id, name: item.name, ...(typeof item.description === "string" ? { description: item.description } : {}), ...(key ? { spaceKey: key } : {}) }];
    });
  }

  async template(templateId: string): Promise<ContentTemplate> {
    const prefix = this.config.deployment === "cloud" ? "/wiki" : "";
    const raw = await this.request(`${prefix}/rest/api/template/${encodeURIComponent(templateId)}`);
    const id = typeof raw.templateId === "string" || typeof raw.templateId === "number" ? String(raw.templateId) : undefined;
    const body = raw.body as Json | undefined;
    const storage = (body?.storage as Json | undefined)?.value;
    const space = raw.space as Json | undefined;
    const spaceKey = typeof space?.key === "string" ? space.key : undefined;
    if (id !== templateId || typeof raw.name !== "string" || typeof storage !== "string") throw new SafeError("UPSTREAM_UNAVAILABLE", "Confluence returned an unsupported content-template representation");
    if (Buffer.byteLength(storage) > this.config.maxContentBytes) throw new SafeError("CONTENT_TOO_LARGE", "Template exceeds CONFLUENCE_MAX_CONTENT_BYTES");
    this.enforceSpace(spaceKey);
    return { templateId: id, name: raw.name, ...(typeof raw.description === "string" ? { description: raw.description } : {}), ...(spaceKey ? { spaceKey } : {}), bodyStorage: storage };
  }

  async titleExists(spaceKey: string, title: string): Promise<boolean> {
    this.enforceSpace(spaceKey);
    const prefix = this.config.deployment === "cloud" ? "/wiki" : "";
    const data = await this.request(`${prefix}/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&type=page&status=current&limit=1`);
    return Array.isArray(data.results) && data.results.length > 0;
  }

  async createPage(space: Space, title: string, bodyStorage: string, parentId?: string): Promise<Page> {
    this.enforceSpace(space.key);
    const path = this.config.deployment === "cloud" ? "/wiki/api/v2/pages" : "/rest/api/content";
    const payload = this.config.deployment === "cloud"
      ? { spaceId: space.id, status: "current", title, ...(parentId ? { parentId } : {}), body: { representation: "storage", value: bodyStorage } }
      : { type: "page", status: "current", title, space: { key: space.key }, ...(parentId ? { ancestors: [{ id: parentId }] } : {}), body: { storage: { representation: "storage", value: bodyStorage } } };
    const created = await this.request(path, { method: "POST", body: JSON.stringify(payload) });
    if (typeof created.id !== "string" && typeof created.id !== "number") throw new SafeError("UPSTREAM_UNAVAILABLE", "Confluence create response omitted the new page ID");
    return this.page(String(created.id));
  }
  async updatePage(page: Page, newStorage: string, message: string): Promise<Page> {
    this.enforceSpace(page.spaceKey);
    const path = this.config.deployment === "cloud" ? `/wiki/api/v2/pages/${encodeURIComponent(page.id)}` : `/rest/api/content/${encodeURIComponent(page.id)}`;
    const payload = this.config.deployment === "cloud"
      ? { id: page.id, status: "current", title: page.title, body: { representation: "storage", value: newStorage }, version: { number: page.version + 1, message } }
      : { id: page.id, type: "page", title: page.title, body: { storage: { representation: "storage", value: newStorage } }, version: { number: page.version + 1, message } };
    await this.request(path, { method: "PUT", body: JSON.stringify(payload) });
    return this.page(page.id);
  }
}
