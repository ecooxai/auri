# Auri

Current release: **v0.7** (package version `0.7.0`).

## Common commands

Start guarded native development with restart-on-change watching:

```bash
npm run dev
```

Build a release bundle:

```bash
npm run tauri:build
```

Build and run the release app in the current terminal session on macOS or Linux:

```bash
npm run app
```

The first run compiles the release app. Later runs from the same checkout use a stable local build identity and preserve unchanged generated frontend files, allowing Cargo to reuse its release build instead of recompiling `auri`. Set `AURI_BUILD_ID` to override the local identity when needed.

Package the already-built Linux executable as a downloadable archive:

```bash
npm run release:linux
```

The Linux archive preserves the executable bit and includes `Auri`, `Auri.desktop`, an icon, launch instructions, and SHA-256 checksums. Current Linux artifacts are built and tested on an Arch Linux-based x86_64 host and dynamically link to its GTK/WebKitGTK stack, so Debian and Ubuntu may not work until distribution-specific builds are published. More Linux builds are coming soon.

Auri is a terminal-centered assistant workspace for macOS and Linux, built with Rust and Tauri. Its interface combines browser-like workspaces, a synchronized folder pane, terminal and AI composer, file inspection and viewing, webviews, clipboard history, settings, and audio/video capture.

The project follows a command-first MVC design: every meaningful GUI action maps to a text command. A user types the public form (`auri tab new`), while internal GUI code calls the same command without the `auri` prefix (`tab new`). This keeps behavior testable and makes automation predictable.

## Current status

This repository is a working application foundation, not a claim that every advanced desktop feature is complete.

Implemented now:

- Vertical main workspaces and readable 60–100px horizontal subtabs. Terminal, Clipboard, System, and Info use the short labels `Term`, `Copym`, `Sys`, and `Info`. Clicking a tab icon focuses that tab before opening Reload, standalone/main-window movement, and Close actions; focusing an off-screen tab centers it in the horizontal strip.
- Per-workspace folder pane synchronized with terminal `cwd`.
- The folder pane keeps navigation actions first with the editable current path directly below in bold, omits redundant pane and item-type labels, and lets long file or folder names wrap to their full height instead of clipping after three lines.
- Startup always selects the first workspace and its first terminal, synchronizes that terminal `cwd` with the folder pane, and keeps a System monitor subtab pre-opened in the first workspace.
- The System monitor's `GPUs` toggle replaces Disk/Swap/Uptime with one card per detected GPU, reveals that GPU's processes on card hover, and switches the table to GPU-owning processes. Linux merges NVIDIA compute and graphics clients from `nvidia-smi` and derives Intel/AMD ownership and per-process engine usage from DRM fdinfo. A combined GPU column shows entries such as `Intel (25%) · NV (1.0%)`; process detail adds one usage/VRAM/RAM card per GPU. Counters the driver does not expose remain visibly unavailable.
- Every terminal subtab owns its own working directory. Selecting a terminal refreshes its native PTY `pwd`, preserves the terminal you switched away from, and opens the folder pane at the selected terminal path without sending an automatic `cd`.
- Folder file inspection uses a two-step flow: the first click selects the file and opens a floating mini preview over the current panel, while clicking the same row again opens the full loopback viewer. File opens reuse the workspace's existing full file-viewer tab instead of accumulating one tab per file. Image and video mini previews preserve the source aspect ratio, cap height at 500px, and reduce width proportionally for tall media so the full frame remains visible. Audio and video start automatically in both mini and full views. Compact media previews show only the player, without repeating file identity. Inspection includes size, type, image dimensions, and optional `ffprobe` codec/bitrate metadata.
- A loopback cloud-disk file web app with folder browsing, text/HTML editing, raw file serving, PDF/DOCX/3D/media viewers, and image/audio/video conversion.
- Shell command execution and explicit `cd` synchronization.
- Terminal composer where Enter inserts a newline and Command/Ctrl+Enter runs.
- Clicked terminal paths, recognized bare filenames such as `notes.md`, nested relative file paths such as `assets/photo.png`, trailing-slash relative folders such as `dir1/dir2/`, and HTTP(S) URLs open a compact chrome-free preview near the text. Click hit-testing reconstructs the complete logical xterm line across soft-wrapped display rows, so a long filename remains whole even when it occupies several visual lines. Drag selections first treat the complete selected text as one filename or path—including unquoted spaces such as `Screenshot 2026-07-08 at 09.22.36.png`—then fall back to scanning for contained absolute, `~/`, `./`, `../`, recognized file, and trailing-slash relative-folder targets. Implicit filenames resolve against that terminal session's current working directory and stay limited to common media, text/web, programming-language, document/archive, PDF, and 3D extensions so dotted prose, version numbers, domains, flags, and assignments are ignored. Folder targets use the query-free local folder browser to show their contents, and clicking that preview navigates through the shared `folder cd` command; file and URL previews continue to open new file or web subtabs. The preview has no duplicate filename/status/close header; click outside or press Escape to dismiss it. Image paths show only the raw image, while other targets retain their normal embedded viewer surface. Right-click selection copy remains unchanged.
- OpenAI-compatible and Gemini-compatible text/image requests, including the current screenshot when enabled.
- Assistant replies can expose allowlisted shell-command and input-ready actions in a floating panel, with Run, Insert, and Copy controls.
- Local model/settings management and an Info tab for errors, notices, and sanitized AI request details with text plus playable image/audio previews.
- Clipboard text and image history with the 100 + 50 character long-text preview rule; image Info shows the full stored file path, and clicking that path copies it with a visible confirmation.
- Audio/video recording through the WebView media APIs, with native persistence under `~/auri/media`.
- Native screenshot capture, workspace creation, local configuration, file access, and external file opening.
- A real external `auri` CLI that sends commands to the running desktop app over a user-only Unix socket.
- Web tabs left in the background for 30 seconds sleep to disk: their state is saved under the app data directory and their webview is destroyed so its WebKit content process releases memory. A toast announces the sleep, and reopening the tab restores it from disk with another toast. File-viewer tabs never sleep because they can hold unsaved editor state.
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

