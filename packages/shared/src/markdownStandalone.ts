import type { Definition, Nodes, Parents, Root, RootContent, Table } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { type InlineMath, type Math as MathNode, mathToMarkdown } from "mdast-util-math";
import { type Handle, type Options, toMarkdown } from "mdast-util-to-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** Markdown for one part of a document, and what ends it when the next part would continue it. */
export interface MarkdownBlock {
  readonly text: string;
  readonly barrier: string;
}

const gfmReader = unified().use(remarkParse).use(remarkGfm).freeze();
const mathReader = gfmReader().use(remarkMath, { singleDollarTextMath: true }).freeze();

// The app's math syntax (`$`, `$$`, `\(`, `\[`) starts with one of these.
const MATH_START = /[$\\]/u;

// The parser, the serializer and the comparisons here recurse once per level of nesting.
const MAX_DEPTH = 100;

function withinDepth(root: Root): boolean {
  const pending: Array<readonly [Nodes, number]> = [[root, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, depth] = next;
    if (depth > MAX_DEPTH) return false;
    if ("children" in node) for (const child of node.children) pending.push([child, depth + 1]);
  }
  return true;
}

/**
 * The trees a viewer without math and one that reads math as the app does build, or null when
 * the text nests too deep to read or compare.
 */
function readBoth(text: string): readonly [Root, Root] | null {
  let trees: readonly [Root, Root];
  try {
    const plain = gfmReader.parse(text);
    trees = [plain, MATH_START.test(text) ? mathReader.parse(text) : plain];
  } catch (error) {
    // The parser overflows the stack on deep enough nesting.
    if (error instanceof RangeError) return null;
    throw error;
  }
  return trees.every(withinDepth) ? trees : null;
}

const MATH_OPTIONS = { singleDollarTextMath: true };
const WRITE_OPTIONS: Options = {
  extensions: [gfmToMarkdown(), mathToMarkdown(MATH_OPTIONS)],
};

const DELIMITER_CELLS = { left: ":-", right: "-:", center: ":-:" } as const;

/** A table with every row as long as written: the GFM writer pads each row to the widest. */
const writeTable: Handle = (node: Table, _parent, state, info) => {
  const exit = state.enter("table");
  const rows = node.children.map((row) => {
    const exitRow = state.enter("tableRow");
    const cells = row.children.map((cell) => state.handle(cell, row, state, info));
    exitRow();
    return `| ${cells.join(" | ")} |`;
  });
  exit();
  const delimiters = (node.children[0]?.children ?? []).map((_cell, index) => {
    const align = node.align?.[index];
    return align === null || align === undefined ? "-" : DELIMITER_CELLS[align];
  });
  rows.splice(1, 0, `| ${delimiters.join(" | ")} |`);
  return rows.join("\n");
};

