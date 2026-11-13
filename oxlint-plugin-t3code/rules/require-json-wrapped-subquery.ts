import { defineRule } from "@oxlint/plugins";

const MESSAGE =
  "From SQLite 3.54.1 a subquery's result loses its JSON type, so this JSON function stores it " +
  "as a quoted string. Wrap JSON in json((SELECT ...)). A text or number result is safe: " +
  "suppress with that reason.";

const JSON_BUILDER =
  /\bjson_(?:set|insert|replace|object|array|patch|group_array|group_object)\s*\(/giu;
const BARE_SUBQUERY = /^\(\s*select\b/iu;

/** The top-level arguments of the call whose parenthesis opens at `open`, skipping SQL strings. */
const argumentsAt = (text: string, open: number): ReadonlyArray<string> => {
  const args: Array<string> = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      index = text.indexOf("'", index + 1);
      if (index === -1) break;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        args.push(text.slice(start, index));
        break;
      }
    } else if (char === "," && depth === 1) {
      args.push(text.slice(start, index));
      start = index + 1;
    }
  }
  return args;
};

const hasBareJsonSubquery = (text: string) =>
  [...text.matchAll(JSON_BUILDER)].some((match) =>
    argumentsAt(text, match.index + match[0].length - 1).some((arg) =>
      BARE_SUBQUERY.test(arg.trim()),
    ),
  );

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require json() around a subquery passed to a SQLite JSON function.",
    },
  },
  create(context) {
    return {
      TaggedTemplateExpression(node) {
        if (node.tag.type !== "Identifier" || node.tag.name !== "sql") return;
        const text = node.quasi.quasis.map((quasi) => quasi.value.raw).join("?");
        if (hasBareJsonSubquery(text)) context.report({ node: node.quasi, message: MESSAGE });
      },
    };
  },
});
