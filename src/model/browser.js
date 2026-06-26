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