const CONTAINERS: ReadonlySet<Nodes["type"]> = new Set([
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);

const MATH_OPENING = /^(?:\\[([]|\$+)/u;
const MATH_CLOSING = /(?:\\[)\]]|\$+)[ \t]*$/u;

/**
 * Math as authored: the writer's `$` form can read differently from `\(` or `\[` without math.
 * A span that crosses lines inside a container also holds the container's markers, so that math
 * keeps only its delimiters.
 */
function authoredSpan(node: MathNode | InlineMath, span: string, nested: boolean) {
  if (!nested || !span.includes("\n")) return span;
  const opening = MATH_OPENING.exec(span)?.[0];
  const closing = MATH_CLOSING.exec(span)?.[0].trimEnd();
  if (opening === undefined || closing === undefined) return undefined;
  if (node.type === "math") {
    const openingLine = span.slice(0, span.indexOf("\n"));
    // Text after the opening delimiter is the formula's first line.
    const opensWithText = openingLine.slice(opening.length).trim() !== "";
    const body = node.value.split("\n").slice(opensWithText ? 1 : 0);
    return [opensWithText ? openingLine : opening, ...body, closing].join("\n");
  }
  const inner = span.slice(opening.length, span.lastIndexOf(closing));
  const padded = /^[ \n].*[ \n]$/su.test(inner) && /[^ \n]/u.test(inner);
  return padded
    ? `${opening}${inner[0]}${node.value}${inner.at(-1)}${closing}`
    : `${opening}${node.value}${closing}`;
}

function authoredMath(root: Root, source: string): Options {
  const spans = new Map<Nodes, string>();
  const pending: Array<readonly [Nodes, boolean]> = [[root, false]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, nested] = next;
    if (node.type === "math" || node.type === "inlineMath") {
      const { start, end } = node.position!;
      const span = authoredSpan(node, source.slice(start.offset, end.offset), nested);
      if (span !== undefined) spans.set(node, span);
    }
    if ("children" in node) {
      const inContainer = nested || CONTAINERS.has(node.type);
      for (const child of node.children) pending.push([child, inContainer]);
    }
  }
  const { math, inlineMath } = mathToMarkdown(MATH_OPTIONS).handlers!;
  const authored = (written: Handle) => {
    const handle: Handle = (node: MathNode | InlineMath, parent, state, info) =>
      spans.get(node) ?? written(node, parent, state, info);
    return Object.assign(handle, { peek: (node: Nodes) => spans.get(node)?.[0] ?? "$" });
  };
  return { handlers: { math: authored(math!), inlineMath: authored(inlineMath!) } };
}

function rewriteOptions(root: Root, source: string): Options {
  return {
    bullet: "-",
    extensions: [gfmToMarkdown(), mathToMarkdown(MATH_OPTIONS), authoredMath(root, source)],
    handlers: { table: writeTable },
  };
}

type Shape = ReadonlyArray<string>;

function mergedText(children: ReadonlyArray<Nodes>): Nodes[] {
  const merged: Nodes[] = [];
  for (const child of children) {
    const last = merged.at(-1);
    if (child.type === "text" && last?.type === "text") {
      merged[merged.length - 1] = { type: "text", value: last.value + child.value };
    } else {
      merged.push(child);
    }
  }
  return merged;
}

/** A node as it renders: positions, key order and how its text is split do not count. */
function canonical(node: Nodes): unknown {
  return Object.fromEntries(
    Object.keys(node)
      .filter((key) => key !== "position")
      .sort()
      .map((key) => {
        const value: unknown = node[key as keyof Nodes];
        return [key, key === "children" ? mergedText(value as Nodes[]).map(canonical) : value];
      }),
  );
}

const shape = (tree: Root): Shape => tree.children.map((node) => JSON.stringify(canonical(node)));
const shapeBoth = (trees: readonly [Root, Root]): readonly [Shape, Shape] => {
  const plain = shape(trees[0]);
  return [plain, trees[1] === trees[0] ? plain : shape(trees[1])];
};
const sameShape = (left: Shape, right: Shape) =>
  left.length === right.length && left.every((node, index) => node === right[index]);
const sameShapes = (left: readonly [Shape, Shape], right: readonly [Shape, Shape]) =>
  sameShape(left[0], right[0]) && sameShape(left[1], right[1]);

function readShapes(text: string): readonly [Shape, Shape] | null {
  const trees = readBoth(text);
  return trees === null ? null : shapeBoth(trees);
}

const shapes = new WeakMap<MarkdownBlock, readonly [Shape, Shape] | null>();

function shapesOf(block: MarkdownBlock): readonly [Shape, Shape] | null {
  let known = shapes.get(block);
  if (known === undefined) {
    known = readShapes(block.text);
    shapes.set(block, known);
  }
  return known;
}

