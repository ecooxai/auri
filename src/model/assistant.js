export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function parseAssistantReply(reply) {
  const source = String(reply ?? "");
  const transcripts = [];
  const text = source.replace(/<i>([\s\S]*?)<\/i>/gi, (_, value) => {
    transcripts.push(value.trim());
    return "";
  }).trim();
  return { transcripts, text };
}
