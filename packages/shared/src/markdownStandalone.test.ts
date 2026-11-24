import type { Definition, Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  literalMarkdownBlock,
  type MarkdownBlock,
  markdownBlock,
  markdownBlockSeparator,
  standaloneMarkdown,
} from "./markdownStandalone.ts";

const viewer = unified().use(remarkParse).use(remarkGfm).freeze();
const mathViewer = viewer().use(remarkMath, { singleDollarTextMath: true }).freeze();
const viewers = [viewer, mathViewer] as const;
type Viewer = (typeof viewers)[number];

const normalized = (text: string) => text.replace(/^\uFEFF+/u, "").replace(/\r\n?/gu, "\n");
const BARRIER = "<!---->";
const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);
const isFootnote = (node: Nodes) =>
  node.type === "footnoteReference" || node.type === "footnoteDefinition";

/**
 * What a viewer shows for `markdown`: references as the links their first definition makes,
 * raw HTML as the text it was written as (a block as `html` code), footnote names inside
 * `namespace`. The document's own separator comments show nothing.
 */
function rendered(markdown: string, read: Viewer, namespace: string): Nodes[] {
  const root = read.parse(markdown);
  const definitions = new Map<string, Definition>();
  const collect = (node: Nodes) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if ("children" in node) node.children.forEach(collect);
  };
  collect(root);

  const render = (node: Nodes, parent: string): Nodes | null => {
    if (node.type === "definition") return null;
    if (node.type === "html") {
      return FLOW_PARENTS.has(parent)
        ? { type: "code", lang: "html", meta: null, value: node.value }
        : { type: "text", value: node.value };
    }
    let shown: Nodes;
    if (node.type === "linkReference") {
      const { url, title } = definitions.get(node.identifier)!;
      shown = { type: "link", url, title: title ?? null, children: node.children };
    } else if (node.type === "imageReference") {
      const { url, title } = definitions.get(node.identifier)!;
      shown = { type: "image", url, title: title ?? null, alt: node.alt ?? null };
    } else if (isFootnote(node)) {
      shown = {
        ...node,
        identifier: namespace + (node as { identifier: string }).identifier,
      } as Nodes;
    } else {
      shown = { ...node };
    }
    if ("children" in shown) {
      shown.children = (shown.children as Nodes[]).flatMap(
        (child) => render(child, node.type) ?? [],
      ) as never;
    }
    return shown;
  };
  return root.children
    .filter((node) => namespace !== "" || node.type !== "html" || node.value !== BARRIER)
    .flatMap((node) => render(node, "root") ?? []);
}

/** The nodes as JSON: positions and footnote labels dropped, text merged, footnotes renamed by first use. */
function canonical(nodes: ReadonlyArray<Nodes>): string {
  const names = new Map<string, string>();
  const write = (node: Nodes): unknown => {
    const entries = Object.keys(node)
      .filter((key) => key !== "position" && !(key === "label" && isFootnote(node)))
      .sort()
      .map((key): [string, unknown] => {
        const value = node[key as keyof Nodes] as unknown;
        if (key === "identifier" && isFootnote(node)) {
          const name = names.get(value as string) ?? `f${names.size}`;
          names.set(value as string, name);
          return [key, name];
        }
        if (key !== "children") return [key, value];
        const merged: Nodes[] = [];
        for (const child of value as Nodes[]) {
          const last = merged.at(-1);
          if (child.type === "text" && last?.type === "text") {
            merged[merged.length - 1] = { type: "text", value: last.value + child.value };
          } else {
            merged.push(child);
          }
        }
        return [key, merged.map(write)];
      });
    return Object.fromEntries(entries);
  };
  return JSON.stringify(nodes.map(write));
}

function join(blocks: ReadonlyArray<MarkdownBlock>): string {
  let markdown = blocks[0]!.text;
  for (let index = 1; index < blocks.length; index += 1) {
    markdown += markdownBlockSeparator(blocks[index - 1]!, blocks[index]!) + blocks[index]!.text;
  }
  return markdown;
}

