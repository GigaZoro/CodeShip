/**
 * Splits a pasted command line the way a shell would for plain words and quoted arguments.
 * Undefined means a quote was left open.
 */
export function splitCommandLine(line: string): ReadonlyArray<string> | undefined {
  return splitQuotedCommandLine(line)?.map((word) => word.text);
}

/** A word of a command line, and the part of it that was outside quotes. */
interface CommandLineWord {
  readonly text: string;
  readonly outsideQuotes: string;
}

/** `splitCommandLine`, keeping what was outside quotes. Undefined means a quote was left open. */
export function splitQuotedCommandLine(line: string): ReadonlyArray<CommandLineWord> | undefined {
  const words: Array<CommandLineWord> = [];
  let word = "";
  let outsideQuotes = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && line[index + 1] === '"') {
        word += '"';
        index += 1;
      } else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push({ text: word, outsideQuotes });
      word = "";
      outsideQuotes = "";
      started = false;
    } else {
      word += char;
      outsideQuotes += char;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push({ text: word, outsideQuotes });
  return words;
}

/** Joins words back into a line `splitCommandLine` reads the same way. */
export function joinCommandLine(words: ReadonlyArray<string>): string {
  return words
    .map((word) => {
      if (word !== "" && !/[\s"']/u.test(word)) return word;
      if (!word.includes("'")) return `'${word}'`;
      return `"${word.replaceAll('"', '\\"')}"`;
    })
    .join(" ");
}