Native file opening is unified through Auri's loopback-only cloud-disk web app, with the same folder-pane interaction on macOS and Linux. The first file click reuses the terminal path preview's compact floating card just beyond the folder pane's right edge without creating a tab; its default width is 45% of the viewport with a 225px minimum. Direct image and video previews replace the default fixed height with their intrinsic aspect ratio, capped at 500px or the viewport edge, and derive a narrower width when tall media reaches that cap. The second click opens or reuses the workspace's single full file-viewer tab, and the third closes that file tab, returns to the previous subtab, and restores the floating preview. The shared file viewer renders content first with its toolbar along the bottom. Its filename area is capped at the smaller of 200px and 50% of the toolbar, displays the first 40 and last 10 characters when long, and copies the complete filename when clicked. Folder and Edit/View are icon actions, while Download and media conversion live in More. Compact-height layouts anchor video, audio, text, documents, and 3D content at the top. Audio and video start automatically in mini preview. File pages place a small 50%-transparent dark information overlay with white text over the content: compact file size for all files, decoded resolution for images/video, video bitrate in `mbps`, and audio bitrate in `kbps`, without field labels. Native inspection returns lightweight directory metadata as well as file metadata, so the first folder click visibly selects its row and shows its query-free directory browser in the same floating card; the second enters the folder and synchronizes the active terminal path. Browser-only preview mode keeps the blob-backed capability fallback.

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

On Linux, Settings reports capture readiness instead of macOS privacy states. Auri queries PulseAudio/PipeWire sources directly (without a shell), distinguishes hardware microphone inputs from `.monitor` system-audio sources, and validates the current X11 display or Wayland desktop portal before marking screen capture ready. Actual WebKit capture can still present its own source chooser or consent prompt when recording starts.

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

This starts an isolated frontend watcher and launches the Tauri debug app with full native capabilities. It uses the repository's Node watcher and does not require `cargo-watch`. Source changes use a trailing 10-second debounce: every new change resets the timer, then the watcher stops only its currently owned debug process group before Cargo rebuilds and starts the replacement. Set `AURI_WATCH_DELAY` to another non-negative number of seconds when a different debounce is needed.

Browser-only preview (no Tauri):

```bash
npm run dev:web
```

Open `http://localhost:4173`. Preview mode supports the full interface and safe simulated/basic commands, but native filesystem, screenshot, global OS integration, and unrestricted shell features require `npm run dev` or `npm run tauri:dev`.

`npm run native:watch` is an alias for the same guarded development launcher. The launcher uses its own frontend server, temporary build identity, and command socket.

Agent development launch rule:

