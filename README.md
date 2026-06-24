# Auri

Auri is a terminal-centered assistant workspace for macOS and Linux, built with Rust and Tauri. Its interface combines browser-like workspaces, a synchronized folder pane, terminal and AI composer, file inspection and viewing, webviews, clipboard history, settings, and audio/video capture.

The project follows a command-first MVC design: every meaningful GUI action maps to a text command. A user types the public form (`auri tab new`), while internal GUI code calls the same command without the `auri` prefix (`tab new`). This keeps behavior testable and makes automation predictable.

## Current status

This repository is a working application foundation, not a claim that every advanced desktop feature is complete.

Implemented now:

- Vertical main workspaces and horizontal subtabs.
- Per-workspace folder pane synchronized with terminal `cwd`.
- File inspection with size, type, image dimensions, and optional `ffprobe` codec/bitrate metadata.
- Text, image, audio, and video viewer paths.
- Shell command execution and explicit `cd` synchronization.
- Terminal composer where Enter inserts a newline and Command/Ctrl+Enter runs.
- OpenAI-compatible and Gemini-compatible text/image requests, including the current screenshot when enabled.
- `<i>spoken text</i>` assistant reply rendering with insert and copy actions.
- Local model/settings management and an Info tab for errors and notices.
- Clipboard text history with the 100 + 100 character long-text preview rule.
- Audio/video recording through the WebView media APIs, with native persistence under `~/auri/media`.
- Native screenshot capture, workspace creation, local configuration, file access, and external file opening.
- A real external `auri` CLI that sends commands to the running desktop app over a user-only Unix socket.
- Browser preview mode with safe capability fallbacks.

Not complete yet:

- The terminal backend is process-based, not a PTY. Interactive full-screen programs such as `top`, `htop`, editors, and password prompts need a PTY session layer.
- The Alt+Space hold gesture works while Auri receives keyboard events; OS-global shortcut registration is not yet implemented.
- Gemini Live and OpenAI Live model types are configurable, but true bidirectional realtime audio streaming is not yet implemented; current AI requests use the normal HTTP completion/generation paths.
- Clipboard persistence currently captures text. Native image clipboard monitoring and deduplication remain to be added.
- Recording prefers MP4/M4A when the WebView supports it and falls back to WebM. Guaranteed 64 kbps M4A transcoding requires a native encoder/transcode stage.
- Linux screenshot capture expects `gnome-screenshot` or `grim`; JPEG conversion uses `ffmpeg` when available.

## Architecture

```text
src/
  model/                 Pure state and parsing logic
    commands.js          Command registry, parser, raw-tail extraction
    state.js             Immutable application reducer and workspace model
    assistant.js         Safe assistant response and <i> transcript parsing
    clipboard.js         Clipboard serialization and preview rules
    presentation.js      Pure display helpers
  controllers/
    command-controller.js  Single command execution path for GUI and automation
    app-controller.js      Event orchestration and capability adapters
  services/
    backend.js           Browser/Tauri bridge and AI HTTP clients
    media-recorder.js    MediaRecorder capability wrapper
  views/
    app-view.js          Top-level view lifecycle
    panels.js            Modular panel renderers

src-tauri/src/core/
  workspace.rs           ~/auri and ~/.config/auri initialization
  files.rs               Directory, metadata, preview, attachment, media storage
  shell.rs               Shell process execution and cwd synchronization
  capture.rs             macOS/Linux screenshot capture
  clipboard.rs           Persistent clipboard text history
  ipc.rs                 macOS/Linux external CLI command bridge
  util.rs                Dependency-light base64, MIME, path, and CLI helpers

src-tauri/src/bin/
  auri.rs                External terminal command client
```

The model never imports DOM or Tauri APIs. Controllers dispatch model events. Views render state and emit intents. Native operations stay behind `Backend` and Tauri commands.

## Test-driven workflow

1. Add or change a behavior test first.
2. Run the smallest relevant test and confirm that it fails for the expected reason.
3. Implement the pure model or controller behavior.
4. Wire GUI controls to the same underlying command—do not duplicate the logic in the view.
5. Run the focused test, then the complete suite.
6. Run the production frontend build and Rust compiler check.
7. Render the browser preview for visual and interaction sanity checks.

Common commands:

```bash
npm test
npm run test:rust
npm run check
cargo check --manifest-path src-tauri/Cargo.toml
```

`npm run check` runs JavaScript tests, dependency-light Rust core tests, and the frontend production build.

## Development

Prerequisites:

- Node.js 20 or newer.
- A current stable Rust toolchain.
- Tauri 2 CLI for native development: `cargo install tauri-cli --version '^2'`.
- macOS: Xcode Command Line Tools.
- Linux: the Tauri/WebKitGTK development packages for your distribution.

Browser preview:

```bash
npm run dev
```

Open `http://localhost:4173`. Preview mode supports the full interface and safe simulated/basic commands, but native filesystem, screenshot, global OS integration, and unrestricted shell features require Tauri.

Native development:

