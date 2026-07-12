export function previewClipboardText(text) {
  const value = String(text ?? "");
  if (value.length <= 150) return value;
  return `${value.slice(0, 100)}…\n…${value.slice(-50)}`;
}

import { formatBytes } from "./presentation.js";

// Like presentation's formatBytes, but returns "" for unknown sizes so image
// badges and info popups can omit a size they do not have.
export function formatByteSize(bytes) {
  if (bytes == null || bytes === "") return "";
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  return formatBytes(value);
}

function imageFormatLabel(item) {
  const explicit = item?.format ? String(item.format) : "";
  if (explicit) return explicit.toUpperCase();
  const path = String(item?.path ?? "");
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return "";
  return path.slice(dot + 1).toUpperCase();
}

// Compact "PNG · 1280×720 · 100 KB" badge; each part is dropped when unknown so
// browser-mode entries without native metadata still render what they have.
export function formatImageMeta(item) {
  const parts = [];
  const format = imageFormatLabel(item);
  if (format) parts.push(format);
  const width = Number(item?.width);
  const height = Number(item?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    parts.push(`${width}×${height}`);
  }
  const size = formatByteSize(item?.byteSize);
  if (size) parts.push(size);
  return parts.join(" · ");
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function describeClipboardText(text) {
  const value = String(text ?? "");
  const trimmed = value.trim();
  return {
    bytes: utf8ByteLength(value),
    chars: [...value].length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    lines: value === "" ? 0 : value.split(/\r\n|\r|\n/).length
  };
}

export function serializeClipboardEntry(entry) {
  if (entry?.kind === "text") return { text: String(entry.text ?? "") };
  if (entry?.kind === "image") return { image: String(entry.path ?? "") };
  throw new Error("Clipboard entry must be text or image.");
}
