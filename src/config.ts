import { z } from "zod";

const optionalEmail = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return normalized === "" || normalized === "{env:CONFLUENCE_EMAIL}" ? undefined : normalized;
}, z.string().email().optional());

const schema = z.object({
  CONFLUENCE_BASE_URL: z.string().url(),
  CONFLUENCE_DEPLOYMENT: z.enum(["cloud", "data_center"]),
  CONFLUENCE_TOKEN: z.string().min(1),
  CONFLUENCE_EMAIL: optionalEmail,
  CONFLUENCE_CONNECTION_ID: z.string().min(1).default("default"),
  CONFLUENCE_ALLOWED_SPACES: z.string().min(1),
  CONFLUENCE_MAX_RESULTS: z.coerce.number().int().min(1).max(100).default(50),
  CONFLUENCE_MAX_CONTENT_BYTES: z.coerce.number().int().min(1024).max(2_000_000).default(200_000),
  CONFLUENCE_CHANGESET_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600)
}).superRefine((value, context) => {
  if (value.CONFLUENCE_DEPLOYMENT === "cloud" && !value.CONFLUENCE_EMAIL) {
    context.addIssue({ code: "custom", path: ["CONFLUENCE_EMAIL"], message: "is required for Confluence Cloud" });
  }
});

export type Config = {
  baseUrl: URL;
  deployment: "cloud" | "data_center";
  token: string;
  email?: string;
  connectionId: string;
  allowedSpaces: ReadonlySet<string> | "*";
  maxResults: number;
  maxContentBytes: number;
  changesetTtlMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = schema.parse(env);
  const url = new URL(raw.CONFLUENCE_BASE_URL);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("CONFLUENCE_BASE_URL must use HTTPS (localhost is allowed for tests)");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  const spaces = raw.CONFLUENCE_ALLOWED_SPACES.trim();
  return {
    baseUrl: url,
    deployment: raw.CONFLUENCE_DEPLOYMENT,
    token: raw.CONFLUENCE_TOKEN,
    ...(raw.CONFLUENCE_EMAIL ? { email: raw.CONFLUENCE_EMAIL } : {}),
    connectionId: raw.CONFLUENCE_CONNECTION_ID,
    allowedSpaces: spaces === "*" ? "*" : new Set(spaces.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean)),
    maxResults: raw.CONFLUENCE_MAX_RESULTS,
    maxContentBytes: raw.CONFLUENCE_MAX_CONTENT_BYTES,
    changesetTtlMs: raw.CONFLUENCE_CHANGESET_TTL_SECONDS * 1000
  };
}