```bash
npm run tauri:dev
```

Install the external CLI on your `PATH`:

```bash
npm run cli:install
auri tab new Research
```

The desktop app must be running. The CLI reconnects through `~/.config/auri/command.sock`, restores quoting for arguments containing spaces, focuses the main window, and sends the command through the same controller used by GUI clicks. Source builds install the CLI separately; release packaging should install or expose the `auri` binary on the user's `PATH`.

Production build:

```bash
npm run tauri:build
```

Tauri places platform bundles under `src-tauri/target/release/bundle/`. Sign and notarize macOS builds, and package/test Linux bundles on each target distribution before release.

## Data layout

```text
~/auri/
  media/
    picture/             Screenshots and images
    audio/               Audio recordings
    video/               Video recordings
  subtabs/               Reserved for persisted subtab data
  clipboard/
    history.json         Clipboard history

~/.config/auri/
  settings.json          Models, API keys, and preferences
  command.sock           User-only external CLI socket while Auri runs
```

API keys are stored locally in the settings file. They are not committed by this project, but the file is currently plain JSON; protect your user account and filesystem permissions. Supplying a key in a terminal command can also leave it in shell or terminal history, so the Settings UI is preferable for secrets.

## Command interface

The public form starts with `auri` and works from the embedded terminal or the installed external CLI. Inside the application, GUI code calls the same command without that prefix.

```text
auri tab new [title]                                                           Create and focus a new main workspace tab.
auri tab close [id]                                                            Close a main tab (the active tab by default).
auri tab select <id>                                                           Focus a main tab.
auri subtab new <terminal|webview|viewer|clipboard|audio|video|settings|info>  Create and focus a horizontal subtab.
auri subtab close [id]                                                         Close a horizontal subtab.
auri subtab select <id>                                                        Focus a horizontal subtab.
auri folder cd <path>                                                          Change both folder and terminal working directory.
auri folder list [path]                                                        List a directory.
auri file inspect <path>                                                       Show file metadata; repeat to open it.
auri file open <path>                                                          Open a file in the viewer.
auri file external [path]                                                      Open a file with the operating system.
auri terminal run <command...>                                                 Run a shell command in the active workspace.
auri ai ask <prompt...>                                                        Ask the selected AI with the current screenshot.
auri ai model add <name> <type> <model> <url> <key>                            Add an AI provider configuration.
auri ai model select <id>                                                      Select the AI model for the terminal.
auri ai model update <id> <url> <key>                                          Update a model endpoint and API key.
auri clipboard list                                                            Open clipboard history.
auri clipboard insert <id>                                                     Paste a clipboard item into the previously active application.
auri clipboard copy <text>                                                     Copy text to the system clipboard.
auri attachment add <path>                                                     Attach a local file to the next AI request.
auri attachment remove <id>                                                    Remove a prompt attachment.
auri input insert <text>                                                       Insert text into the focused prompt input.
auri web open <url>                                                            Navigate the active webview.
auri web reload                                                                Reload the active webview.
auri web back                                                                  Go back in the active webview.
auri web forward                                                               Go forward in the active webview.
auri web external                                                              Open the active web URL externally.
auri record audio                                                              Open audio recording.
auri record video                                                              Open video recording.
auri record start <audio|video>                                                Start media capture.
auri record stop                                                               Stop the active media capture.
auri media attach <audio|video>                                                Attach the latest recording to the prompt.
auri settings open                                                             Open Settings.
auri settings set <key> <value>                                                Update an application setting.
auri info show                                                                 Open the Info subtab.
auri info clear                                                                Clear notifications and errors.
auri help                                                                      Show all available commands.
```

Examples:

```bash
auri tab new Research
auri subtab new webview
auri folder cd ~/Projects
auri terminal run printf '%s %s\\n' hello Auri
auri web open https://example.org
auri clipboard list
auri attachment add ~/Pictures/reference.png
auri ai ask Summarize the current screen and attached file
auri info show
```

Paths or values containing spaces should be quoted. Shell command tails and AI prompt tails preserve their original punctuation and quoting.

## Error handling

Expected failures are shown both near the current interaction and in the Info subtab. Network errors, missing API keys, unsupported media capabilities, file access failures, malformed assistant output, and native capability failures should never silently disappear. A fallback message belongs in Info whenever content cannot be rendered in its intended panel.

## Performance guidelines

- Keep state transformations pure and incremental.
- Truncate clipboard previews before rendering.
- Avoid reading text files larger than 2 MB into the viewer.
- Limit inline binary attachments to 32 MB and saved recordings to 256 MB.
- Keep panel rendering modular; do not add unrelated behavior to `panels.js`.
- Move long-running native operations off the UI thread when adding PTY, transcoding, or realtime streaming.

## Visual design

The interface uses a light aurora palette, translucent surfaces, minimal separators, Unicode symbols with system-font fallbacks, and explicit press/hover/focus feedback. Buttons use icons where their meaning is standard; text remains where an icon alone would be ambiguous or unsafe.