function block(text: string): MarkdownBlock {
  const result = standaloneMarkdown(text, { scope: 1, prefix: "ref" });
  if (result === null) throw new Error(`${JSON.stringify(text)} shows nothing`);
  return result;
}

/** Whether the block shows the message's source as a code block instead of rendering it. */
function showsSource(markdownBlock: MarkdownBlock, source: string): boolean {
  const [node, ...rest] = viewer.parse(markdownBlock.text).children;
  return (
    rest.length === 0 &&
    node?.type === "code" &&
    node.lang === "markdown" &&
    node.value === source.replace(/\n$/u, "")
  );
}

/** What each viewer shows for a message alone, or null when no viewer shows anything. */
function shownAlone(source: string, namespace: string): readonly [Nodes[], Nodes[]] | null {
  const shown = [
    rendered(source, viewer, namespace),
    rendered(source, mathViewer, namespace),
  ] as const;
  return shown.some((nodes) => nodes.some((node) => node.type !== "footnoteDefinition"))
    ? shown
    : null;
}

/**
 * Exports the messages as one document and checks each renders there as it does alone. Only the
 * messages in `fenced` may show as code instead.
 */
function expectContained(
  messages: ReadonlyArray<string>,
  fenced: ReadonlyArray<string> | "any" = [],
) {
  const expected = messages.map((text, index) => shownAlone(normalized(text), `m${index}:`));
  let scope = 1;
  const parts = messages.flatMap((text, index) => {
    const result = standaloneMarkdown(text, { scope, prefix: "ref" });
    const label = JSON.stringify(text);
    expect(result === null, `${label} shows nothing`).toBe(expected[index] === null);
    if (result === null) return [];
    scope += result.labelCount;
    const source = normalized(text);
    const asCode = showsSource(result, source);
    if (asCode && fenced !== "any") expect(fenced, `${label} shows as code`).toContain(text);
    return [{ block: result, source, asCode, shown: expected[index]! }];
  });
  if (parts.length === 0) return;
  const document = join(parts.map((part) => part.block));
  viewers.forEach((read, viewerIndex) => {
    const alone = parts.flatMap(({ source, asCode, shown }) =>
      asCode
        ? [
            {
              type: "code",
              lang: "markdown",
              meta: null,
              value: source.replace(/\n$/u, ""),
            } as Nodes,
          ]
        : shown[viewerIndex]!,
    );
    expect(canonical(rendered(document, read, "")), JSON.stringify(messages)).toBe(
      canonical(alone),
    );
  });
}

