# Auri Agent Guide

## Common commands

Native development (esbuild watch + Tauri debug app):

```bash
npm run dev
```

Watch native development (starts a new independent Auri app process):

```bash
npm run native:watch
```

Browser-only preview without native capabilities:

```bash
npm run dev:web
```

Build a release bundle:

```bash
npm run tauri:build
```

Build and run the release app in the current terminal session on macOS or Linux:

```bash
npm run app
```

This file is the implementation contract for contributors and coding agents working on Auri.

## Non-negotiable workflow

1. Write the behavioral test first and run it to observe the expected failure.
2. Implement underlying logic before GUI rendering or click handling.
3. Every actionable GUI control must call a command from the central registry. Internal calls omit `auri`; public terminal calls include it.
4. Keep MVC boundaries: models are pure, controllers coordinate, views render, services/native modules perform side effects.
5. Route recoverable errors to the Info state and provide a visible local interaction response.
6. Never fake a native capability. Expose a clear unsupported/fallback result instead.
7. Run focused tests, then `npm run check` and `cargo check --manifest-path src-tauri/Cargo.toml`.


## Development instance safety

Before starting a new development app or watcher, check whether an Auri development instance is already running. Stop only the existing dev/watch process that would conflict with the new test run, and do not kill release-version Auri processes. A build plus a manually started dev app is preferred for verification when continuous watch mode is unnecessary.

## Local file web app contract

- Native folder-pane file clicks must execute `file open`, which resolves the active loopback server port and opens `/<absolute-path>?view=1`. Do not reintroduce separate native blob viewers for individual formats.
- Keep direct `/<absolute-path>` requests as raw file responses with byte-range support. Use `?view=1` for viewing, `?edit=1` for editing, and a query-free directory path for folder browsing.
- Folder pages put `..` first, navigate folders without leaving the web app, and open files in view mode. HTML preview must use the raw sibling-aware path so `./asset` references work.
- The embedded `src-tauri/src/core/viewer.html` is the shared native shell for text/HTML, image, audio, video, PDF, DOCX, 3D, and generic file fallbacks. Extend this shell instead of adding another native viewer implementation. `src/services/file-viewer-page.js` remains only the browser-capability fallback.
- Preview `.blend` through `/api/blend-preview`: invoke Blender directly without a shell, pass `--background --disable-autoexec`, enforce a bounded timeout, cache the generated GLB by source identity, and render it through the existing local Three.js `GLTFLoader`. Discover Blender from `AURI_BLENDER`, `PATH`, and documented platform paths. Never enable embedded Blender script auto-execution merely to preview a file.
- HTML capability support requires all three layers to stay aligned: the outer file-view iframe in `src/views/panels.js`, the inner raw-HTML iframe in `viewer.html`, and the server's same-origin `Permissions-Policy`. Keep the macOS camera/microphone/location usage descriptions current. Capability delegation must not be described or implemented as silently overriding browser, WebKit, OS, secure-context, or user consent decisions.
- Packaged/release builds prefer `8890`; debug/development builds start at `8895` and search later ports. A listener may be terminated only when it is positively identified as Auri debug/development. Never terminate packaged/release Auri or an unrelated process, and always return/use the selected port.
- Keep the server on loopback, canonicalize paths, reject traversal, bound uploads, and require the active local origin for save/convert POST routes.
- Reuse `files::convert_media_file` and `files::save_converted_media_file` for audio/video conversion. The persisted default bitrate is 4000 kbps under `auri-convert-bitrate`; apply codec-safe caps such as 320 kbps for MP3. Image PNG/JPG/WebP conversion stays in the viewer canvas path.
- When changing this subsystem, test URL generation and folder-click command routing in JavaScript, run the dependency-light Rust tests, run `cargo check`, and smoke-test fallback-port binding while preserving any release process on 8890. For Blender changes, create a disposable `.blend`, verify a valid GLB response and cached repeat, and render it through the browser when Blender is installed. For HTML capability changes, test the outer and inner frame delegation, response policy header, and platform usage declarations together.
- macOS Finder `Open With` uses the `public.data` document registration and `RunEvent::Opened`. Queue file URLs natively, drain them after frontend startup, and route every path through `file open` so each file creates a normal web-view subtab.

## Command-first rule

`src/model/commands.js` is the source of truth. Add a registry entry and tests before implementing a new GUI action. GUI handlers call `executeCommand()` through `runInternal()` rather than changing state or invoking hardware directly. OS ingress that cannot originate as text—such as a file picker returning a browser `File` object—may create an attachment object, but an equivalent path-based command must exist for automation.

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

