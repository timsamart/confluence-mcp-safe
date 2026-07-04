import { SyntaxValidator } from "fast-xml-validator";
import { digest, SafeError } from "./core.js";

export type Section = {
  id: string;
  level: number;
  heading: string;
  hash: string;
  storage: string;
  start: number;
  bodyStart: number;
  end: number;
};

export type SectionReplacement = {
  storage: string;
  section: Section;
  preservation: {
    unchangedPrefixHash: string;
    unchangedSuffixHash: string;
    replacementBodyHash: string;
    resultingStorageHash: string;
  };
};

export function validateStorageFragment(storage: string, parentLevel?: number): void {
  if (/<!DOCTYPE|<!ENTITY|<script\b|<iframe\b|<object\b|<embed\b|\son[a-z]+\s*=/i.test(storage)) {
    throw new SafeError("INVALID_INPUT", "Replacement storage contains active or unsafe markup");
  }
  if (/<ac:(?:structured-)?macro\b(?=[^>]*\bac:name\s*=\s*["'](?:html|html-include)["'])/i.test(storage)) {
    throw new SafeError("INVALID_INPUT", "Replacement storage contains a prohibited active HTML macro");
  }
  if (parentLevel !== undefined) {
    for (const match of storage.matchAll(/<h([1-6])(?:\s[^>]*)?>/gi)) {
      if (Number(match[1]) <= parentLevel) {
        throw new SafeError("INVALID_INPUT", `Replacement body cannot introduce an h${match[1]} boundary at or above its h${parentLevel} section`);
      }
    }
  }

  // Validate as an XML fragment without rewriting it. Confluence storage uses
  // namespace prefixes and can contain multiple top-level XHTML elements.
  const validationOnly = storage.replaceAll("&nbsp;", "&#160;");
  const wrapped = `<safe-root xmlns:ac="urn:atlassian:confluence:ac" xmlns:ri="urn:atlassian:confluence:ri" xmlns:at="urn:atlassian:template" xmlns:atlassian="urn:atlassian">${validationOnly}</safe-root>`;
  let result: ReturnType<typeof SyntaxValidator.validate>;
  try {
    result = SyntaxValidator.validate(wrapped, { allowBooleanAttributes: false });
  } catch {
    throw new SafeError("INVALID_INPUT", "Replacement storage is not well-formed XHTML");
  }
  if (result !== true) {
    throw new SafeError("INVALID_INPUT", `Replacement storage is not well-formed XHTML (line ${result.err.line}, column ${result.err.col})`);
  }
}

export type TemplateVariable = { name: string; type: "string" | "textarea" | "list"; options?: string[] };

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name.replace(":", "\\:")}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2];
}

function escapeText(value: string, multiline: boolean): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  return multiline ? escaped.replace(/\r\n|\r|\n/g, "<br />") : escaped;
}