describe("standaloneMarkdown", () => {
  it.each([
    ["inline math", String.raw`\(x\)`],
    ["display math", String.raw`\[x\]`],
    ["adjacent math", String.raw`\(a\)\(b\)`],
    ["dollar amounts", "$5 and $10"],
    ["brackets and image", "[a] ![[x]](u)"],
    ["image alt with brackets", "![[x]](u)"],
    ["wide table", "| x |\n|-|\n|" + "a".repeat(2000) + "|\n" + "|ok|\n".repeat(500)],
    ["Windows link", String.raw`[f](C:\work\.t3\x)`],
    ["image on its own line", "Label\n![shot](img.png)\nEnd"],
    ["setext heading", "Title\n===="],
    ["hard breaks", "one  \ntwo\\\nthree"],
    ["task list", "* [x] done\n* [ ] next"],
    ["nested ordered list", "3) outer\n   2. inner"],
    ["backticks in code", "``` ``x` ```"],
    ["autolink and escaped HTML", "<https://example.com> and \\<b>"],
    ["BOM and line endings", "\uFEFFa\r\nb\rc\n"],
  ])("preserves the normalized source for %s", (_name, source) => {
    expect(block(source).text).toBe(normalized(source));
  });

  it.each([
    [
      "[x] and ![x][] and [t][x] and [raw]\n\n[x]: <u> 'title'",
      '[x](u "title") and ![x](u "title") and [t](u "title") and \\[raw]',
    ],
    ["> [x]: /first\n\n[x]: /second\n\n[read][x]", ">\n\n[read](/first)"],
    ["\uFEFF\uFEFF[x]\n\n[x]: /a", "[x](/a)"],
    ["<details>open", "```html\n<details>open\n```"],
    ["Before <b>open", "Before \\<b>open"],
    [String.raw`Inline \(x\) <b>`, String.raw`Inline \(x\) \<b>`],
    ["> \\( a\n> b \\) <b>", "> \\( a\n> b \\) \\<b>"],
    ["- \\[\n  x\n  \\]\n\n<div>", "- \\[\n  x\n  \\]\n\n```html\n<div>\n```"],
    ["> - $$ m\n>   x\n>   $$\n\n<div>", "> - $$ m\n>   x\n>   $$\n\n```html\n<div>\n```"],
    ["at Array.<anonymous> (pkg@.5g)", "at Array.\\<anonymous> ([pkg@.5g](mailto:pkg@.5g))"],
    [
      `A[^a\\*] B[^a*] C[^${"a".repeat(997)}]\n\n[^a\\*]: escaped\n[^a*]: plain\n[^${"a".repeat(997)}]: long`,
      "A[^ref1] B[^ref2] C[^ref3]\n\n[^ref1]: escaped\n\n[^ref2]: plain\n\n[^ref3]: long",
    ],
  ])("writes %j from its tree", (source, text) => {
    expect(block(source).text).toBe(text);
  });

  it.each([
    ["````ts\ncode\n```", "\n````"],
    ["~~~js\ncode\n    ~~~\n", "~~~"],
  ])("closes a top-level open fence in %j", (source, closing) => {
    expect(block(source).text).toBe(source + closing);
    expectContained([source, "Next"]);
  });

  it("shows the source as code when no Markdown renders the same inside the document", () => {
    const source = "&#10;<div>";
    expect(showsSource(block(source), source)).toBe(true);
    expectContained([source, "Next"], [source]);
  });

  it("keeps a copied destination from defining a reference for a later message", () => {
    expectContained(["[a|b]\n\n[a|b]: <a&#10;&#10;[other]:&#32;/x&#10;&#10;z>", "[other]"]);
  });

  it.each([" \n\t\n", "\uFEFF\uFEFF", "[a]: /x\n", "[^unused]: hello", "[^unused]: [^unused]"])(
    "returns null for %j",
    (source) => {
      expect(standaloneMarkdown(source, { scope: 1, prefix: "ref" })).toBeNull();
    },
  );

  const messages = {
    markdownInHtml: "<pre>\n# x\n- y\n</pre>",
    indentedHtml: "  <div>\n  # x",
    htmlInQuote: "> <div>\n> # x\n> </div>",
    htmlEndingQuote: "> <div>\nfoo",
    ruleAfterComment: "<!-- c -->\n---",
    fenceInHtml: "<div>\n````\n</div>",
    htmlInListItem: "- <div>\n  # x\n  </div>\n\n  after",
    listAfterQuoteMarker: ">- <div>\n>   more",
    tabInQuotedList: "> a\n>\t- <div>\n>\t  y",
    tabAfterListMarker: "-\t<div>\n\tx",
    nestedListItems: "- - <div>\n    z",
    htmlFootnote: "[^a]: <div>\n    more\n\nSee[^a]",
    listInFootnote: "[^a]:  - <div>\n\nSee[^a]",
    blocksAroundMarkdown: "<details>\n<summary>**Note**</summary>\n\nbody\n</details>",
    wideCharacterBeforeTab: "[^😀]: -\t<div>\n\nsee[^😀]",
    tabAfterFootnoteMarker: "[^a]: -\t<details>\n\nSee[^a]",
    tabBeforeFootnoteContent: "[^a]: -\tx\n\n      y\n\nSee[^a]",
    tabAfterQuoteMarker: ">\t<div>",
    inlineHtmlOnLaterLine: '> a <b\n> c="*d*">',
    htmlAttributes: "` a <b t='``'> b",
    htmlAcrossLines: "text <x a='a  \nb'>",
    htmlBeforeTableRow: "x <b t='|'> y\n|-|",
    htmlAfterAutolink: "See http://example.com/path<b>",
    pipeInFullReference: "[text][a|b]\n|-|\n\n[a|b]: /url",
    pipeInDefinitionLabel: "[a|b]: /u\n|-|\n\n[t][a|b]",
    shortcutAndCollapsedReferences: "[a|b] and [a|b][]\n\n[a|b]: /u 'x\n|-|\ny'",
    lineBreakInLabel: "x|[t][a\nb]\n|-|-|\n\n[a b]: /u",
    lineBreakInQuotedLabel: "> x|[t][a\n> b]\n> |-|-|\n\n[a b]: /u",
    indentedLineInLabel: "[t][a\n    b|c]\n|-|-|\n\n[a b|c]: /u",
    pipeInFootnoteLabel: "See[^a|b]\n|-|\n\n[^a|b]: note",
    referenceInImage: "![[go][x]](/img)\n\n[x]: /dest",
    longLabel: `[t][${"a|".repeat(497)}a]\n|-|\n\n[${"a|".repeat(497)}a]: /u`,
    tabExpandedLabel: `[t][|${"\t".repeat(249)}z]\n\n[|${"\t".repeat(249)}z]: /u`,
    referencesBesideHtml: "[a <b>] and [a <b>][] and [a]<b>\n\n[a <b>]: /guide\n[a]: /a",
    newlineInDestination: "[t][x]\n\n[x]: </x&#10;y>",
    footnotesToTheirBodies: "A[^a] B[^b]\n\n[^a]: one\n[^b]: two",
    doubleBom: "\uFEFF\uFEFF[x]\n\n[x]: /a",
    openDisplayMath: "$$a\n\n- b",
    inlineMathBesideHtml: String.raw`Inline \(x\) <b>`,
    displayMathBesideHtml: String.raw`Display \[x\] <b>`,
    mathAcrossQuotedLines: "> \\( a\n> b \\) <b>",
    mathInListBesideHtml: "- \\[\n  x\n  \\]\n\n<div>",
    raggedTable: `| h |\n| - |\n|${" c |".repeat(100)}\n${"| r |\n".repeat(100)}<div>`,
  };

  it.each(Object.entries(messages))("keeps %s contained beside other messages", (_name, text) => {
    expectContained([text, "Next"]);
    expectContained(["- item", text]);
    expectContained([text, text]);
  });

  it("rewrites a ragged table with each row as long as written", () => {
    const source = messages.raggedTable;
    const result = block(source);

    expect(showsSource(result, source)).toBe(false);
    expect(result.text.length).toBeLessThan(2 * source.length);
  });

  const fragments = [
    "*",
    "**",
    "_",
    "__",
    "~~",
    "`",
    "``",
    "[",
    "]",
    "(",
    ")",
    "<",
    ">",
    "!",
    "|",
    "\\",
    "&amp;",
    "&#10;",
    "#",
    "-",
    "+",
    "1.",
    "2)",
    " ",
    "  ",
    "\t",
    "\n",
    "\n\n",
    "    ",
    "> ",
    "- ",
    "```",
    "~~~",
    "[x]",
    "[x]: /u",
    "[^a]",
    "[^a]: n",
    "a",
    "word",
    "😀",
    "<div>",
    "</div>",
    "<b>",
    "<!--",
    "-->",
    "---",
    "===",
    "|-|",
    "| a |",
    "http://a.b",
    "$",
    "$$",
    "\\[",
    "\\]",
    ":",
    "\uFEFF",
    "\r\n",
  ];

  // Random fragments often make Markdown no document can keep, so these may show as code.
  it("keeps generated messages contained", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const message = () =>
      Array.from(
        { length: 1 + Math.floor(random() * 25) },
        () => fragments[Math.floor(random() * fragments.length)],
      ).join("");
    for (let index = 0; index < 150; index += 1) {
      expectContained(Array.from({ length: 2 + Math.floor(random() * 3) }, message), "any");
    }
  });
});

