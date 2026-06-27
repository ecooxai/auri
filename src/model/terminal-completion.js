function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function words(value) {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function damerauLevenshtein(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let index = 0; index <= a.length; index += 1) rows[index][0] = index;
  for (let index = 0; index <= b.length; index += 1) rows[0][index] = index;
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = a[row - 1] === b[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + substitution
      );
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        rows[row][column] = Math.min(rows[row][column], rows[row - 2][column - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

function closestPrefixDistance(query, candidate) {
  const minLength = Math.max(1, query.length - 2);
  const maxLength = Math.min(candidate.length, query.length + 2);
  let best = Number.POSITIVE_INFINITY;
  for (let length = minLength; length <= maxLength; length += 1) {
    best = Math.min(best, damerauLevenshtein(query, candidate.slice(0, length)));
  }
  return best;
}

function tokenMatchCost(queryToken, candidateToken) {
  if (queryToken === candidateToken) return 0;
  if (candidateToken.startsWith(queryToken)) return 0.12;
  const distance = closestPrefixDistance(queryToken, candidateToken);
  const allowed = queryToken.length >= 5 ? 2 : 1;
  return distance <= allowed ? distance : Number.POSITIVE_INFINITY;
}

function tokenSequenceScore(query, candidate) {
  const queryWords = words(query);
  const candidateWords = words(candidate);
  if (!queryWords.length || !candidateWords.length || queryWords.length > candidateWords.length) return null;
  const memo = new Map();
  const visit = (queryIndex, candidateIndex) => {
    if (queryIndex >= queryWords.length) return 0;
    if (candidateIndex >= candidateWords.length) return Number.POSITIVE_INFINITY;
    const key = `${queryIndex}:${candidateIndex}`;
    if (memo.has(key)) return memo.get(key);
    let best = visit(queryIndex, candidateIndex + 1) + 0.18;
    const cost = tokenMatchCost(queryWords[queryIndex], candidateWords[candidateIndex]);
    if (Number.isFinite(cost)) best = Math.min(best, cost + visit(queryIndex + 1, candidateIndex + 1));
    memo.set(key, best);
    return best;
  };
  const cost = visit(0, 0);
  return Number.isFinite(cost) ? 690 - cost * 55 : null;
}

function scoreCandidate(query, candidate, recencyIndex = 0) {
  const normalizedQuery = normalize(query);
  const normalizedCandidate = normalize(candidate);
  if (!normalizedQuery || !normalizedCandidate) return null;
  const recencyBonus = Math.max(0, 40 - recencyIndex * 4);
  if (normalizedCandidate === normalizedQuery) return 1200 + recencyBonus;
  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return 1050 - Math.min(20, (normalizedCandidate.length - normalizedQuery.length) * 0.15) + recencyBonus;
  }
  const containsAt = normalizedCandidate.indexOf(normalizedQuery);
  if (containsAt >= 0) return 880 - containsAt * 4 + recencyBonus;
  const prefixDistance = closestPrefixDistance(normalizedQuery, normalizedCandidate);
  const allowedDistance = normalizedQuery.length >= 6 ? 2 : 1;
  let best = prefixDistance <= allowedDistance
    ? 790 - prefixDistance * 70 - Math.abs(normalizedCandidate.length - normalizedQuery.length) * 0.2
    : Number.NEGATIVE_INFINITY;
  const tokenScore = tokenSequenceScore(normalizedQuery, normalizedCandidate);
  if (tokenScore !== null) best = Math.max(best, tokenScore);
  return Number.isFinite(best) ? best + recencyBonus : null;
}

function shellQuoteCompletion(value) {
  const text = String(value ?? "");
  if (/^[\p{L}\p{N}_@%+=:,./-]+$/u.test(text)) return text;
  const quote = String.fromCharCode(39);
  return `${quote}${text.replaceAll(quote, `${quote}\\${quote}${quote}`)}${quote}`;
}

function completionTokenContext(value) {
  const input = String(value ?? "");
  const match = input.match(/([^\s]*)$/u);
  const rawToken = match?.[1] || "";
  const prefix = input.slice(0, input.length - rawToken.length);
  const token = rawToken.replace(/^['"]/, "");
  return { prefix, token };
}

export function terminalCompletionContext(value, cursor) {
  const input = String(value ?? "");
  const position = typeof cursor === "number" && Number.isFinite(cursor)
    ? Math.min(input.length, Math.max(0, Math.trunc(cursor)))
    : input.length;
  const beforeCursor = input.slice(0, position);
  const lineBreak = Math.max(beforeCursor.lastIndexOf("\n"), beforeCursor.lastIndexOf("\r"));
  const start = lineBreak + 1;
  return { query: input.slice(start, position), start, end: position };
}

function commandLines(value) {
  if (Array.isArray(value)) return value;
  return String(value ?? "").split(/\r?\n/);
}

function commandCandidates(query, values, { kind, detail, sourceBonus }) {
  const seen = new Set();
  const candidates = [];
  for (const [index, entry] of commandLines(values).entries()) {
    const value = typeof entry === "string" ? entry : entry?.command;
    const normalizedValue = normalize(value);
    if (!normalizedValue || seen.has(normalizedValue)) continue;
    seen.add(normalizedValue);
    const score = scoreCandidate(query, normalizedValue, index);
    if (score === null) continue;
    const displayValue = String(value).trim();
    candidates.push({
      value: displayValue,
      label: displayValue,
      kind,
      detail,
      score: score + sourceBonus,
      sourceIndex: index
    });
  }
  return candidates;
}

function folderCandidates(query, entries) {
  const { prefix, token } = completionTokenContext(query);
  if (!token) return [];
  const seen = new Set();
  const candidates = [];
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const name = String(entry?.name ?? "").trim();
    const normalizedName = normalize(name);
    if (!normalizedName || seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    const score = scoreCandidate(token, normalizedName, index);
    if (score === null) continue;
    const kind = entry?.kind === "directory" ? "directory" : "file";
    const insertedName = kind === "directory" ? `${name}/` : name;
    candidates.push({
      value: `${prefix}${shellQuoteCompletion(insertedName)}`,
      label: name,
      kind,
      detail: "Current folder",
      score: score + 12,
      sourceIndex: index
    });
  }
  return candidates;
}

export function terminalCompletions(query, {
  history = [],
  shellHistory = [],
  customEntries = "",
  entries = [],
  limit = 8,
  cursor
} = {}) {
  const rawQuery = String(query ?? "");
  const context = terminalCompletionContext(rawQuery, cursor);
  const currentLineQuery = context.query;
  const normalizedQuery = normalize(currentLineQuery);
  if (normalizedQuery.length <= 2) return [];

  const ranked = [
    ...commandCandidates(currentLineQuery, history, { kind: "history", detail: "Workspace history", sourceBonus: 60 }),
    ...commandCandidates(currentLineQuery, customEntries, { kind: "custom", detail: "Custom", sourceBonus: 40 }),
    ...commandCandidates(currentLineQuery, shellHistory, { kind: "shell", detail: "Shell history", sourceBonus: 20 }),
    ...folderCandidates(currentLineQuery, entries)
  ];
  const seen = new Set();
  return ranked
    .sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex || left.value.localeCompare(right.value))
    .filter((item) => {
      const key = normalize(item.value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, Number(limit) || 8));
}

export function fuzzyCommandCompletions(query, history, limit = 8) {
  return terminalCompletions(query, { history, limit });
}
