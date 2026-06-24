export function shellQuote(value) {
  return `'${String(value ?? "").replaceAll("'", `'"'"'`)}'`;
}

export function isSimpleCdCommand(command) {
  const trimmed = String(command ?? "").trim();
  if (!/^cd(?:\s|$)/.test(trimmed)) return false;
  return !/[;&|<>`\n]/.test(trimmed);
}
