// @effect-diagnostics nodeBuiltinImport:off - oxlint rules run synchronously and read their baseline file once.
import { defineRule, type ESTree } from "@oxlint/plugins";
import * as NodeFS from "node:fs";
import * as Option from "effect/Option";

import { getPropertyName, resolveConstValue, unwrapExpression } from "../utils.ts";

const TOAST_MANAGERS = new Set(["toastManager", "anchoredToastManager"]);

type Grandfathered = Readonly<Record<string, number>>;

let baseline: Grandfathered | undefined;
const loadBaseline = (): Grandfathered =>
  (baseline ??= JSON.parse(
    NodeFS.readFileSync(new URL("./require-toast-source.baseline.json", import.meta.url), "utf8"),
  ) as Grandfathered);

const readGrandfathered = (options: ReadonlyArray<unknown>): Grandfathered => {
  const [first] = options;
  if (typeof first === "object" && first !== null && "grandfathered" in first) {
    return first.grandfathered as Grandfathered;
  }
  return loadBaseline();
};

/** Files are keyed by their repository path, matched as a suffix so the rule works from any cwd. */
const allowanceFor = (grandfathered: Grandfathered, filename: string): number => {
  const normalized = filename.replaceAll("\\", "/");
  for (const [path, count] of Object.entries(grandfathered)) {
    if (normalized === path || normalized.endsWith(`/${path}`)) return count;
  }
  return 0;
};

type SourceCode = Parameters<typeof resolveConstValue>[0];

/** The object literal a value is, through consts and a wrapper call's first argument. */
function objectLiteralOf(
  sourceCode: SourceCode,
  node: unknown,
  depth = 0,
): ESTree.ObjectExpression | undefined {
  if (depth > 4) return undefined;
  const value = Option.getOrUndefined(unwrapExpression(node)) as ESTree.Node | undefined;
  if (value === undefined) return undefined;
  if (value.type === "ObjectExpression") return value;
  if (value.type === "Identifier") {
    return objectLiteralOf(
      sourceCode,
      Option.getOrUndefined(resolveConstValue(sourceCode, value)),
      depth + 1,
    );
  }
  if (value.type === "CallExpression") {
    return objectLiteralOf(sourceCode, value.arguments[0], depth + 1);
  }
  return undefined;
}

const propertyNamed = (object: ESTree.ObjectExpression, name: string) =>
  object.properties.find(
    (property): property is ESTree.ObjectProperty =>
      property.type === "Property" && Option.contains(getPropertyName(property.key), name),
  );

/** Only `data: { source }` on the options themselves counts; a `source` elsewhere is not a tag. */
function hasDataSource(sourceCode: SourceCode, argument: unknown): boolean {
  const options = objectLiteralOf(sourceCode, argument);
  const data = options === undefined ? undefined : propertyNamed(options, "data");
  const dataObject = data === undefined ? undefined : objectLiteralOf(sourceCode, data.value);
  return dataObject !== undefined && propertyNamed(dataObject, "source") !== undefined;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a data.source tag on toastManager.add so Settings > Diagnostics can name the emitters.",
    },
    schema: [
      {
        type: "object",
        properties: {
          grandfathered: {
            type: "object",
            description:
              "Untagged calls allowed per repository path; defaults to require-toast-source.baseline.json.",
            additionalProperties: { type: "number" },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const { sourceCode } = context;
    const untagged: ESTree.Node[] = [];
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return;
        if (!TOAST_MANAGERS.has(callee.object.name)) return;
        if (!Option.contains(getPropertyName(callee.property), "add")) return;
        if (!hasDataSource(sourceCode, node.arguments[0])) untagged.push(node);
      },
      "Program:exit"() {
        const allowed = allowanceFor(readGrandfathered(context.options), context.filename);
        if (untagged.length <= allowed) return;
        for (const node of untagged) {
          context.report({
            node,
            message: `Tag this toast with data.source (a NoticeSource from components/ui/toastNoticeLog). This file has ${untagged.length} untagged toasts; require-toast-source.baseline.json allows ${allowed}. After tagging or removing toasts, or an upstream sync, run node scripts/toast-source-baseline.ts.`,
          });
        }
      },
    };
  },
});
