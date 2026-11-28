import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import ts from "typescript-legacy";

export const NEEDS_RUN_SKIP_EXIT_CODE = 10;

export const DEFAULT_SOURCE_DIRS = [
  "apps/web/src",
  "apps/mobile/src",
  "apps/desktop/src",
  "packages/client-runtime/src",
  "packages/shared/src",
];
export const DEFAULT_LOCALES_DIR = "packages/client-runtime/src/i18n/locales";
export const DEFAULT_GLOSSARY_PATH = ".agents/skills/translate-ui/glossary.md";

const USAGE =
  "Usage: node scripts/i18n-diff-gate.mjs [--needs-run] [--cwd <dir>] [--locales-dir <dir>] [--source-dir <dir>...] [--source-locale <file>] [--glossary <file>]";

const PLACEHOLDER = /\{(\w+)\}/g;
const LETTER_RUN = /\p{L}{2,}/gu;
// Paths, URLs, and kebab or dotted identifiers stay in English.
const CODE_TOKEN = /\/|^[\p{Ll}\d]+(?:[-_.][\p{Ll}\d]+)+$/u;
const SAMPLE_LIMIT = 25;

export function parseI18nGateArgs(argv) {
  let parsed;
  try {
    parsed = NodeUtil.parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "needs-run": { type: "boolean", default: false },
        cwd: { type: "string" },
        "locales-dir": { type: "string" },
        "source-dir": { type: "string", multiple: true },
        "source-locale": { type: "string" },
        glossary: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`, {
      cause: error,
    });
  }

  const values = parsed.values;
  if (values.help) return { help: true };

  return {
    help: false,
    needsRun: values["needs-run"],
    cwd: values.cwd ? NodePath.resolve(values.cwd) : process.cwd(),
    localesDir: values["locales-dir"] ?? DEFAULT_LOCALES_DIR,
    sourceDirs: values["source-dir"]?.length ? values["source-dir"] : DEFAULT_SOURCE_DIRS,
    sourceLocale: values["source-locale"] ?? null,
    glossaryPath: values.glossary ?? DEFAULT_GLOSSARY_PATH,
  };
}

function listSourceFiles(dir) {
  if (!NodeFS.existsSync(dir)) return [];
  const files = [];
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "locales") {
        files.push(...listSourceFiles(fullPath));
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|bench)\.tsx?$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function literalText(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return literalText(node.expression);
  }
  return undefined;
}

function literalTexts(node) {
  if (!node) return [];
  if (ts.isParenthesizedExpression(node)) return literalTexts(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...literalTexts(node.whenTrue), ...literalTexts(node.whenFalse)];
  }
  const text = literalText(node);
  return text === undefined ? [] : [text];
}

export function collectSourceMessages(root, sourceDirs = DEFAULT_SOURCE_DIRS) {
  const messages = new Map();
  const add = (key, file, plural, one) => {
    const existing = messages.get(key);
    if (existing) {
      existing.files.add(file);
    } else {
      messages.set(key, {
        plural,
        ...(one === undefined ? {} : { one }),
        files: new Set([file]),
      });
    }
  };

  for (const dir of sourceDirs) {
    const absDir = NodePath.isAbsolute(dir) ? dir : NodePath.join(root, dir);
    for (const filePath of listSourceFiles(absDir)) {
      const text = NodeFS.readFileSync(filePath, "utf8");
      if (!/\b(?:t|tx|tn|msg)\(/.test(text)) continue;
      const relFile = NodePath.relative(root, filePath).replaceAll("\\", "/");
      const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, false);
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const name = node.expression.text;
          if (name === "t" || name === "tx" || name === "msg") {
            for (const key of literalTexts(node.arguments[0])) {
              add(key, relFile, false);
            }
          } else if (name === "tn") {
            const one = literalText(node.arguments[1]);
            const other = literalText(node.arguments[2]);
            if (one !== undefined && other !== undefined) {
              add(other, relFile, true, one);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return messages;
}

function propertyNameText(nameNode) {
  if (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode)) {
    return nameNode.text;
  }
  if (ts.isIdentifier(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  return null;
}

function extractObjectLiteral(expr) {
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  ) {
    return extractObjectLiteral(expr.expression);
  }
  return ts.isObjectLiteralExpression(expr) ? expr : null;
}

function readCatalogObjectNode(objectNode, filePath) {
  const catalog = Object.create(null);
  for (const prop of objectNode.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      throw new Error(`Unsupported catalog property syntax in ${filePath}.`);
    }
    const key = propertyNameText(prop.name);
    if (key === null) {
      throw new Error(`Unsupported catalog key in ${filePath}.`);
    }
    const stringVal = literalText(prop.initializer);
    if (stringVal !== undefined) {
      catalog[key] = stringVal;
      continue;
    }
    const nested = extractObjectLiteral(prop.initializer);
    if (nested) {
      const forms = Object.create(null);
      for (const nestedProp of nested.properties) {
        if (!ts.isPropertyAssignment(nestedProp)) {
          throw new Error(
            `Unsupported plural form syntax for ${JSON.stringify(key)} in ${filePath}.`,
          );
        }
        const formKey = propertyNameText(nestedProp.name);
        const formVal = literalText(nestedProp.initializer);
        if (formKey === null || formVal === undefined) {
          throw new Error(`Unsupported plural entry for ${JSON.stringify(key)} in ${filePath}.`);
        }
        forms[formKey] = formVal;
      }
      catalog[key] = forms;
      continue;
    }
    throw new Error(`Unsupported catalog value for ${JSON.stringify(key)} in ${filePath}.`);
  }
  return catalog;
}

export function readLocaleCatalog(filePath) {
  const text = NodeFS.readFileSync(filePath, "utf8");
  if (filePath.endsWith(".json")) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Locale JSON ${filePath} must be an object.`);
    }
    return parsed;
  }
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, false);
  let objectNode = null;
  const visit = (node) => {
    if (objectNode) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "catalog" &&
      node.initializer
    ) {
      objectNode = extractObjectLiteral(node.initializer);
      if (objectNode) return;
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      objectNode = extractObjectLiteral(node.expression);
      if (objectNode) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!objectNode) {
    throw new Error(`Could not find a catalog object literal in ${filePath}.`);
  }
  return readCatalogObjectNode(objectNode, filePath);
}

