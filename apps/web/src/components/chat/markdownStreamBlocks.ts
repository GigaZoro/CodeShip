// Definitions, footnote definitions, raw HTML, container directives and display math can tie
// blocks together, also from inside a block quote or list item.
const CROSS_BLOCK_LINE_PATTERN =
  /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)))* {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
const CODE_SPAN_PATTERN = /(?<![\\`])(`+)[^`][\s\S]*?(?<!`)\1(?!`)/g;
// Anything that might start a tag counts as open; only a whole closing tag closes one.
const INLINE_TAG_PATTERN =
  /<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)|(?<!\\)<\/([A-Za-z][A-Za-z0-9-]*)\s*>/g;
const VOID_ELEMENTS = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);

/** Inline tags left open on a line; the HTML parser carries an open `<b>` into later paragraphs. */
function trackOpenTags(line: string, open: Map<string, number>) {
  const outsideCode = line.replace(CODE_SPAN_PATTERN, "");
  for (const [, opened, closed] of outsideCode.matchAll(INLINE_TAG_PATTERN)) {
    const name = (opened ?? closed)!.toLowerCase();
    if (VOID_ELEMENTS.has(name)) continue;
    const count = open.get(name) ?? 0;
    if (opened) open.set(name, count + 1);
    else if (count > 1) open.set(name, count - 1);
    else open.delete(name);
  }
}

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.includes("\r")) return null;
  const blocks: string[] = [];
  const openTags = new Map<string, number>();
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  let tracking = true;
  for (const line of text.split("\n")) {
    // A line left of an indented fence may end the list item holding it, which isn't tracked, so
    // the rest stays one block and every line of it counts as outside a fence.
    if (fence !== null && /\S/.test(line.slice(0, fenceIndent))) {
      fence = null;
      tracking = false;
    }
    if (fence !== null) {
      const closer = FENCE_PATTERN.exec(line)?.[1];
      if (
        closer &&
        closer[0] === fence[0] &&
        closer.length >= fence.length &&
        line.trim() === closer
      ) {
        fence = null;
      }
    } else if (CROSS_BLOCK_LINE_PATTERN.test(line)) {
      return null;
    } else if (tracking && line.trim() === "") {
      afterBlankLine = true;
    } else if (tracking) {
      if (
        afterBlankLine &&
        lineStart > blockStart &&
        openTags.size === 0 &&
        !CONTINUATION_PATTERN.test(line)
      ) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlankLine = false;
      const opener = FENCE_PATTERN.exec(line)?.[1];
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
      else trackOpenTags(line, openTags);
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}
