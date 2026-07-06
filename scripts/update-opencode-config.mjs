import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} from "jsonc-parser";

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonc(text, label) {
  const errors = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const details = errors.map((entry) => {
      const before = text.slice(0, entry.offset);
      const line = before.split(/\r?\n/).length;
      const lastBreak = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
      const column = entry.offset - lastBreak;
      return `${printParseErrorCode(entry.error)} at line ${line}, column ${column}`;
    });
    fail(`${label} is not valid JSON/JSONC: ${details.join("; ")}`);
  }

  if (!isObject(value)) {
    fail(`${label} must contain a JSON object at the top level.`);
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formattingFor(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.match(/^(\s+)(?="[^"\r\n]+"\s*:)/m)?.[1] ?? "  ";
  return indent.includes("\t")
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: Math.max(1, indent.length), eol };
}

function setValue(text, jsonPath, value, formattingOptions) {
  return applyEdits(
    text,
    modify(text, jsonPath, value, { formattingOptions }),
  );
}

function validateShape(config, label) {
  if (config.mcp !== undefined && !isObject(config.mcp)) {
    fail(`${label} has a non-object "mcp" value; refusing to overwrite it.`);
  }
  if (config.permission !== undefined && !isObject(config.permission)) {
    fail(`${label} has a non-object "permission" value; refusing to overwrite it.`);
  }
}

function buildUpdatedText(rawText, update, configPath) {
  let text = rawText.replace(/^\uFEFF/, "");
  if (text.trim() === "") text = "{}\n";

  let config = parseJsonc(text, configPath);
  validateShape(config, configPath);

  if (!isObject(update) || typeof update.serverName !== "string") {
    fail("The installer update payload is invalid.");
  }
  if (!isObject(update.serverConfig) || !isObject(update.permissions)) {
    fail("The installer update payload must contain serverConfig and permissions objects.");
  }

  const formattingOptions = formattingFor(text);
  if (config.$schema === undefined) {
    text = setValue(text, ["$schema"], "https://opencode.ai/config.json", formattingOptions);
    config = parseJsonc(text, configPath);
  }

  if (config.mcp === undefined) {
    text = setValue(text, ["mcp"], { [update.serverName]: update.serverConfig }, formattingOptions);
  } else if (!equal(config.mcp[update.serverName], update.serverConfig)) {
    text = setValue(text, ["mcp", update.serverName], update.serverConfig, formattingOptions);
  }

  config = parseJsonc(text, configPath);
  if (config.permission === undefined) {
    text = setValue(text, ["permission"], update.permissions, formattingOptions);
  } else {
    const expectedKeys = Object.keys(update.permissions);
    const installedKeys = Object.keys(config.permission).filter((key) => expectedKeys.includes(key));
    const correctValues = expectedKeys.every(
      (key) => config.permission[key] === update.permissions[key],
    );
    const correctOrder = equal(installedKeys, expectedKeys);

    if (!correctValues || !correctOrder) {
      for (const key of expectedKeys) {
        if (Object.hasOwn(config.permission, key)) {
          text = setValue(text, ["permission", key], undefined, formattingOptions);
        }
      }
      for (const key of expectedKeys) {
        text = setValue(text, ["permission", key], update.permissions[key], formattingOptions);
      }
    }
  }

  const finalConfig = parseJsonc(text, "generated OpenCode config");
  validateShape(finalConfig, "generated OpenCode config");
  if (!equal(finalConfig.mcp[update.serverName], update.serverConfig)) {
    fail(`Generated config did not contain the expected ${update.serverName} MCP entry.`);
  }

  const expectedKeys = Object.keys(update.permissions);
  const finalKeys = Object.keys(finalConfig.permission).filter((key) => expectedKeys.includes(key));
  if (!equal(finalKeys, expectedKeys)) {
    fail("Generated config did not preserve the required permission-rule order.");
  }
  for (const key of expectedKeys) {
    if (finalConfig.permission[key] !== update.permissions[key]) {
      fail(`Generated config has an unexpected permission for ${key}.`);
    }
  }

  return text.endsWith(formattingOptions.eol) ? text : text + formattingOptions.eol;
}

function writeVerified(configPath, text) {
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true });

  const suffix = `${process.pid}-${Date.now()}`;
  const tempPath = path.join(directory, `.${path.basename(configPath)}.${suffix}.tmp`);
  const rollbackPath = path.join(directory, `.${path.basename(configPath)}.${suffix}.rollback`);
  const existed = fs.existsSync(configPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = existed ? `${configPath}.backup-${timestamp}` : null;

  fs.writeFileSync(tempPath, text, { encoding: "utf8", flag: "wx" });
  parseJsonc(fs.readFileSync(tempPath, "utf8"), "temporary OpenCode config");

  try {
    if (existed) {
      fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
      fs.renameSync(configPath, rollbackPath);
    }
    fs.renameSync(tempPath, configPath);
    parseJsonc(fs.readFileSync(configPath, "utf8"), "written OpenCode config");
    if (existed) fs.rmSync(rollbackPath, { force: true });
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    if (fs.existsSync(rollbackPath) && !fs.existsSync(configPath)) {
      fs.renameSync(rollbackPath, configPath);
    }
    throw error;
  }

  return backupPath;
}

const [configArgument, updateArgument, mode] = process.argv.slice(2);
if (!configArgument || !updateArgument || (mode && mode !== "--dry-run")) {
  fail("Usage: node update-opencode-config.mjs <config-path> <update-json> [--dry-run]");
}

const configPath = path.resolve(configArgument);
const updatePath = path.resolve(updateArgument);
const existed = fs.existsSync(configPath);
const original = existed ? fs.readFileSync(configPath, "utf8") : "{}\n";
const update = JSON.parse(fs.readFileSync(updatePath, "utf8"));
const next = buildUpdatedText(original, update, configPath);

if (mode === "--dry-run") {
  console.log(`Validated OpenCode config update: ${configPath}`);
} else if (next === original.replace(/^\uFEFF/, "")) {
  console.log(`OpenCode config already up to date: ${configPath}`);
} else {
  const backupPath = writeVerified(configPath, next);
  console.log(`Updated OpenCode config: ${configPath}`);
  if (backupPath) console.log(`Backup of previous config: ${backupPath}`);
}
