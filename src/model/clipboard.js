export function previewClipboardText(text) {
  const value = String(text ?? "");
  if (value.length <= 200) return value;
  return `${value.slice(0, 100)}…\n…${value.slice(-100)}`;
}

export function serializeClipboardEntry(entry) {
  if (entry?.kind === "text") return { text: String(entry.text ?? "") };
  if (entry?.kind === "image") return { image: String(entry.path ?? "") };
  throw new Error("Clipboard entry must be text or image.");
}
