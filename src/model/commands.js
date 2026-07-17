export const COMMANDS = Object.freeze([
  ["tab new [title]", "Create and focus a new main workspace tab."],
  ["tab close [id]", "Close a main tab (the active tab by default)."],
  ["tab select <id>", "Focus a main tab."],
  ["app exit", "Close Auri."],
  ["subtab new <terminal|webview|viewer|clipboard|audio|video|settings|system|info>", "Create and focus a horizontal subtab."],
  ["subtab close [id]", "Close a horizontal subtab."],
  ["subtab select <id>", "Focus a horizontal subtab."],
  ["subtab reload [id]", "Reload a horizontal subtab."],
  ["subtab move-window [id]", "Move a web or file-viewer subtab into a standalone window."],
  ["subtab move-main [id]", "Return a standalone subtab to the main window."],
  ["folder cd <path>", "Change both folder and terminal working directory."],
  ["folder list [path]", "List a directory."],
  ["folder toggle <path>", "Expand or collapse a folder row."],
  ["folder sort <name|date|type>", "Sort the active folder listing."],
  ["folder create-file <name>", "Create an empty file in the active folder."],
  ["folder create-folder <name>", "Create a folder in the active folder."],
  ["folder info [path]", "Show folder size, disk, owner, and permission details."],
  ["file inspect <path>", "Select a file and show its floating preview."],
  ["file preview-pin <on|off>", "Keep or release the floating file preview when other UI is clicked."],
  ["file open <path>", "Open a file in a full viewer tab."],
  ["file external [path]", "Open a file with the operating system."],
  ["file serve [path]", "Serve the current folder over local HTTP and open the file in the web viewer."],
  ["terminal run <command...>", "Run a shell command in the active workspace."],
  ["ai ask <prompt...>", "Ask the selected AI with the current screenshot."],
  ["ai model add <name> <type> <model> <url> <key>", "Add an AI provider configuration."],
  ["ai model select <id>", "Select the AI model for the terminal."],
  ["ai model update <id> <name> <type> <model> <url> <key>", "Update an AI provider configuration."],
  ["ai model delete <id>", "Delete an AI provider configuration."],
  ["clipboard list", "Open clipboard history."],
  ["clipboard insert <id>", "Paste a clipboard item into the previously active application."],
  ["clipboard pin <id>", "Pin a clipboard item."],
  ["clipboard unpin <id>", "Unpin a clipboard item."],
  ["clipboard remove <id>", "Remove a clipboard item."],
  ["clipboard copy <text>", "Copy text to the system clipboard."],
  ["clipboard copy-item <id>", "Copy a clipboard history item back to the system clipboard."],
  ["clipboard edit <id> <text...>", "Replace the text of a clipboard history item."],
  ["clipboard info <id>", "Show details for a clipboard item (text stats or image type, resolution, and size)."],
  ["attachment add <path>", "Attach a local file to the next AI request."],
  ["attachment remove <id>", "Remove a prompt attachment."],
  ["input insert <text>", "Insert text into the focused prompt input."],
  ["transcript dismiss", "Close the completed voice-input text popup."],
  ["web open <url>", "Navigate the active webview."],
  ["web ask <prompt...>", "Ask the selected AI and show the reply in a floating panel on the web tab."],
  ["web ask-close", "Close the floating web AI reply panel."],
  ["web reload", "Reload the active webview."],
  ["web back", "Go back in the active webview."],
  ["web forward", "Go forward in the active webview."],
  ["web external", "Open the active web URL externally."],
  ["web download", "Download the active page."],
  ["web zoom-in", "Increase the active page zoom."],
  ["web zoom-out", "Decrease the active page zoom."],
  ["web zoom-reset", "Reset the active page zoom to 100%."],
  ["web bookmark [add [name] [url]|remove <id>]", "Open the add-bookmark dialog or manage bookmarks."],
  ["web bookmarks", "Show saved bookmarks."],
  ["web history [clear]", "Show or clear browser history."],
  ["web devtools", "Open developer tools for the active page."],
  ["live record start", "Start push-to-talk microphone input for the selected Live model."],
  ["live record stop", "Stop microphone input and send the captured turn to the Live API."],
  ["live record toggle", "Connect and record, or disconnect the active Live chat."],
  ["record audio", "Open audio recording."],
  ["record video", "Open video recording."],
  ["record start <audio|video>", "Start media capture."],
  ["record stop", "Stop the active media capture."],
  ["record pause", "Pause the active media capture."],
  ["record resume", "Resume the paused media capture."],
  ["record photo", "Capture a photo with the camera."],
  ["record mic <deviceId|default>", "Switch the recording microphone, including during a recording."],
  ["record mode <photo|video|screen>", "Switch the video recorder mode."],
  ["media attach <audio|video>", "Attach the latest recording to the prompt."],
  ["settings open", "Open Settings."],
  ["settings set <key> <value>", "Update an application setting."],
  ["settings priority-rules <open|close|toggle|search-toggle|filter> [query]", "Control and filter the saved process-priority settings list."],
  ["permission status", "Refresh OS media permission and Linux capture-service status."],
  ["permission request <microphone|screen-recording>", "Request OS media access or report a missing Linux capture service."],
  ["system open", "Open the System monitor."],
  ["system gpus", "Toggle GPU cards and GPU process monitoring."],
  ["system sort <cpu|port|name|pid|priority|ram|net|disk>", "Sort System monitor processes."],
  ["system search [keyword...]", "Filter the process list by keyword (space separates OR terms); empty clears."],
  ["system refresh", "Refresh System monitor statistics."],
  ["system select <pid>", "Select a System monitor process."],
  ["system priority <pid> <low|lower|lowest|normal|high|unset>", "Set or unset a remembered process priority."],
  ["system priority-auth <pid> <low|lower|lowest|normal|high> <sudo|root>", "Authorize a pending priority change without putting a password in command text."],
  ["system priority-rule set <process> <nice>|remove <process>", "Add, edit, or remove a saved executable priority rule."],
  ["system priority-rule suggest <query>|choose <path>", "Search PATH executables or select one for a new priority rule."],
  ["system kill <pid>", "Kill the selected System monitor process."],
  ["system open-path <pid>", "Open the selected process path externally."],
  ["system tunnel start <port> [--install]", "Start a Cloudflare HTTPS tunnel for a process port."],
  ["system tunnel stop <port>", "Stop the Cloudflare HTTPS tunnel for a process port."],
  ["info show", "Open the Info subtab."],
  ["info clear", "Clear notifications and errors."],
  ["browser", "Serve this UI at http://127.0.0.1:8899 and open it in the default web browser."],
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
  if (domain === "browser") return { domain: "browser", action: (tokens.shift() || "open").toLowerCase(), args: tokens };
  const action = tokens.shift();
  if (!action) throw new Error(`Choose an action for ${domain}. Try: auri help`);
  return { domain, action: action.toLowerCase(), args: tokens };
}

export function commandHelp() {
  const width = Math.max(...COMMANDS.map(([syntax]) => syntax.length));
  return COMMANDS.map(([syntax, description]) => `auri ${syntax.padEnd(width)}  ${description}`).join("\n");
}