When a command accepts paths, prompts, shell syntax, URLs, or secrets, test quoting, whitespace, empty optional values, and malformed input. Preserve raw shell and AI tails where their punctuation is semantically meaningful.

## MVC boundaries

- `src/model`: no DOM, network, filesystem, Tauri, or browser globals.
- `src/controllers/command-controller.js`: command semantics and state transitions.
- `src/controllers/app-controller.js`: DOM events and platform action adapters only.
- `src/views`: render state and expose input/read helpers; no business rules.
- `src/services`: side effects and capability detection.
- `src-tauri/src/core`: small native modules grouped by responsibility.
- `src-tauri/src/bin/auri.rs`: thin external CLI; it must send commands through the Unix socket rather than reproduce command behavior.

Keep source files focused. Split a module when unrelated responsibilities begin to accumulate; do not create catch-all utility files.

## Testing expectations

Add tests at the lowest useful layer:

- Parser/registry tests for command syntax.
- Reducer tests for state behavior.
- Controller tests proving GUI-equivalent commands use the same path.
- Pure helper tests for formatting, truncation, transcript parsing, codecs, and filenames.
- Rust core tests before dependency-light native utility changes.

Do not test pixels or automate the GUI when the behavior can be proven in the model/controller layer. After logic tests pass, perform a browser render smoke test for layout and runtime errors.

## Native implementation rules

Prefer Rust's standard library. Add a crate only when it provides substantial correctness, security, or platform value that would be unreasonable to reproduce. Validate paths and sizes at native boundaries. Use atomic temporary-file writes for settings and saved media. Never silently swallow permission, codec, capture, or command failures.

The external CLI socket must stay user-only, bounded, and line-break safe. Current incomplete native areas must remain honestly labeled: PTY sessions, OS-global wake shortcuts, realtime live API streaming, clipboard image monitoring, and guaranteed audio/video transcoding.

## UI rules

- Keep the System table scan-friendly: compact Name, RAM constrained to an about-seven-character display, Port wide enough for two port badges, Net/Disk metrics next, PID at the far right, and reset table scroll to top after sort changes.

- Preserve the vertical workspace tabs and horizontal subtab model.
- Every workspace retains its own folder, terminal cwd/history, viewer, and subtab selection.
- Terminal remains the central panel.
- Enter inserts a newline; Command/Ctrl+Enter runs.
- Terminal path/URL previews belong in `TerminalSession`: parse clicked xterm buffer cells or drag selections, resolve `./` and `../` against the session `cwd`, position the roughly 300 px card below the anchor or above when space is tight, and route card opening through `file open` or a fresh `webview` plus `web open`. Preserve context-menu selection copy. Keep website iframe previews best-effort because remote embedding policy may block them; the card must still open the URL in a real web subtab.
- Use Unicode icons only when system fonts reliably render them; retain accessible labels and tooltips.
- Keep the aurora-light, modern, clean visual language and avoid boxes around every element.
- Every click has hover, pressed, focus, busy, success, or error feedback as appropriate.
- Clipboard text longer than 150 characters renders the first 100 and last 50 characters only. Clipboard image Info must show the complete persisted image path; the path is a command-backed copy target and successful clicks show a `Copied` toast.
- Unrenderable content and network errors also appear in Info.
- Assistant reply actions recognize only the two allowlisted command and input-ready markers. Escape every extracted value and never render arbitrary assistant HTML.
- Reuse an active Gemini Live wake connection for later shortcut or hold-to-talk turns. Refresh the screenshot and microphone input without reconnecting, and honor `liveDisconnectSeconds` exactly within its validated range.
- Record sanitized AI request metadata in Info after media preparation. Never store API keys or base64 payloads there; expose only text, names, MIME types, safe paths, and preview URLs.

## Completion checklist

- New test failed first for the intended reason.
- Model/controller implementation passes the focused test.
- GUI uses the command, not duplicated logic.
- New command appears in the registry and all three command-reference documents.
- Errors reach Info.
- Keyboard and accessibility labels still work.
- Browser preview degrades clearly.
- `npm run check` passes.
- `cargo check --manifest-path src-tauri/Cargo.toml` passes.
- Browser render smoke test has no JavaScript runtime errors.
auri live record toggle                                                       Connect and record, or disconnect the active Live chat.