function messagesFromSourceLocale(filePath, root) {
  const catalog = readLocaleCatalog(filePath);
  const relFile = NodePath.relative(root, filePath).replaceAll("\\", "/");
  const messages = new Map();
  for (const [key, entry] of Object.entries(catalog)) {
    const plural = typeof entry !== "string";
    messages.set(key, {
      plural,
      ...(plural && typeof entry?.one === "string" ? { one: entry.one } : {}),
      files: new Set([relFile]),
    });
  }
  return messages;
}

function placeholders(text) {
  return new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ""));
}

function entryProblems(key, message, entry) {
  const problems = [];
  if (message.plural && typeof entry === "string") problems.push("plural message needs forms");
  if (!message.plural && typeof entry !== "string") problems.push("message is not plural");
  const other = placeholders(key);
  const one = placeholders(message.one ?? key);
  const allowed = new Set([...other, ...one]);
  const required = [...other].filter(
    (name) => one.has(name) && !(message.plural && name === "count"),
  );
  const texts =
    typeof entry === "string"
      ? [entry]
      : Object.values(entry).filter((value) => typeof value === "string");
  for (const text of texts) {
    const found = placeholders(text);
    const extra = [...found].filter((name) => !allowed.has(name));
    const dropped = required.filter((name) => !found.has(name));
    if (extra.length > 0 || dropped.length > 0) {
      problems.push(`placeholders differ from source in ${JSON.stringify(text)}`);
    }
  }
  return problems;
}

function readKeptEnglishWords(glossaryFile) {
  if (!glossaryFile || !NodeFS.existsSync(glossaryFile)) return new Set();
  const glossary = NodeFS.readFileSync(glossaryFile, "utf8");
  const section = glossary.split("## Keep in English")[1]?.split("\n## ")[0] ?? "";
  const items = section
    .split("\n- ")
    .slice(1)
    .map((item) => item.slice(item.indexOf(":") + 1));
  return new Set(items.join(" ").toLowerCase().match(LETTER_RUN) ?? []);
}

function untranslatedWords(key, kept) {
  return key
    .replace(PLACEHOLDER, " ")
    .split(/\s+/)
    .filter((token) => !CODE_TOKEN.test(token))
    .flatMap((token) => token.match(LETTER_RUN) ?? [])
    .filter((word) => !kept.has(word.toLowerCase()));
}

function pluralCategoriesForLocale(locale) {
  try {
    return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    return ["other"];
  }
}