export function inspectTemplateStorage(templateStorage: string): { variables: TemplateVariable[] } {
  validateStorageFragment(templateStorage);
  const declarations = templateStorage.match(/<at:declarations\b[^>]*>([\s\S]*?)<\/at:declarations\s*>/i);
  const variables: TemplateVariable[] = [];
  if (declarations) {
    const declarationPattern = /<at:(string|textarea|list)\b[^>]*(?:\/>|>[\s\S]*?<\/at:\1\s*>)/gi;
    for (const match of (declarations[1] ?? "").matchAll(declarationPattern)) {
      const type = (match[1] ?? "").toLowerCase() as TemplateVariable["type"];
      const name = attribute(match[0], "at:name");
      if (!name) throw new SafeError("INVALID_INPUT", "Confluence template contains a declaration without at:name");
      if (variables.some((item) => item.name === name)) throw new SafeError("INVALID_INPUT", `Confluence template declares variable ${name} more than once`);
      const options = type === "list"
        ? [...match[0].matchAll(/<at:option\b[^>]*\bat:value\s*=\s*(["'])(.*?)\1[^>]*\/?\s*>/gi)].map((item) => item[2]).filter((item): item is string => item !== undefined)
        : undefined;
      variables.push({ name, type, ...(options ? { options } : {}) });
    }
  }
  return { variables };
}

/** Resolve only declared Confluence template variables as plain text, never as raw storage XHTML. */
export function resolveTemplateStorage(templateStorage: string, values: Record<string, string>): { storage: string; variables: TemplateVariable[] } {
  const { variables } = inspectTemplateStorage(templateStorage);
  const declarations = templateStorage.match(/<at:declarations\b[^>]*>([\s\S]*?)<\/at:declarations\s*>/i);
  const declared = new Map(variables.map((item) => [item.name, item]));
  const supplied = Object.keys(values);
  const missing = variables.filter((item) => !Object.hasOwn(values, item.name)).map((item) => item.name);
  const extra = supplied.filter((name) => !declared.has(name));
  if (missing.length) throw new SafeError("INVALID_INPUT", `Missing Confluence template variables: ${missing.join(", ")}`);
  if (extra.length) throw new SafeError("INVALID_INPUT", `Unknown Confluence template variables: ${extra.join(", ")}`);
  for (const variable of variables) {
    if (variable.type === "list" && variable.options && !variable.options.includes(values[variable.name] ?? "")) {
      throw new SafeError("INVALID_INPUT", `Value for template variable ${variable.name} is not one of its declared options`);
    }
  }
  let storage = declarations ? templateStorage.replace(declarations[0], "") : templateStorage;
  storage = storage.replace(/<at:var\b[^>]*\bat:name\s*=\s*(["'])(.*?)\1[^>]*(?:\/>|>\s*<\/at:var\s*>)/gi, (tag, _quote: string, name: string) => {
    const variable = declared.get(name);
    if (!variable) throw new SafeError("INVALID_INPUT", `Template references undeclared variable ${name}`);
    return escapeText(values[name] ?? "", variable.type === "textarea");
  });
  if (/<at:var\b/i.test(storage)) throw new SafeError("INVALID_INPUT", "Template contains an unsupported or unresolved at:var element");
  validateStorageFragment(storage);
  return { storage, variables };
}

function plainText(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

export function sectionsFromStorage(storage: string): Section[] {
  const matches = [...storage.matchAll(/<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi)];
  const occurrences = new Map<string, number>();
  return matches.map((match, index) => {
    const heading = plainText(match[2] ?? "");
    const normalized = heading.toLocaleLowerCase().normalize("NFKC");
    const occurrence = (occurrences.get(normalized) ?? 0) + 1;
    occurrences.set(normalized, occurrence);
    const start = match.index ?? 0;
    const bodyStart = start + match[0].length;
    const level = Number(match[1]);
    let end = storage.length;
    for (const following of matches.slice(index + 1)) {
      if (Number(following[1]) <= level) { end = following.index ?? storage.length; break; }
    }
    const fragment = storage.slice(start, end);
    return { id: `sec_${digest({ normalized, occurrence }).slice(7, 23)}`, level, heading, hash: digest(fragment), storage: fragment, start, bodyStart, end };
  });
}

export function publicSection(section: Section): Omit<Section, "storage" | "start" | "bodyStart" | "end"> {
  return { id: section.id, level: section.level, heading: section.heading, hash: section.hash };
}

export function replaceSection(storage: string, sectionId: string, expectedHash: string, replacementBody: string): SectionReplacement {
  const section = sectionsFromStorage(storage).find((item) => item.id === sectionId);
  if (!section) throw new SafeError("AMBIGUOUS_LOCATOR", "Section ID is not present in the current page version");
  if (section.hash !== expectedHash) throw new SafeError("VERSION_CONFLICT", "Section changed; fetch the current outline and create a new proposal");
  validateStorageFragment(replacementBody, section.level);

  const unchangedPrefix = storage.slice(0, section.bodyStart);
  const unchangedSuffix = storage.slice(section.end);
  const result = `${unchangedPrefix}${replacementBody}${unchangedSuffix}`;
  return {
    storage: result,
    section,
    preservation: {
      unchangedPrefixHash: digest(unchangedPrefix),
      unchangedSuffixHash: digest(unchangedSuffix),
      replacementBodyHash: digest(replacementBody),
      resultingStorageHash: digest(result)
    }
  };
}
