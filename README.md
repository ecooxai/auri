# Auri

## Common commands

Watch native development (starts a new independent Auri app process):

```bash
npm run native:watch
```

Build a release bundle:

```bash
npm run tauri:build
```

Build and run the release app in the current terminal session on macOS or Linux:

```bash
npm run app
```

Auri is a terminal-centered assistant workspace for macOS and Linux, built with Rust and Tauri. Its interface combines browser-like workspaces, a synchronized folder pane, terminal and AI composer, file inspection and viewing, webviews, clipboard history, settings, and audio/video capture.

The project follows a command-first MVC design: every meaningful GUI action maps to a text command. A user types the public form (`auri tab new`), while internal GUI code calls the same command without the `auri` prefix (`tab new`). This keeps behavior testable and makes automation predictable.

## Current status

This repository is a working application foundation, not a claim that every advanced desktop feature is complete.

Implemented now:

- Vertical main workspaces and horizontal subtabs.
- Per-workspace folder pane synchronized with terminal `cwd`.
- File inspection with size, type, image dimensions, and optional `ffprobe` codec/bitrate metadata.
- A loopback cloud-disk file web app with folder browsing, text/HTML editing, raw file serving, PDF/DOCX/3D/media viewers, and image/audio/video conversion.
- Shell command execution and explicit `cd` synchronization.
- Terminal composer where Enter inserts a newline and Command/Ctrl+Enter runs.
- Clicked terminal paths and HTTP(S) URLs open a compact 300 px preview near the text; drag selections containing a target do the same. Relative `./` and `../` paths resolve against that terminal session's current working directory, and clicking the preview opens a new file or web subtab. Right-click selection copy remains unchanged.
- OpenAI-compatible and Gemini-compatible text/image requests, including the current screenshot when enabled.
- Assistant replies can expose allowlisted shell-command and input-ready actions in a floating panel, with Run, Insert, and Copy controls.
- Local model/settings management and an Info tab for errors, notices, and sanitized AI request details with text plus playable image/audio previews.
- Clipboard text history with the 100 + 100 character long-text preview rule.
- Audio/video recording through the WebView media APIs, with native persistence under `~/auri/media`.
- Native screenshot capture, workspace creation, local configuration, file access, and external file opening.
- A real external `auri` CLI that sends commands to the running desktop app over a user-only Unix socket.
- Browser preview mode with safe capability fallbacks.

Not complete yet:

- The terminal backend is process-based, not a PTY. Interactive full-screen programs such as `top`, `htop`, editors, and password prompts need a PTY session layer.
- The Alt+Space hold gesture works while Auri receives keyboard events; OS-global shortcut registration is not yet implemented.
- Gemini Live wake sessions support persistent multi-turn voice interaction. Repeated Alt+Space activation or hold-to-talk reuses the active connection, sends a fresh screenshot, resumes suspended audio after app switching, and uses the configured no-reply timeout before disconnecting.
- OpenAI Live remains configurable but does not yet provide a native bidirectional realtime session; its requests currently use the normal completion path.
- Clipboard persistence captures text and images through native polling. Event-driven clipboard monitoring and broader cross-platform deduplication remain to be added.
- Recording prefers MP4/M4A when the WebView supports it and falls back to WebM. Guaranteed 64 kbps M4A transcoding requires a native encoder/transcode stage.
- Linux screenshot capture expects `gnome-screenshot` or `grim`; JPEG conversion uses `ffmpeg` when available.

## Architecture

```text
src/
  model/                 Pure state and parsing logic
    commands.js          Command registry, parser, raw-tail extraction
    state.js             Immutable application reducer and workspace model
    assistant.js         Safe allowlisted assistant action parsing and streaming cleanup
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
  files.rs               Directory, metadata, preview, attachment, media storage and ffmpeg conversion
  fileserver.rs          Loopback cloud-disk HTTP server, safe port selection, routes, ranges, writes, conversion API
  viewer.html            Embedded folder browser, viewers, editor, and conversion UI
  shell.rs               Shell process execution and cwd synchronization
  capture.rs             macOS/Linux screenshot capture
  clipboard.rs           Persistent clipboard text/image history, pinning, retention, and paste-back
  ipc.rs                 macOS/Linux external CLI command bridge
  util.rs                Dependency-light base64, MIME, path, and CLI helpers

src-tauri/src/bin/
  auri.rs                External terminal command client
```