export function checkI18nParity({
  cwd = process.cwd(),
  localesDir = DEFAULT_LOCALES_DIR,
  sourceDirs = DEFAULT_SOURCE_DIRS,
  sourceLocale = null,
  glossaryPath = DEFAULT_GLOSSARY_PATH,
} = {}) {
  const absLocalesDir = NodePath.isAbsolute(localesDir)
    ? localesDir
    : NodePath.join(cwd, localesDir);
  if (!NodeFS.existsSync(absLocalesDir)) {
    return {
      ok: false,
      needs_run: false,
      error: `Locales directory not found: ${absLocalesDir}`,
    };
  }

  const absSourceLocale = sourceLocale
    ? NodePath.isAbsolute(sourceLocale)
      ? sourceLocale
      : NodePath.join(cwd, sourceLocale)
    : null;
  const absGlossary = glossaryPath
    ? NodePath.isAbsolute(glossaryPath)
      ? glossaryPath
      : NodePath.join(cwd, glossaryPath)
    : null;

  const messages = absSourceLocale
    ? messagesFromSourceLocale(absSourceLocale, cwd)
    : collectSourceMessages(cwd, sourceDirs);
  const kept = readKeptEnglishWords(absGlossary);

  const localeFiles = NodeFS.readdirSync(absLocalesDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(?:ts|json)$/.test(entry.name) &&
        !/\.(?:test|spec)\.(?:ts|json)$/.test(entry.name),
    )
    .map((entry) => NodePath.join(absLocalesDir, entry.name))
    .filter(
      (filePath) =>
        !absSourceLocale || NodePath.resolve(filePath) !== NodePath.resolve(absSourceLocale),
    )
    .toSorted();

  if (localeFiles.length === 0) {
    return {
      ok: false,
      needs_run: false,
      error: `No target locale files found in ${absLocalesDir}`,
    };
  }

  const localeReports = [];
  let totalMissing = 0;
  let totalStale = 0;
  let totalBroken = 0;

  for (const filePath of localeFiles) {
    const locale = NodePath.basename(filePath).replace(/\.(?:ts|json)$/, "");
    const catalog = readLocaleCatalog(filePath);
    const catalogKeys = Object.keys(catalog);

    const missing = [];
    for (const [key, message] of messages) {
      if (!Object.hasOwn(catalog, key)) {
        missing.push({ key, file: [...message.files][0] ?? null });
      }
    }

    const stale = catalogKeys.filter((key) => !messages.has(key));
    const categories = pluralCategoriesForLocale(locale);
    const broken = [];
    for (const [key, message] of messages) {
      if (!Object.hasOwn(catalog, key)) continue;
      const entry = catalog[key];
      const problems = entryProblems(key, message, entry);
      if (typeof entry !== "string") {
        const absent = categories.filter((category) => entry[category] === undefined);
        if (absent.length > 0) problems.push(`plural forms missing: ${absent.join(", ")}`);
      } else if (entry === key) {
        const words = untranslatedWords(key, kept);
        if (words.length > 0) {
          problems.push(`identical to English (${words.slice(0, 5).join(", ")})`);
        }
      }
      for (const problem of problems) {
        broken.push({ key, problem });
      }
    }

    totalMissing += missing.length;
    totalStale += stale.length;
    totalBroken += broken.length;

    localeReports.push({
      locale,
      file: NodePath.relative(cwd, filePath).replaceAll("\\", "/"),
      total_keys: catalogKeys.length,
      missing_keys: missing.length,
      stale_keys: stale.length,
      broken_keys: broken.length,
      missing: missing.slice(0, SAMPLE_LIMIT),
      stale: stale.slice(0, SAMPLE_LIMIT),
      broken: broken.slice(0, SAMPLE_LIMIT),
    });
  }

  const hasDrift = totalMissing > 0 || totalStale > 0 || totalBroken > 0;
  const localeNames = localeReports.map((entry) => entry.locale).join(", ");
  const driftedLocales = localeReports
    .filter((entry) => entry.missing_keys > 0 || entry.stale_keys > 0 || entry.broken_keys > 0)
    .map(
      (entry) =>
        `${entry.locale}: ${entry.missing_keys} missing, ${entry.stale_keys} stale, ${entry.broken_keys} broken`,
    )
    .join("; ");

  return {
    ok: true,
    needs_run: hasDrift,
    reason: hasDrift
      ? `i18n parity drift detected (${driftedLocales}).`
      : `i18n parity clean (${messages.size} source keys across ${localeNames}; 0 missing, 0 stale, 0 broken).`,
    source_keys: messages.size,
    missing_keys: totalMissing,
    stale_keys: totalStale,
    broken_keys: totalBroken,
    locales: localeReports,
  };
}

export function exitCodeForI18nGate(result, needsRun) {
  if (!result.ok) return 1;
  if (!needsRun) return result.needs_run ? 1 : 0;
  return result.needs_run ? 0 : NEEDS_RUN_SKIP_EXIT_CODE;
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseI18nGateArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      process.exit(0);
    }
    const result = checkI18nParity(options);
    console.log(JSON.stringify(result));
    process.exit(exitCodeForI18nGate(result, options.needsRun));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
