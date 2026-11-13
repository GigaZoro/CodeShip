// RegExp.escape is missing from Node 22, which the server supports, and from Hermes.
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= maxLength) {
    return trimmed;
  }

  return `${characters.slice(0, maxLength).join("")}...`;
}