The model never imports DOM or Tauri APIs. Controllers dispatch model events. Views render state and emit intents. Native operations stay behind `Backend` and Tauri commands.

## Local file web app

Native file opening is unified through Auri's loopback-only cloud-disk web app. A click on a file in the folder pane opens the HTTP viewer immediately; browser-only preview mode keeps the blob-backed capability fallback.

URL contract:

```text
http://localhost:<port>/<absolute-path>           Raw file bytes, with HTTP range support.
http://localhost:<port>/<absolute-path>?view=1    File viewer.
http://localhost:<port>/<absolute-path>?edit=1    File editor.
http://localhost:<port>/<absolute-folder-path>    Folder browser.
```

Folders list `..` first, followed by directories and files. Directory links navigate inside the web app, file links use `?view=1`, and the viewer exposes an Edit action. HTML is previewed from its raw path inside the app so sibling references such as `./image.png` resolve naturally. Text/HTML, images, audio with waveform, video, PDF, DOCX, common Three.js model formats, Blender files, and generic browser-supported files share the same minimal aurora-light shell.

`.blend` files are converted on demand by Blender's own background exporter and then displayed by Auri's existing local Three.js/GLTFLoader viewer. Auri searches `AURI_BLENDER`, `blender` on `PATH`, the standard macOS Blender application path, and common Linux paths. The exporter runs with Blender auto-execution disabled, has a three-minute timeout, and caches the generated GLB by source path, size, and modification time. The first preview may take a few seconds; unchanged files reuse the cache. Install Blender or set `AURI_BLENDER` to the Blender executable when it is not discovered automatically.

HTML previews delegate common browser capabilities—including camera, microphone, location, screen capture, clipboard, fullscreen, USB, serial, HID, MIDI, and WebXR—through both Auri's outer file frame and the inner raw-document frame. The local server sends a matching same-origin `Permissions-Policy`, and the macOS bundle declares camera, microphone, and location usage. Delegation does not silently bypass consent: actual access still depends on the browser/WebKit implementation, operating-system privacy controls, secure-context rules, and the user's permission choice.

Packaged/release builds prefer port `8890`. Development/debug builds start at `8895` and search later ports, keeping them isolated from a running release app. Auri may stop only a listener that is positively identified as an Auri development/debug process; packaged release processes and unrelated listeners are never terminated. The frontend always uses the port returned by the native server rather than assuming a fixed address.

Image conversion supports PNG, JPG, and WebP in the browser. Audio supports WAV, M4A, MP3, and MP4 waveform video; video supports MP4, MP3, WAV, and M4A through the existing native ffmpeg pipeline. The selected audio/video bitrate is persisted in local storage under `auri-convert-bitrate`; the default is `4000` kbps (4 Mbps), with codec-safe limits such as 320 kbps for MP3. Native audio/video conversion requires `ffmpeg` on `PATH`.

The server binds only to `127.0.0.1`, canonicalizes filesystem paths, rejects traversal, bounds request bodies, and requires the active local viewer origin for write and conversion requests.

On macOS, the app registers as an alternate viewer for `public.data`, so Finder’s **Open With → Auri** is available for images, audio, video, text, 3D models, and other files. Each opened file is queued safely during startup and creates its own existing Auri web-view tab through the same `file open` command used by the folder pane and CLI.

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

Native development:

```bash
npm run dev
```

This starts the esbuild frontend watcher and launches the Tauri debug app with full native capabilities.

Browser-only preview (no Tauri):

```bash
npm run dev:web
```

Open `http://localhost:4173`. Preview mode supports the full interface and safe simulated/basic commands, but native filesystem, screenshot, global OS integration, and unrestricted shell features require `npm run dev` or `npm run tauri:dev`.

For restart-on-change development, `npm run native:watch` launches an independent Auri process with its own frontend server, temporary build identity, and command socket. Starting it again does not stop or replace another running watcher or Auri window.

Agent development launch rule:

Before starting a new development app or watcher, check for existing Auri development instances and stop only those dev/watch processes when they would conflict with the new run. Do not kill or replace release-version Auri processes. Prefer a build plus a manually started dev app for task verification when continuous watch mode is not needed.

