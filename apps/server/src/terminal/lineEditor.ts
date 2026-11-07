// Line editors (zsh, fish, bash 5.1+) enable bracketed paste when they start reading a command.
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";

/** Whether the shell waits at its prompt after `text`, given the state before it. */
export function lineEditorReading(text: string, previous: boolean): boolean {
  const on = text.lastIndexOf(BRACKETED_PASTE_ON);
  const off = text.lastIndexOf(BRACKETED_PASTE_OFF);
  return on === off ? previous : on > off;
}
