export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const ASSISTANT_TAGS = Object.freeze([
  { name: "cmd", kind: "command", open: "<cmd>", close: "</cmd>" },
  { name: "i", kind: "insert", open: "<i>", close: "</i>" }
]);

const COMPLETE_ASSISTANT_TAG_PATTERN = /<(cmd|i)>([\s\S]*?)<\/\1>/gi;

export function parseAssistantReply(reply) {
  const source = String(reply ?? "");
  const actions = [];
  const transcripts = [];
  const segments = [];
  let cursor = 0;
  let match;

  while ((match = COMPLETE_ASSISTANT_TAG_PATTERN.exec(source))) {
    if (match.index > cursor) {
      segments.push({ kind: "text", text: source.slice(cursor, match.index) });
    }
    const value = match[2].trim();
    if (value) {
      const kind = match[1].toLowerCase() === "cmd" ? "command" : "insert";
      actions.push({ kind, text: value });
      if (kind === "insert") transcripts.push(value);
      segments.push({ kind, text: value });
    }
    cursor = COMPLETE_ASSISTANT_TAG_PATTERN.lastIndex;
  }

  if (cursor < source.length) {
    segments.push({ kind: "text", text: source.slice(cursor) });
  }
  if (!segments.length && source) {
    segments.push({ kind: "text", text: source });
  }

  const text = segments
    .filter((segment) => segment.kind === "text")
    .map((segment) => segment.text)
    .join("")
    .trim();

  return { actions, transcripts, text, segments };
}

export function assistantPlainText(reply) {
  return String(reply ?? "").replace(COMPLETE_ASSISTANT_TAG_PATTERN, "$2");
}

export function terminalAssistantSegments(reply) {
  const text = assistantPlainText(reply).replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  return text ? [{ kind: "text", text }] : [];
}

function tagPrefixSuffixLength(value, tags) {
  const lower = value.toLowerCase();
  let best = 0;
  for (const tag of tags) {
    const target = tag.toLowerCase();
    const maximum = Math.min(lower.length, target.length - 1);
    for (let length = maximum; length > best; length -= 1) {
      if (lower.endsWith(target.slice(0, length))) {
        best = length;
        break;
      }
    }
  }
  return best;
}

function earliestOpenTag(value) {
  const lower = value.toLowerCase();
  let selected = null;
  for (const tag of ASSISTANT_TAGS) {
    const index = lower.indexOf(tag.open);
    if (index < 0) continue;
    if (!selected || index < selected.index) selected = { tag, index };
  }
  return selected;
}

export class AssistantStreamParser {
  constructor() {
    this.buffer = "";
    this.activeTag = null;
    this.finished = false;
  }

  push(chunk) {
    if (this.finished) return [];
    this.buffer += String(chunk ?? "");
    return this.drain(false);
  }

  finish() {
    if (this.finished) return [];
    this.finished = true;
    return this.drain(true);
  }

  drain(final) {
    const events = [];

    while (this.buffer) {
      if (this.activeTag) {
        const closeIndex = this.buffer.toLowerCase().indexOf(this.activeTag.close);
        if (closeIndex >= 0) {
          const value = this.buffer.slice(0, closeIndex);
          if (value) events.push({ kind: "text", text: value });
          this.buffer = this.buffer.slice(closeIndex + this.activeTag.close.length);
          this.activeTag = null;
          continue;
        }

        if (final) {
          events.push({ kind: "text", text: this.buffer });
          this.buffer = "";
          this.activeTag = null;
          break;
        }

        const keep = tagPrefixSuffixLength(this.buffer, [this.activeTag.close]);
        const plain = this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        if (plain) events.push({ kind: "text", text: plain });
        break;
      }

      const next = earliestOpenTag(this.buffer);
      if (next) {
        const plain = this.buffer.slice(0, next.index);
        if (plain) events.push({ kind: "text", text: plain });
        this.buffer = this.buffer.slice(next.index + next.tag.open.length);
        this.activeTag = next.tag;
        continue;
      }

      if (final) {
        events.push({ kind: "text", text: this.buffer });
        this.buffer = "";
        break;
      }

      const keep = tagPrefixSuffixLength(this.buffer, ASSISTANT_TAGS.map((tag) => tag.open));
      const plain = this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      if (plain) events.push({ kind: "text", text: plain });
      break;
    }

    return events;
  }
}