Install the external CLI on your `PATH`:

```bash
npm run cli:install
auri tab new Research
```

The desktop app must be running. Each process owns a socket under `~/.config/auri/instances/`; the CLI selects the most recently started reachable instance, restores quoting for arguments containing spaces, focuses that window, and sends the command through the same controller used by GUI clicks. Set `AURI_COMMAND_SOCKET` to a specific socket path when several instances are running and you need an exact target. Source builds install the CLI separately; release packaging should install or expose the `auri` binary on the user's `PATH`.

Production build:

```bash
npm run tauri:build
```

Tauri places platform bundles under `src-tauri/target/release/bundle/`. The npm build wrapper assigns every packaged build an independent application identifier so opening one build does not activate or terminate another. Set `AURI_BUILD_ID` when a stable, repeatable identifier is required for a release channel. Sign and notarize macOS builds, and package/test Linux bundles on each target distribution before release.

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
  instances/
    command-<pid>.sock   User-only external CLI socket for each Auri process
```

API keys are stored locally in the settings file. They are not committed by this project, but the file is currently plain JSON; protect your user account and filesystem permissions. Supplying a key in a terminal command can also leave it in shell or terminal history, so the Settings UI is preferable for secrets.

## Command interface

The public form starts with `auri` and works from the embedded terminal or the installed external CLI. Inside the application, GUI code calls the same command without that prefix.

```text
auri tab new [title]                                                           Create and focus a new main workspace tab.
auri tab close [id]                                                            Close a main tab (the active tab by default).
auri tab select <id>                                                           Focus a main tab.
auri app exit                                                                 Close Auri.
auri subtab new <terminal|webview|viewer|clipboard|audio|video|settings|system|info>  Create and focus a horizontal subtab.
auri subtab close [id]                                                         Close a horizontal subtab.
auri subtab select <id>                                                        Focus a horizontal subtab.
auri folder cd <path>                                                          Change both folder and terminal working directory.
auri folder list [path]                                                        List a directory.
auri folder toggle <path>                                                     Expand or collapse a folder row.
auri folder sort <name|date|type>                                             Sort the active folder listing.
auri folder create-file <name>                                                Create an empty file in the active folder.
auri folder create-folder <name>                                              Create a folder in the active folder.
auri folder info [path]                                                        Show folder size, disk, owner, and permission details.
auri file inspect <path>                                                       Show file metadata; repeat to open it.
auri file open <path>                                                          Open a file in the unified local HTTP viewer.
auri file external [path]                                                      Open a file with the operating system.
auri file serve [path]                                                         Open a file or folder in the loopback cloud-disk web app.
auri terminal run <command...>                                                 Run a shell command in the active workspace.
auri ai ask <prompt...>                                                        Ask the selected AI with the current screenshot.
auri ai model add <name> <type> <model> <url> <key>                            Add an AI provider configuration.
auri ai model select <id>                                                      Select the AI model for the terminal.
auri ai model update <id> <name> <type> <model> <url> <key>                    Update an AI provider configuration.
auri ai model delete <id>                                                      Delete an AI provider configuration.
auri clipboard list                                                            Open clipboard history.
auri clipboard insert <id>                                                     Paste a clipboard item into the previously active application.
auri clipboard pin <id>                                                       Pin a clipboard item.
auri clipboard unpin <id>                                                     Unpin a clipboard item.
auri clipboard remove <id>                                                    Remove a clipboard item.
auri clipboard copy <text>                                                     Copy text to the system clipboard.
auri clipboard copy-item <id>                                                  Copy a clipboard history item back to the system clipboard.
auri clipboard edit <id> <text...>                                             Replace the text of a clipboard history item.
auri clipboard info <id>                                                       Show details for a clipboard item (text stats or image type, resolution, and size).
auri attachment add <path>                                                     Attach a local file to the next AI request.
auri attachment remove <id>                                                    Remove a prompt attachment.
auri input insert <text>                                                       Insert text into the focused prompt input.
auri transcript dismiss                                                        Close the completed voice-input text popup.
auri web open <url>                                                            Navigate the active webview.
auri web ask <prompt...>                                                       Ask the selected AI and show the reply in a floating panel on the web tab.
auri web ask-close                                                             Close the floating web AI reply panel.
auri web reload                                                                Reload the active webview.
auri web back                                                                  Go back in the active webview.
auri web forward                                                               Go forward in the active webview.
auri web external                                                              Open the active web URL externally.
auri web download                                                                Download the active page.
auri web zoom-in                                                                 Increase the active page zoom.
auri web zoom-out                                                                Decrease the active page zoom.
auri web zoom-reset                                                              Reset the active page zoom to 100%.
auri web bookmark [add [name] [url]|remove <id>]                                 Open the add-bookmark dialog or manage bookmarks.
auri web bookmarks                                                               Show saved bookmarks.
auri web history [clear]                                                         Show or clear browser history.
auri web devtools                                                                Open developer tools for the active page.
auri live record start                                                        Start push-to-talk microphone input for the selected Live model.
auri live record stop                                                         Stop microphone input and send the captured turn to the Live API.
auri record audio                                                              Open audio recording.
auri record video                                                              Open video recording.
auri record start <audio|video>                                                Start media capture.
auri record stop                                                               Stop the active media capture.
auri record pause                                                              Pause the active media capture.
auri record resume                                                             Resume the paused media capture.
auri record photo                                                              Capture a photo with the camera.
auri record mic <deviceId|default>                                             Switch the recording microphone, including during a recording.
auri record mode <photo|video|screen>                                          Switch the video recorder mode.
auri media attach <audio|video>                                                Attach the latest recording to the prompt.
auri settings open                                                             Open Settings.
auri settings set <key> <value>                                                Update an application setting.
auri permission status                                                         Refresh macOS media permission status.
auri permission request <microphone|screen-recording>                       Request or open macOS settings for a media permission.
auri system open                                                              Open the System monitor.
auri system sort <cpu|port|name|pid|ram|net>                                      Sort System monitor processes.
auri system search [keyword...]                                                   Filter the process list by keyword (space separates OR terms); empty clears.
auri system refresh                                                           Refresh System monitor statistics.
auri system select <pid>                                                    Select a System monitor process.
auri system kill <pid>                                                      Kill the selected System monitor process.
auri system open-path <pid>                                                 Open the selected process path externally.
auri system tunnel start <port> [--install]                              Start a Cloudflare HTTPS tunnel for a process port.
auri system tunnel stop <port>                                           Stop the Cloudflare HTTPS tunnel for a process port.
auri info show                                                                 Open the Info subtab.
auri info clear                                                                Clear notifications and errors.
auri help                                                                      Show all available commands.
```

System monitor UI note: keep the process table Name column at twice the previous width (`minmax(240px, 3fr)`) so short process names stay readable before truncation; disk and network process tables share the same grid. The selected-process detail shows listening ports below the path field, one port per row. Each port can start or stop a confirmed Cloudflare `cloudflared` HTTPS tunnel; Auri checks `PATH` and `~/.local/bin`, can install supported macOS/Linux binaries to `~/.local/bin` after confirmation, closes the confirmation prompt into a per-port starting/stopping state, shows the generated `trycloudflare.com` URL beside the port, and copies that URL when clicked. The automatic 5-second system snapshot poll may keep `state.system` current while another subtab is active, but it must not re-render inactive tabs or recreate focused terminal, AI, settings, folder, or editor inputs; only the active System, Disk, or Net monitor view refreshes live.

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
- Truncate clipboard text longer than 150 characters to the first 100 and last 50 characters before rendering.
- Avoid reading text files larger than 2 MB into inline/browser fallback viewers; native files should stream through the loopback web app.
- Limit inline binary attachments to 32 MB and saved recordings to 256 MB.
- Keep panel rendering modular; do not add unrelated behavior to `panels.js`.
- Move long-running native operations off the UI thread when adding PTY, transcoding, or realtime streaming.

## Visual design

- Keep the System table scan-friendly: compact Name, RAM constrained to an about-seven-character display, Port wide enough for two port badges, Net/Disk metrics next, PID at the far right, and reset table scroll to top after sort changes.

The interface uses a light aurora palette, translucent surfaces, minimal separators, Unicode symbols with system-font fallbacks, and explicit press/hover/focus feedback. Buttons use icons where their meaning is standard; text remains where an icon alone would be ambiguous or unsafe.
auri live record toggle                                                       Connect and record, or disconnect the active Live chat.
