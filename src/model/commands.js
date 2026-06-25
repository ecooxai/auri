export const COMMANDS = Object.freeze([
  ["tab new [title]", "Create and focus a new main workspace tab."],
  ["tab close [id]", "Close a main tab (the active tab by default)."],
  ["tab select <id>", "Focus a main tab."],
  ["subtab new <terminal|webview|viewer|clipboard|audio|video|settings|info>", "Create and focus a horizontal subtab."],
  ["subtab close [id]", "Close a horizontal subtab."],
  ["subtab select <id>", "Focus a horizontal subtab."],
  ["folder cd <path>", "Change both folder and terminal working directory."],
  ["folder list [path]", "List a directory."],
  ["folder sort <name|date|type>", "Sort the active folder listing."],
  ["folder create-file <name>", "Create an empty file in the active folder."],
  ["folder create-folder <name>", "Create a folder in the active folder."],
  ["folder info [path]", "Show folder size, disk, owner, and permission details."],
  ["file inspect <path>", "Show file metadata; repeat to open it."],
  ["file open <path>", "Open a file in the viewer."],
  ["file external [path]", "Open a file with the operating system."],
  ["terminal run <command...>", "Run a shell command in the active workspace."],
  ["ai ask <prompt...>", "Ask the selected AI with the current screenshot."],
  ["ai model add <name> <type> <model> <url> <key>", "Add an AI provider configuration."],
  ["ai model select <id>", "Select the AI model for the terminal."],
  ["ai model update <id> <name> <type> <model> <url> <key>", "Update an AI provider configuration."],
  ["ai model delete <id>", "Delete an AI provider configuration."],
  ["clipboard list", "Open clipboard history."],
  ["clipboard insert <id>", "Paste a clipboard item into the previously active application."],
  ["clipboard copy <text>", "Copy text to the system clipboard."],
  ["attachment add <path>", "Attach a local file to the next AI request."],
  ["attachment remove <id>", "Remove a prompt attachment."],
  ["input insert <text>", "Insert text into the focused prompt input."],
  ["web open <url>", "Navigate the active webview."],
  ["web reload", "Reload the active webview."],
  ["web back", "Go back in the active webview."],
  ["web forward", "Go forward in the active webview."],
  ["web external", "Open the active web URL externally."],
  ["record audio", "Open audio recording."],
  ["record video", "Open video recording."],
  ["record start <audio|video>", "Start media capture."],
  ["record stop", "Stop the active media capture."],
  ["media attach <audio|video>", "Attach the latest recording to the prompt."],
  ["settings open", "Open Settings."],
  ["settings set <key> <value>", "Update an application setting."],
  ["info show", "Open the Info subtab."],
  ["info clear", "Clear notifications and errors."],
  ["help", "Show all available commands."]
]);

function tokenize(input) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaping = false;
  let tokenStarted = false;

  for (const char of input.trim()) {
    if (escaping) {
      token += char;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (quote) throw new Error("Close the quoted value before running the command.");
  if (escaping) token += "\\";
  if (tokenStarted) tokens.push(token);
  return tokens;
}

export function extractActionTail(input, domain, action) {
  const source = String(input ?? "").trim().replace(/^auri\s+/i, "");
  const pattern = new RegExp(`^${domain}\\s+${action}(?:\\s+|$)([\\s\\S]*)$`, "i");
  const match = source.match(pattern);
  return match ? match[1] : "";
}

export function extractCommandTail(input) {
  return extractActionTail(input, "terminal", "run");
}

export function parseCommand(input) {
  const tokens = tokenize(String(input ?? ""));
  if (!tokens.length) throw new Error("Enter a command.");
  if (tokens[0].toLowerCase() === "auri") {
    tokens.shift();
    if (!tokens.length) throw new Error("Enter a command after auri.");
  }
  const domain = tokens.shift().toLowerCase();
  if (domain === "help") return { domain: "help", action: "show", args: [] };
  const action = tokens.shift();
  if (!action) throw new Error(`Choose an action for ${domain}. Try: auri help`);
  return { domain, action: action.toLowerCase(), args: tokens };
}

export function commandHelp() {
  const width = Math.max(...COMMANDS.map(([syntax]) => syntax.length));
  return COMMANDS.map(([syntax, description]) => `auri ${syntax.padEnd(width)}  ${description}`).join("\n");
}