describe("literalMarkdownBlock", () => {
  it.each(["Fix *login* <div> [x]", "a \\[b\\] c", "[[x]]", "C# a #", "1) x", "$5 and $6", "a\\"])(
    "writes %j as text that reads back the same",
    (value) => {
      expect(mathViewer.parse(literalMarkdownBlock(value, 1).text).children).toMatchObject([
        { type: "heading", children: [{ type: "text", value }] },
      ]);
      expect(mathViewer.parse(literalMarkdownBlock(value).text).children).toMatchObject([
        { type: "paragraph", children: [{ type: "text", value }] },
      ]);
    },
  );

  const shown = (node: Nodes): string =>
    node.type === "text" ? node.value : "children" in node ? node.children.map(shown).join("") : "";

  it.each(["Contact jim@example.com", "Fix http://x.com/*a*/~u_b_", "see www.example.com"])(
    "shows %j with the same text where a viewer links it",
    (value) => {
      const [heading] = mathViewer.parse(literalMarkdownBlock(value, 1).text).children;
      expect(shown(heading!)).toBe(value);
    },
  );
});

describe("markdownBlockSeparator", () => {
  const list = markdownBlock("- one");

  it.each<[string, MarkdownBlock, MarkdownBlock, string]>([
    ["a paragraph after a list", list, markdownBlock("Two"), "\n\n"],
    ["a list after a list", list, markdownBlock("- two"), "\n\n<!---->\n\n"],
    ["a list after a paragraph", markdownBlock("One"), list, "\n\n"],
  ])("separates %s", (_name, previous, next, separator) => {
    expect(markdownBlockSeparator(previous, next)).toBe(separator);
  });
});

