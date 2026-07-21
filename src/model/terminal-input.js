// Pure composer selection helpers. The controller decides when to submit;
// this module only identifies the logical line at the textarea caret and the
// adjacent newline that should be removed with it.
export function terminalLineAtCursor(input, cursor = 0) {
  const value = String(input ?? "");
  const position = Math.min(value.length, Math.max(0, Number(cursor) || 0));
  const start = value.lastIndexOf("\n", position - 1) + 1;
  const nextNewline = value.indexOf("\n", position);
  const end = nextNewline < 0 ? value.length : nextNewline;
  const removeStart = nextNewline < 0 && start > 0 ? start - 1 : start;
  const removeEnd = nextNewline < 0 ? end : end + 1;
  return { text: value.slice(start, end), start, end, removeStart, removeEnd };
}
