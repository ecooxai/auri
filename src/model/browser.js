const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;

function stripAccidentalUrlQuoting(value) {
  let url = String(value ?? "").trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const quoted = url.match(/^(["'])([\s\S]*)\1$/);
    if (quoted) {
      url = quoted[2].trim();
      continue;
    }
    const doubled = url.match(/^https?:\/\/["']?(https?:\/\/[\s\S]+?)["']?$/i);
    if (doubled) {
      url = doubled[1].trim();
      continue;
    }
    break;
  }
  return url;
}

export function normalizeWebUrl(rawUrl) {
  let url = stripAccidentalUrlQuoting(rawUrl);
  if (!url) throw new Error("Enter a URL.");
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = `https://${url}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Enter a valid web URL.");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  return url;
}

export function defaultBookmarkName(rawUrl) {
  try {
    const url = normalizeWebUrl(rawUrl);
    return new URL(url).hostname || "Bookmark";
  } catch {
    return "Bookmark";
  }
}

export function titleForWebUrl(rawUrl) {
  try {
    const url = normalizeWebUrl(rawUrl);
    return new URL(url).hostname || "Web";
  } catch {
    return "Web";
  }
}

export function nextWebZoom(current, direction) {
  if (direction === "reset") return 1;
  const value = Number(current) || 1;
  const delta = direction === "out" ? -ZOOM_STEP : ZOOM_STEP;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((value + delta) * 100) / 100));
}

export function webZoomPercent(value) {
  return `${Math.round((Number(value) || 1) * 100)}%`;
}

const BUILTIN_WEB_AI_ITEMS = Object.freeze([
  { id: "ask", label: "Ask", prompt: "{text}", speak: false },
  {
    id: "translate",
    label: "Translate",
    prompt: "Translate the following. If it is not in English translate it to English; if it is in English translate it to the user's likely native language based on the page context, otherwise to Chinese. Reply with the translation only.\n\n{text}",
    speak: false
  },
  {
    id: "tts",
    label: "Speak",
    prompt: "Read the following text aloud verbatim. Do not add commentary.\n\n{text}",
    speak: true
  }
]);

/// Parse custom web-AI prompts from settings. One prompt per line in the form
/// "Label | prompt template"; "{text}" inside the template is replaced with
/// the selected text.
export function webAiMenuItems(customText = "") {
  const custom = String(customText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const separator = line.indexOf("|");
      if (separator <= 0) return null;
      const label = line.slice(0, separator).trim();
      const prompt = line.slice(separator + 1).trim();
      if (!label || !prompt) return null;
      return { id: `custom-${index}`, label, prompt, speak: false };
    })
    .filter(Boolean);
  return [...BUILTIN_WEB_AI_ITEMS, ...custom];
}

export function webAiMenuPayload(customText = "") {
  return JSON.stringify(webAiMenuItems(customText).map(({ id, label }) => ({ id, label })));
}

export function webAiPrompt(item, payload = {}) {
  const text = String(payload.text || "").trim();
  let prompt = String(item?.prompt || "{text}");
  prompt = prompt.includes("{text}") ? prompt.replaceAll("{text}", text) : `${prompt}\n\n${text}`;
  if (payload.kind === "image" && !text) {
    prompt = prompt.trim() || "Describe this image.";
    if (payload.imageUrl && !payload.image) prompt += `\n\nImage URL: ${payload.imageUrl}`;
  }
  return prompt.trim();
}
