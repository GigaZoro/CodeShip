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

/** Whether an odd run of backslashes comes right before `offset`. */
const isEscaped = (source: string, offset: number) => {
  let slashes = 0;
  while (source[offset - 1 - slashes] === "\\") slashes += 1;
  return slashes % 2 === 1;
};

/** Where the delimiter that closes `span` starts, before any trailing spaces and tabs. */
function closingStart(span: string, opening: string): number | undefined {
  let end = span.length;
  while (span[end - 1] === " " || span[end - 1] === "\t") end -= 1;
  let start = end;
  if (opening.startsWith("\\")) {
    if (span.endsWith(opening === "\\(" ? "\\)" : "\\]", end)) start = end - 2;
  } else {
    while (span[start - 1] === "$") start -= 1;
    // As the tokenizer reads it, an escaped dollar is the formula's own.
    if (isEscaped(span, start)) start += 1;
  }
  return start < end && start >= opening.length ? start : undefined;
}

const lineCount = (text: string) => text.split("\n").length;

/**
 * Math as authored: the writer's `$` form can read differently from `\(` or `\[` without math.
 * A span that crosses lines inside a container also holds the container's markers, so that math
 * is rebuilt from its delimiters, value and padding.
 */
function authoredSpan(node: MathNode | InlineMath, span: string, nested: boolean) {
  if (!nested || !span.includes("\n")) return span;
  const opening = MATH_OPENING.exec(span)?.[0];
  const start = opening === undefined ? undefined : closingStart(span, opening);
  if (opening === undefined || start === undefined) return undefined;
  const closing = span.slice(start).trimEnd();
  const valueLines = node.value.split("\n");
  if (node.type === "math") {
    // The opening line stays as written: its text is the formula's first line, and trailing
    // spaces end it with a hard break when math is not read.
    const openingLine = span.slice(0, span.indexOf("\n"));
    const opensWithText = openingLine.slice(opening.length).trim() !== "";
    const lines = [openingLine, ...valueLines.slice(opensWithText ? 1 : 0)];
    if (lineCount(span) > lines.length) lines.push(closing);
    else lines[lines.length - 1] += closing;
    return lines.join("\n");
  }
  const inner = span.slice(opening.length, start);
  const lead = inner[0];
  let trail: string | undefined;
  // One space or line ending pads each end of a value that is not only those.
  if ((lead === " " || lead === "\n") && /[^ \n]/u.test(node.value)) {
    // A line the value lacks holds only the markers before a closing delimiter that starts it.
    const extraLines = lineCount(inner) - valueLines.length - (lead === "\n" ? 1 : 0);
    if (extraLines === 1) trail = "\n";
    else if (extraLines === 0 && inner.endsWith(" ")) trail = " ";
  }
  return trail === undefined
    ? `${opening}${node.value}${closing}`
    : `${opening}${lead}${node.value}${trail}${closing}`;
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

// A reference copies its destination and title wherever it is used, so a short message could
// expand without bound; one that would expand past this shows as code.
const REFERENCE_GROWTH = 4;
const REFERENCE_FLOOR = 65_536;

/** The definition each reference uses: the first with its identifier. */
function firstDefinitions(root: Root): ReadonlyMap<string, Definition> {
  const definitions = new Map<string, Definition>();
  const collect = (node: Nodes) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if ("children" in node) node.children.forEach(collect);
  };
  collect(root);
  return definitions;
}

/**
 * The tree the message must render as inside other messages: references become the links their
 * first definition makes, definitions go, footnotes get labels of their own, and raw HTML reads
 * as written (a block as `html` code). Null when references copy more than `budget` characters.
 */