const FLOW_PARENTS: ReadonlySet<Nodes["type"]> = new Set([
  "root",
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);

/**
 * The tree the message must render as inside a document of other messages, whose definitions
 * and footnotes would otherwise resolve across messages: references become the links their
 * first definition makes, definitions go, footnotes get labels of their own, and raw HTML reads
 * as written (a block as `html` code).
 */
function contained(root: Root, footnoteLabel: (identifier: string) => string): Root {
  const definitions = new Map<string, Definition>();
  const collect = (node: Nodes) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if ("children" in node) node.children.forEach(collect);
  };
  collect(root);

  const map = (node: Nodes, inFlow: boolean): Nodes | null => {
    switch (node.type) {
      case "definition":
        return null;
      case "html":
        return inFlow
          ? { type: "code", lang: "html", meta: null, value: node.value }
          : { type: "text", value: node.value };
      case "linkReference": {
        const { url, title } = definitions.get(node.identifier)!;
        return { type: "link", url, title: title ?? null, children: mapChildren(node) as never };
      }
      case "imageReference": {
        const { url, title } = definitions.get(node.identifier)!;
        return { type: "image", url, title: title ?? null, alt: node.alt ?? null };
      }
      case "footnoteReference": {
        const label = footnoteLabel(node.identifier);
        return { ...node, identifier: label, label };
      }
      case "footnoteDefinition": {
        const label = footnoteLabel(node.identifier);
        return { ...node, identifier: label, label, children: mapChildren(node) as never };
      }
      default:
        return "children" in node ? ({ ...node, children: mapChildren(node) } as Nodes) : node;
    }
  };
  const mapChildren = (parent: Parents): Nodes[] =>
    parent.children.flatMap((child) => map(child, FLOW_PARENTS.has(parent.type)) ?? []);

  return { ...root, children: mapChildren(root) as RootContent[] };
}

interface Barrier {
  /** What follows the block when its separator is checked. */
  readonly probe: string;
  readonly separator: string;
}

// An HTML comment line ends every open block but a fence, math or other HTML, and starts none.
const COMMENT = "<!---->";
const COMMENT_SHAPE = JSON.stringify(canonical({ type: "html", value: COMMENT }));
const BARRIERS: ReadonlyArray<Barrier> = [
  { probe: `\n\n${COMMENT}`, separator: `\n\n${COMMENT}\n\n` },
  // A fence left open in a list keeps the blank line before a comment as code.
  { probe: `\n${COMMENT}`, separator: `\n${COMMENT}\n\n` },
];
const AFTER_BLANK_LINE = BARRIERS[0]!.separator;

/** A block for `text` when it renders as `expected` and a comment after it stays separate. */
function verified(text: string, expected: readonly [Shape, Shape]): MarkdownBlock | null {
  const read = readShapes(text);
  if (read === null || !sameShapes(read, expected)) return null;
  const barrier = BARRIERS.find(({ probe }) => {
    const probed = readShapes(text + probe);
    return (
      probed !== null &&
      sameShapes(probed, [
        [...read[0], COMMENT_SHAPE],
        [...read[1], COMMENT_SHAPE],
      ])
    );
  });
  if (barrier === undefined) return null;
  const block = { text, barrier: barrier.separator };
  shapes.set(block, read);
  return block;
}

const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})/u;

function* candidates(source: string, trees: readonly [Root, Root], rewritten: Root) {
  yield source;
  for (const tree of new Set(trees)) {
    const last = tree.children.at(-1);
    if (last?.type !== "code") continue;
    const start = last.position!.start.offset!;
    const fence = FENCE_OPENING.exec(source.slice(source.lastIndexOf("\n", start - 1) + 1));
    if (fence !== null) yield `${source}${source.endsWith("\n") ? "" : "\n"}${fence[1]}`;
  }
  const options = rewriteOptions(rewritten, source);
  yield toMarkdown(rewritten, options).replace(/\n$/u, "");
  // An autolink literal GFM accepts, such as `a@.5b`, can be one CommonMark's `<…>` form rejects.
  yield toMarkdown(rewritten, { ...options, resourceLink: true }).replace(/\n$/u, "");
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    run = text[index] === character ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** The source as code, for a message no Markdown can keep the same inside the document. */
function fencedSource(source: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(source, "`") + 1));
  return `${fence}markdown\n${source.endsWith("\n") ? source : `${source}\n`}${fence}`;
}

