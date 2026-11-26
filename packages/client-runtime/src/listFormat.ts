import { msg, t } from "@t3tools/shared/i18n";

/** "A, B, and C" in `locale`. Hermes ships without Intl.ListFormat, so it joins with `resolve`. */
export function formatConjunctionList(
  items: ReadonlyArray<string>,
  locale: string,
  resolve: typeof t = t,
): string {
  if (typeof Intl.ListFormat === "function") {
    return new Intl.ListFormat(locale, { type: "conjunction" }).format(items);
  }
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) {
    return resolve(msg("{first} and {second}"), { first: items[0]!, second: items[1]! });
  }
  let list = resolve(msg("{first}, and {last}"), { first: items.at(-2)!, last: items.at(-1)! });
  for (let index = items.length - 3; index >= 0; index -= 1) {
    list = resolve(msg("{first}, {rest}"), { first: items[index]!, rest: list });
  }
  return list;
}