function contained(
  root: Root,
  footnoteLabel: (identifier: string) => string,
  budget: number,
): Root | null {
  let copied = 0;
  const definitions = firstDefinitions(root);

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
        copied += url.length + (title?.length ?? 0);
        return { type: "link", url, title: title ?? null, children: mapChildren(node) as never };
      }
      case "imageReference": {
        const { url, title } = definitions.get(node.identifier)!;
        copied += url.length + (title?.length ?? 0);
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

  const children = mapChildren(root) as RootContent[];
  return copied > budget ? null : { ...root, children };
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

const lineStart = (source: string, offset: number) => source.lastIndexOf("\n", offset - 1) + 1;

/** Where the label that ends a full reference at `end` opens: a label holds no bare bracket. */
function labelOpening(source: string, end: number): number {
  let index = source.lastIndexOf("[", end - 2);
  while (index > 0 && isEscaped(source, index)) index = source.lastIndexOf("[", index - 1);
  return index;
}

/** Where the label of a footnote definition starting at `start` closes. */
function footnoteLabelClosing(source: string, start: number): number {
  let index = source.indexOf("]", start + 2);
  while (index !== -1 && isEscaped(source, index)) index = source.indexOf("]", index + 1);
  return index;
}

/** `(destination "title")` as the writer escapes them. */
function writtenDestination({ url, title }: Definition): string {
  const link = toMarkdown({ type: "link", url, title: title ?? null, children: [] }, WRITE_OPTIONS);
  return link.replace(/\n$/u, "").slice("[]".length);
}

type Edit = readonly [from: number, end: number, text: string];

const EDITED: ReadonlySet<Nodes["type"]> = new Set([
  "html",
  "definition",
  "linkReference",
  "imageReference",
  "footnoteReference",
  "footnoteDefinition",
]);

/** The edit that makes `node` read inside a document as alone, or null when it needs none. */
function sourceEdit(
  source: string,
  node: Nodes,
  parent: Parents["type"],
  definitions: ReadonlyMap<string, Definition>,
  destinations: Map<Definition, string>,
  footnoteLabel: (identifier: string) => string,
): Edit | null | undefined {
  // Nodes the GFM autolink step splits out have no position; none of them needs an edit.
  if (!EDITED.has(node.type)) return null;
  const start = node.position!.start.offset!;
  const end = node.position!.end.offset!;
  switch (node.type) {
    case "html":
      if (parent === "root") return [lineStart(source, start), end, fencedCode("html", node.value)];
      return FLOW_PARENTS.has(parent) ? undefined : [start, start, "\\"];
    case "definition": {
      // A definition on lines of its own goes with its line ending, and between blank lines with one.
      const from = lineStart(source, start);
      if (!/^[ \t]*$/u.test(source.slice(from, start)) || source[end] !== "\n") {
        return [start, end, ""];
      }
      const afterBlank =
        from === 0 || /^[ \t]*$/u.test(source.slice(lineStart(source, from - 1), from - 1));
      return [from, end + (afterBlank && source[end + 1] === "\n" ? 2 : 1), ""];
    }
    case "linkReference":
    case "imageReference": {
      const definition = definitions.get(node.identifier)!;
      let destination = destinations.get(definition);
      if (destination === undefined) {
        destination = writtenDestination(definition);
        destinations.set(definition, destination);
      }
      if (node.referenceType === "shortcut") {
        return source[end - 1] === "]" ? [end - 1, end, `]${destination}`] : undefined;
      }
      if (node.referenceType === "collapsed") {
        return source.endsWith("[]", end) ? [end - 2, end, destination] : undefined;
      }
      const opening = labelOpening(source, end);
      return opening === -1 ? undefined : [opening, end, destination];
    }
    case "footnoteReference":
      return [start, end, `[^${footnoteLabel(node.identifier)}]`];
    case "footnoteDefinition": {
      const closing = footnoteLabelClosing(source, start);
      return closing === -1
        ? undefined
        : [start, closing + 1, `[^${footnoteLabel(node.identifier)}]`];
    }
  }
}

/** Where the run of spaces, tabs and line endings that ends `text` starts. */
function trailingSpace(text: string): number {
  let start = text.length;
  while (
    start > 0 &&
    (text[start - 1] === " " || text[start - 1] === "\t" || text[start - 1] === "\n")
  ) {
    start -= 1;
  }
  return start;
}

/**
 * The source with only what reads differently inside a document changed where it is written:
 * inline HTML escaped, a top-level HTML block as `html` code, references as the links their first
 * definition makes, definitions removed and footnotes relabeled. Undefined when nothing needs it,
 * or for HTML inside a container.
 */
function withSourceEdits(
  source: string,
  trees: readonly [Root, Root],
  footnoteLabel: (identifier: string) => string,
): string | undefined {
  const edits = new Map<number, readonly [end: number, text: string]>();
  const destinations = new Map<Definition, string>();
  for (const tree of new Set(trees)) {
    const definitions = firstDefinitions(tree);
    const pending: Array<readonly [Nodes, Parents["type"]]> = [[tree, "root"]];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [node, parent] = next;
      if ("children" in node) for (const child of node.children) pending.push([child, node.type]);
      const edit = sourceEdit(source, node, parent, definitions, destinations, footnoteLabel);
      if (edit === undefined) return undefined;
      if (edit === null) continue;
      const [from, end, text] = edit;
      const known = edits.get(from);
      if (known !== undefined && (known[0] !== end || known[1] !== text)) return undefined;
      edits.set(from, [end, text]);
    }
  }
  if (edits.size === 0) return undefined;
  let text = "";
  let copied = 0;
  for (const [from, [end, edit]] of [...edits].sort(([left], [right]) => left - right)) {
    if (from < copied) return undefined;
    text += source.slice(copied, from) + edit;
    copied = end;
  }
  text += source.slice(copied);
  // Removed definitions leave blank lines at either end; keep the source's own.
  const leading = /^\n*/u.exec(source)![0];
  return (
    leading +
    text.slice(/^\n*/u.exec(text)![0].length, trailingSpace(text)) +
    source.slice(trailingSpace(source))
  );
}