Before starting, the guarded launcher stops every process owned by the previous project-specific development launcher, then acquires the project lock and starts a fresh watcher and debug app. Release binaries under `target/release` or packaged `Auri.app` paths are deliberately ignored and are never stopped or replaced. The isolated frontend server watches bundled JavaScript and recopies root HTML, CSS, favicon, and browser-overlay assets so each guarded restart uses current files. `npm run tauri:dev` remains a low-level direct Tauri command, so contributors must perform a manual existing-instance check before using it.

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
auri subtab reload [id]                                                        Reload a horizontal subtab.
auri subtab move-window [id]                                                   Move a web or file-viewer subtab into a standalone window.
auri subtab move-main [id]                                                     Return a standalone subtab to the main window.
auri folder cd <path>                                                          Change both folder and terminal working directory.
auri folder list [path]                                                        List a directory.
auri folder toggle <path>                                                     Expand or collapse a folder row.
auri folder sort <name|date|type>                                             Sort the active folder listing.
auri folder create-file <name>                                                Create an empty file in the active folder.
auri folder create-folder <name>                                              Create a folder in the active folder.
auri folder info [path]                                                        Show folder size, disk, owner, and permission details.
auri file inspect <path>                                                       Select a file and show its floating preview.
auri file preview-pin <on|off>                                                  Keep or release the floating preview when other UI is clicked.
auri file open <path>                                                          Open a file in a full unified local HTTP viewer tab.
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
auri settings priority-rules <open|close|toggle|search-toggle|filter> [query]  Control and filter the saved process-priority settings list.
auri permission status                                                         Refresh OS media permission and Linux capture-service status.
auri permission request <microphone|screen-recording>                       Request OS media access or report a missing Linux capture service.
auri system open                                                              Open the System monitor.
auri system gpus                                                              Toggle GPU cards and GPU process monitoring.
auri system sort <cpu|port|name|pid|priority|ram|net|disk>                             Sort System monitor processes.
auri system search [keyword...]                                                   Filter the process list by keyword (space separates OR terms); empty clears.
auri system refresh                                                           Refresh System monitor statistics.
auri system select <pid>                                                    Select a System monitor process.
auri system priority <pid> <low|lower|lowest|normal|high|unset>             Set or unset a remembered process priority.
auri system priority-auth <pid> <low|lower|lowest|normal|high> <sudo|root>  Authorize a pending priority change; the password is read outside command text.
auri system priority-rule set <process> <nice>|remove <process>              Add, edit, or remove a saved executable priority rule (-20 through 19).
auri system priority-rule suggest <query>|choose <path>                      Search PATH executables or select one for a new priority rule.
auri system kill <pid>                                                      Kill the selected System monitor process.
auri system open-path <pid>                                                 Open the selected process path externally.
auri system tunnel start <port> [--install]                              Start a Cloudflare HTTPS tunnel for a process port.
auri system tunnel stop <port>                                           Stop the Cloudflare HTTPS tunnel for a process port.
auri info show                                                                 Open the Info subtab.
auri info clear                                                                Clear notifications and errors.
auri browser                                                                   Serve this UI at http://127.0.0.1:8899 and open it in the default web browser.
auri help                                                                      Show all available commands.
```

System monitor UI note: process lists sort and filter the complete native snapshot first, then render exactly one 10-process page. Scrolling down at the bottom replaces the table with the next page, and scrolling up at the top returns to the previous page instead of growing the DOM. The System title shows disabled-at-the-edge `<` and `>` page buttons around `Page X / Y`; explicit button clicks are not wheel-throttled. Refreshes preserve the current page and clamp it only when the filtered result set becomes shorter. Command/Ctrl+F or `/` focuses keyboard search, and CPU, RAM, network, disk, and port sorting always considers every matching process, not only the current page. Keep the process table Name column at twice the previous width (`minmax(240px, 3fr)`) so short process names stay readable before truncation; disk and network process tables share the same grid. The selected-process detail shows listening ports below the path field, one port per row. Each port can start or stop a confirmed Cloudflare `cloudflared` HTTPS tunnel; Auri checks `PATH` and `~/.local/bin`, can install supported macOS/Linux binaries to `~/.local/bin` after confirmation, closes the confirmation prompt into a per-port starting/stopping state, shows the generated `trycloudflare.com` URL beside the port, and copies that URL when clicked. The automatic 5-second system snapshot poll may keep `state.system` current while another subtab is active, but it must not re-render inactive tabs or recreate focused terminal, AI, settings, folder, or editor inputs; only the active System, Disk, or Net monitor view refreshes live.

The last process column shows native nice priority while PID remains in the scrollable detail dialog. Low (`10`), Lower (`15`), Lowest (`19`, the lowest scheduling priority supported by Linux and macOS), Normal (`1`), and High (`-10`) rules are saved by canonical executable path and reapplied to later processes launched from that same binary after each system snapshot as well as by the minute enforcement pass. The priority-rule editor sits collapsed at the bottom of Settings; when expanded, its add form comes first, saved rules can be filtered, and typing four or more characters searches executable files from the native `PATH` without invoking a shell. Users can add, edit, or remove identities and any valid nice value from `-20` through `19`. Unset removes only the saved rule and leaves the running process unchanged. On Linux, protected-process permission failures open an ephemeral sudo-password prompt and fall back to a root-password prompt when sudo is missing or fails; credentials are cleared after use and are never placed in command text, settings, or Info. Repeated Priority-header clicks alternate low-to-high and high-to-low ordering. Intel GPU usage uses sysfs when available and otherwise calculates real engine-busy deltas from readable DRM fdinfo. The folder pane discovers changes every three seconds and promotes new entries; direct image mini previews add a compact white `KB width×height` badge over 70%-opaque black.

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

## Terminal UI (`auri cli`)

`auri` (or `auri cli`) opens an interactive terminal UI. With a running desktop app it mirrors it live: the GUI publishes a JSON snapshot of every workspace, subtab, terminal buffer, and the system monitor into the native layer after each change, and the TUI watches that stream over the per-instance Unix socket. Selecting a workspace or subtab in one frontend selects it in the other. Without a running app the TUI hosts sessions itself, tmux-style: real PTYs, the real system monitor, and the shared clipboard history live inside the CLI process and end with it (the status line says "standalone" instead of pretending to mirror).

- Workspace chips with their folder names sit horizontally at the top, above the subtab bar; click a chip or subtab to focus it. `↑/↓` (or `k/j`) select the workspace, `←/→` or `Tab` select the subtab — the GUI follows when mirrored.
- The terminal panel shows the shared terminal buffer. Clicking the terminal (or `r`) readies a one-line prompt that runs through `auri terminal run`; `a` attaches the full PTY session raw into your terminal (interactive programs work; `Ctrl+]` detaches). The mouse wheel scrolls the buffer.
- The System panel mirrors CPU/RAM/NET/DISK metrics and the sorted, filtered process table. Click a column header (CPU, RAM, NET, DISK, PORT, PID, NAME) to sort by it, click a row to select the process; `s` cycles the sort, `/` edits the shared search filter, `R` refreshes.
- The Clipboard panel lists the shared clipboard history with pinned state and previews; click an item to copy it back to the system clipboard, and scroll with the wheel.
- Drag with the mouse to select rendered text anywhere; a selection of four or more characters is copied to the clipboard two seconds after release (click to cancel), through the app, the local clipboard, or OSC 52 as a last resort.
- `:` runs any Auri command from the registry, `g` focuses the GUI window, `q` quits.
- Web, viewer, media, and settings subtabs stay selected and in sync but render in the GUI window; the TUI says so instead of pretending.

TUI-issued commands use a quiet socket form that does not steal focus to the GUI window.

## Browser UI (`auri browser`, port 8899)

`auri browser` asks the running app to serve the full Auri UI at `http://127.0.0.1:8899` and opens it in the default web browser (later visits can simply open that address; the GUI command `auri browser` does the same from the prompt). The page is the same frontend as the desktop window: native calls route over a local HTTP bridge and terminal output streams over server-sent events, so terminals, the folder pane, the system monitor, clipboard history, files, and AI all work. The browser session is a second frontend sharing the same native backend — it keeps its own workspaces and does not overwrite the desktop window's published app state. Web subtabs cannot embed a WebKit view inside a browser page, so opening one opens a plain new browser tab instead (one named tab per subtab, re-used on navigation). The server only accepts loopback connections and rejects non-local `Host` headers.

## App lifecycle from the CLI

- `auri` / `auri cli` — open the terminal UI (mirror of the running app, or standalone).
- `auri browser` — serve and open the browser UI.
- `auri stop` — stop the running Auri app.
- `auri restart` — restart the app backend, wait for its command socket to return, then open the terminal UI.

## Background tabs live as state, not DOM

Only the focused subtab renders. A background terminal releases its emulator and DOM entirely and lives on as its recorded output (the PTY keeps running and the record keeps growing); refocusing replays the record into a fresh emulator. A background web tab writes its state to disk and drops its WebKit content process after a ~2 s grace period, and is recreated from that state on focus. Leaving the System monitor drops the heavy process list from memory and re-fetches it on return. The same recorded state feeds the JSON snapshot that the CLI/TUI mirrors.

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

On Linux, Auri keeps ownership of clipboard data alive after copying or selecting a history item, then switches to the previously focused application and sends its normal paste shortcut. X11 uses `xdotool`, Wayland prefers `wtype`, and `ydotool` is the fallback. Injection failures return to the Info panel while the selected value remains available for manual paste.
auri live record toggle                                                       Connect and record, or disconnect the active Live chat.