const boundaries = {
  paragraph: "paragraph\nlazy",
  heading: "# Heading",
  looseList: "- first\n\n- second",
  tightList: "- first\n- second",
  orderedList: "99) item",
  emptyList: "- ",
  listEndingInFence: "- item\n  ```js\n  code\n",
  listEndingInFenceWithoutNewline: "- item\n  ```js\n  code",
  listEndingInFenceWithBlankLines: "- item\n  ```js\n  code\n\n\n",
  listEndingInFenceWithSpaces: "- ~~~\n  hi\n ",
  footnoteListEndingInFence: "See[^a]\n\n[^a]: - ~~~\n          ~~~",
  footnoteFirst: "[^a]: note\n\nSee[^a]",
  quoteEndingInList: "> - item",
  quoteEndingInLazyParagraph: "> paragraph\nlazy",
  indentedCode: "    indented code",
  indentedBlankLine: "    \nx",
  tabBlankLine: "\t\nx",
  fencedCode: "~~~\ncode\n~~~",
  table: "| h |\n| - |\n| v |",
  thematicBreak: "---",
  htmlBlock: "<details>",
  inlineHtml: "a <b>",
  definitionsAtBoundary: "[x]: /url\n\nVisible [x]\n\n[^x]: note",
  indentedParagraph: "  paragraph",
  indentedHeading: "  # heading",
  blankBeforeCode: "\n\tcode",
  openDisplayMath: "$$\nx",
};

const pairs = Object.entries(boundaries).flatMap(([leftName, left]) =>
  Object.entries(boundaries).map(
    ([rightName, right]) => [leftName, rightName, left, right] as const,
  ),
);

it.each(pairs)("keeps %s separate from %s", (_leftName, _rightName, left, right) => {
  expectContained([left, right]);
});