interface LabelOptions {
  /** The first footnote label number not yet used in the document. */
  readonly scope: number;
  /** Starts every footnote label; no text in the document may contain it followed by digits. */
  readonly prefix: string;
}

/**
 * A message as Markdown that renders inside a document as it does alone, under GFM with or without
 * math, or null when it renders nothing. The first candidate that verifiably reads the same wins:
 * the normalized source, the source with its open fence closed, then the tree written out; the
 * source shown as code is the last resort.
 */
export function standaloneMarkdown(
  text: string,
  { scope, prefix }: LabelOptions,
): (MarkdownBlock & { readonly labelCount: number }) | null {
  const source = text.replace(/^\uFEFF+/u, "").replace(/\r\n?/gu, "\n");
  if (/^[ \t\n]*$/u.test(source)) return null;
  const trees = readBoth(source);
  if (trees === null)
    return { text: fencedSource(source), barrier: AFTER_BLANK_LINE, labelCount: 0 };
  const labels = new Map<string, string>();
  const footnoteLabel = (identifier: string) => {
    let label = labels.get(identifier);
    if (label === undefined) {
      label = `${prefix}${scope + labels.size}`;
      labels.set(identifier, label);
    }
    return label;
  };
  const plain = contained(trees[0], footnoteLabel);
  const expected = [
    plain,
    trees[1] === trees[0] ? plain : contained(trees[1], footnoteLabel),
  ] as const;
  if (expected.every((tree) => tree.children.every(({ type }) => type === "footnoteDefinition"))) {
    return null;
  }
  const expectedShapes = shapeBoth(expected);
  for (const candidate of candidates(source, trees, expected[1])) {
    const block = verified(candidate, expectedShapes);
    if (block !== null) return Object.assign(block, { labelCount: labels.size });
  }
  return { text: fencedSource(source), barrier: AFTER_BLANK_LINE, labelCount: labels.size };
}

/** Literal text as a paragraph, or as a heading of the given depth. */
export function literalMarkdownBlock(value: string, headingDepth?: 1 | 2): MarkdownBlock {
  const children = [{ type: "text" as const, value }];
  const written = toMarkdown(
    headingDepth === undefined
      ? { type: "paragraph", children }
      : { type: "heading", depth: headingDepth, children },
    WRITE_OPTIONS,
  );
  return markdownBlock(written.replace(/\n$/u, ""));
}

/** A paragraph, heading or list the caller wrote. */
export function markdownBlock(text: string): MarkdownBlock {
  return { text, barrier: AFTER_BLANK_LINE };
}

/** What goes between two blocks so each renders as it does alone. */
export function markdownBlockSeparator(previous: MarkdownBlock, next: MarkdownBlock): string {
  const before = shapesOf(previous);
  const after = shapesOf(next);
  if (before === null || after === null) return previous.barrier;
  const joined = readShapes(`${previous.text}\n\n${next.text}`);
  return joined !== null &&
    sameShapes(joined, [
      [...before[0], ...after[0]],
      [...before[1], ...after[1]],
    ])
    ? "\n\n"
    : previous.barrier;
}

/** The line break a document can end with after its last block, when it keeps that block the same. */
export function markdownDocumentEnding(last: MarkdownBlock): string {
  if (last.text.endsWith("\n")) return "";
  const alone = shapesOf(last);
  const ended = readShapes(`${last.text}\n`);
  return alone !== null && ended !== null && sameShapes(alone, ended) ? "\n" : "";
}

/** A code span whose delimiter is longer than any backtick run inside it. */
export function markdownCodeSpan(text: string): string {
  const delimiter = "`".repeat(longestRun(text, "`") + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${delimiter}${padding}${text}${padding}${delimiter}`;
}