function* candidates(
  source: string,
  trees: readonly [Root, Root],
  rewritten: Root,
  footnoteLabel: (identifier: string) => string,
) {
  const fences = new Set<string>();
  for (const tree of new Set(trees)) {
    const last = tree.children.at(-1);
    if (last?.type !== "code") continue;
    const fence = FENCE_OPENING.exec(source.slice(lineStart(source, last.position!.start.offset!)));
    if (fence !== null) fences.add(fence[1]!);
  }
  const closed = (text: string) =>
    [...fences].map((fence) => `${text}${text.endsWith("\n") ? "" : "\n"}${fence}`);
  yield source;
  yield* closed(source);
  const edited = withSourceEdits(source, trees, footnoteLabel);
  if (edited !== undefined) {
    yield edited;
    yield* closed(edited);
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

function fencedCode(lang: string, code: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
  return `${fence}${lang}\n${code.endsWith("\n") ? code : `${code}\n`}${fence}`;
}

/** The source as code, for a message no candidate keeps the same inside the document. */
const fencedSource = (source: string) => fencedCode("markdown", source);

interface LabelOptions {
  /** The first footnote label number not yet used in the document. */
  readonly scope: number;
  /** Starts every footnote label; no text in the document may contain it followed by digits. */
  readonly prefix: string;
}

/**
 * A message as Markdown that renders inside a document as it does alone, under GFM with or without
 * math, or null when it renders nothing. The first verified candidate wins: the source, then the
 * source edited where its HTML, references and footnotes are, then the tree written out.
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
  // Definitions show nothing, and a footnote only where something else refers to it.
  const invisible = trees.every((tree) =>
    tree.children.every(({ type }) => type === "definition" || type === "footnoteDefinition"),
  );
  if (invisible) return null;
  const budget = Math.max(REFERENCE_GROWTH * source.length, REFERENCE_FLOOR);
  const plain = contained(trees[0], footnoteLabel, budget);
  const math = trees[1] === trees[0] ? plain : contained(trees[1], footnoteLabel, budget);
  if (plain === null || math === null) {
    return { text: fencedSource(source), barrier: AFTER_BLANK_LINE, labelCount: labels.size };
  }
  const expectedShapes = shapeBoth([plain, math]);
  for (const candidate of candidates(source, trees, math, footnoteLabel)) {
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
