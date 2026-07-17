# Auri Agent Guide

Current release: **v0.7** (package version `0.7.0`).

## Common commands

Native development (esbuild watch + Tauri debug app):

```bash
npm run dev
```

Alias for the same guarded native development watcher:

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

`npm run app` uses a stable build identity derived from the checkout path unless `AURI_BUILD_ID` is set. Frontend build outputs must be written only when their content changes so an unchanged app invocation remains fresh in Cargo and does not recompile the native crate.

Package the already-built Linux release executable and checksum:

```bash
npm run release:linux
```

The Linux release archive must identify its version, architecture, and Arch Linux build base in the filename. It contains a directly executable `Auri` binary, colocated desktop launcher, icon, README compatibility warning, internal checksums, and an external archive checksum. Release notes must state that Debian/Ubuntu compatibility is not yet guaranteed and that more Linux builds are planned.

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

Use `npm run dev` (or its `npm run native:watch` alias) for normal native development. It has no `cargo-watch` dependency: the project-owned Node watcher starts the isolated frontend and its own `auri-dev` process group. Each invocation first stops every process owned by the previous project-specific development launcher, then starts a fresh watcher and debug app. The launcher must never match, stop, or replace a packaged app or any binary under `target/release`. Source changes use a trailing 10-second debounce; each additional change resets the timer, then the watcher terminates only the debug process group it owns before rebuilding and starting the replacement. The isolated frontend server keeps its temporary bundle current by watching JavaScript dependencies and recopying root HTML, CSS, favicon, and browser-overlay assets. `AURI_WATCH_DELAY` may override the delay with another non-negative number of seconds. `npm run tauri:dev` bypasses this guard and therefore requires a manual existing-instance check before use.

After `npm run dev` has started successfully, do not run it again for ordinary source changes. Keep that watcher running and rely on its automatic rebuild/restart behavior unless it has actually exited or an explicit manual relaunch is required.

## Local file web app contract

- Folder-pane clicks use the same preview cycle on macOS and Linux and must reuse `TerminalSession.showPreview`, including its compact chrome-free floating card, direct image/video modes, iframe viewer for other content, outside/Escape dismissal, and click-to-open behavior. Do not add a duplicate filename/status/close header to this card. The shared card defaults to 45% of the viewport width with a 225px minimum and a compact 220px height. Once image or video metadata loads, preserve its intrinsic aspect ratio: derive height from the available width, cap height at 500px or the viewport edge, and reduce width from that same ratio when the cap applies so the full frame remains visible. Folder-pane previews anchor just beyond the pane's right edge instead of covering file rows and must be repositioned after media sizing. A first file click performs command-backed floating inspection without creating a `viewer` subtab, a second click executes `file open` and reuses the workspace's existing full file-viewer subtab at `/<absolute-path>?view=1`, and a third click closes that file's web-view subtab, returns to the previously active subtab, and restores the floating preview. The controller-owned preview path remains authoritative across the preview's capture-phase outside-click dismissal only while that same row remains selected, so stale preview state cannot skip a newly selected item's first preview. Native `inspect_file` must return lightweight `directory`/`FOLDER` metadata for directories instead of rejecting them, because the command-backed first folder click depends on `FILE_SELECT` to visibly select the row before showing the query-free directory browser in that same floating preview; a second click navigates through the shared folder/terminal directory path. Video mini previews autoplay their raw loopback resource; audio autoplay delegates through the preview iframe. The embedded viewer renders file content first and its filename/path/action toolbar at the bottom; its filename block is at most 200px and 50% of the toolbar, truncates to the first 40 and last 10 characters, and copies the complete filename when clicked. Folder and Edit/View are icons, with Download and conversion in More. Compact-height video, audio, text, document, and 3D views stay anchored at the top. Its 50%-transparent black information overlay uses compact unlabeled values: size for every file, decoded resolution for images/video, estimated video bitrate in `mbps`, and estimated audio bitrate in `kbps`. Do not build a separate folder-pane mini-preview component or reintroduce native blob viewers for individual formats.
- Keep direct `/<absolute-path>` requests as raw file responses with byte-range support. Use `?view=1` for viewing, `?edit=1` for editing, and a query-free directory path for folder browsing.
- Folder pages put `..` first, navigate folders without leaving the web app, and open files in view mode. HTML preview must use the raw sibling-aware path so `./asset` references work.
- The embedded `src-tauri/src/core/viewer.html` is the shared native shell for text/HTML, image, audio, video, PDF, DOCX, 3D, and generic file fallbacks. Extend this shell instead of adding another native viewer implementation. `src/services/file-viewer-page.js` remains only the browser-capability fallback.
- Preview `.blend` through `/api/blend-preview`: invoke Blender directly without a shell, pass `--background --disable-autoexec`, enforce a bounded timeout, cache the generated GLB by source identity, and render it through the existing local Three.js `GLTFLoader`. Discover Blender from `AURI_BLENDER`, `PATH`, and documented platform paths. Never enable embedded Blender script auto-execution merely to preview a file.
- HTML capability support requires all three layers to stay aligned: the outer file-view iframe in `src/views/panels.js`, the inner raw-HTML iframe in `viewer.html`, and the server's same-origin `Permissions-Policy`. Keep the macOS camera/microphone/location usage descriptions current. Capability delegation must not be described or implemented as silently overriding browser, WebKit, OS, secure-context, or user consent decisions.
- Linux Settings must report real capture-service readiness rather than the macOS permission model: inspect PulseAudio/PipeWire sources without a shell, treat non-monitor sources as microphones and `.monitor` sources as system audio, and validate an accessible X11 display or Wayland desktop portal for screen capture. Do not describe service readiness as bypassing WebKit source selection or consent.
- Packaged/release builds prefer `8890`; debug/development builds start at `8895` and search later ports. A listener may be terminated only when it is positively identified as Auri debug/development. Never terminate packaged/release Auri or an unrelated process, and always return/use the selected port.
- Keep the server on loopback, canonicalize paths, reject traversal, bound uploads, and require the active local origin for save/convert POST routes.
- Reuse `files::convert_media_file` and `files::save_converted_media_file` for audio/video conversion. The persisted default bitrate is 4000 kbps under `auri-convert-bitrate`; apply codec-safe caps such as 320 kbps for MP3. Image PNG/JPG/WebP conversion stays in the viewer canvas path.
- When changing this subsystem, test URL generation and folder-click command routing in JavaScript, run the dependency-light Rust tests, run `cargo check`, and smoke-test fallback-port binding while preserving any release process on 8890. For Blender changes, create a disposable `.blend`, verify a valid GLB response and cached repeat, and render it through the browser when Blender is installed. For HTML capability changes, test the outer and inner frame delegation, response policy header, and platform usage declarations together.
- macOS Finder `Open With` uses the `public.data` document registration and `RunEvent::Opened`. Queue file URLs natively, drain them after frontend startup, and route every path through `file open` so each file creates a normal web-view subtab.

## Startup and system monitor contract

- Startup must select the first restored workspace and its first terminal subtab, mirror that terminal working directory into the folder pane, and ensure the first workspace contains a pre-opened System monitor subtab.
- System GPU mode is toggled only through `system gpus`. It keeps CPU/Memory/Net, replaces Disk/Swap/Uptime with one card per GPU, and pages only GPU-owning processes. Merge Linux NVIDIA compute and graphics clients from `nvidia-smi`; collect Intel/AMD ownership and per-process engine deltas from DRM fdinfo. Combine GPU name and use in one process column, and show per-GPU usage/VRAM/RAM cards in process detail. Never invent unavailable utilization or VRAM counters, and collect GPU data only while GPU mode is active.
- Process monitor views must sort and search the full snapshot before pagination. Render 15 process rows initially, append 15 near the scroll boundary, reset paging when search or sort changes, and keep CPU, RAM, network, disk, and port sorts independent of the visible slice.
- Keep keyboard search available on System, Disk, and Net with Command/Ctrl+F and `/`; Escape closes the focused search field.

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
auri help                                                                      Show all available commands.
```

System monitor UI note: process lists sort and filter the complete native snapshot first, then render exactly one 10-process page. Scrolling down at the bottom replaces the table with the next page, and scrolling up at the top returns to the previous page instead of growing the DOM. The System title shows disabled-at-the-edge `<` and `>` page buttons around `Page X / Y`; explicit button clicks are not wheel-throttled. Refreshes preserve the current page and clamp it only when the filtered result set becomes shorter. Command/Ctrl+F or `/` focuses keyboard search, and CPU, RAM, network, disk, and port sorting always considers every matching process, not only the current page. Keep the process table Name column at twice the previous width (`minmax(240px, 3fr)`) so short process names stay readable before truncation; disk and network process tables share the same grid. The selected-process detail shows listening ports below the path field, one port per row. Each port can start or stop a confirmed Cloudflare `cloudflared` HTTPS tunnel; Auri checks `PATH` and `~/.local/bin`, can install supported macOS/Linux binaries to `~/.local/bin` after confirmation, closes the confirmation prompt into a per-port starting/stopping state, shows the generated `trycloudflare.com` URL beside the port, and copies that URL when clicked. The automatic 5-second system snapshot poll may keep `state.system` current while another subtab is active, but it must not re-render inactive tabs or recreate focused terminal, AI, settings, folder, or editor inputs; only the active System, Disk, or Net monitor view refreshes live.

Process rows show the OS nice priority instead of repeating PID, which remains in the scrollable process-detail dialog. Its pinned bottom control stores Low (`10`), Lower (`15`), Lowest (`19`, the Linux/macOS minimum scheduling priority), Normal (`1`), or High (`-10`) by canonical executable path and reapplies saved rules to later processes from the same binary after each system snapshot and during the minute enforcement pass; Unset only removes the saved rule without modifying the running process. The command-backed priority-rule editor stays collapsed at the bottom of Settings, puts Add rule before the saved list when expanded, filters saved identities, and offers native `PATH` executable matches only after at least four typed characters; PATH discovery must not invoke a shell. Rules accept editable identity/nice values across the native `-20..19` range. Linux permission failures open an ephemeral sudo prompt and fall back to a root-password prompt when sudo is unavailable or fails. Credentials must be cleared after the native call and never enter command text, state, settings, logs, or Info. Repeated Priority-header clicks alternate low-to-high and high-to-low ordering. Linux Intel GPU utilization prefers driver sysfs counters and otherwise derives real engine-busy deltas from readable DRM fdinfo. The folder pane polls its current directory every three seconds, promotes newly discovered entries to the top, and refreshes changed metadata. Direct image mini previews show a top-right `KB width×height` badge on a 70%-opaque black background.

When a command accepts paths, prompts, shell syntax, URLs, or secrets, test quoting, whitespace, empty optional values, and malformed input. Preserve raw shell and AI tails where their punctuation is semantically meaningful.

## State snapshot and CLI mirror

- Background subtabs must live as serializable state, never as retained DOM: background terminals sleep (`TerminalSession.sleep()` — PTY and output records stay, emulator and DOM go), background web tabs sleep to disk and drop their WebKit process after a short grace, and leaving the System monitor trims the process list from state.
- After every state change the controller mirrors the full app state as one JSON line (`src/model/snapshot.js` → `sync_app_state`). The command socket serves it: `__auri_state__` (one-shot), `__auri_watch__` (stream), `__auri_quiet__:<command>` (execute without focusing the GUI), `__auri_term_attach__:<sessionId>` (raw PTY bridge).
- `auri cli` is a TUI client of that snapshot and socket. It renders state and sends registry commands; it must never reimplement command behavior or fake a panel it cannot render (say "renders in the GUI window" instead).

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

Do not test pixels or automate the GUI when the behavior can be proven in the model/controller layer. Terminal path-preview regressions belong in `tests/terminal-link-preview.test.js` for parsing, soft-wrap hit-testing, and selection behavior; folder first-click/repeat-click and new-tab command routing belong in `tests/controller.test.js`, floating preview markup belongs in `tests/minimal-ui.test.js`, query-free directory preview URLs belong in `tests/file-webview.test.js`, and command-backed terminal folder opening belongs in `tests/assistant-terminal-controller.test.js`. After logic tests pass, perform a browser render smoke test for layout and runtime errors.

## Native implementation rules

Prefer Rust's standard library. Add a crate only when it provides substantial correctness, security, or platform value that would be unreasonable to reproduce. Validate paths and sizes at native boundaries. Use atomic temporary-file writes for settings and saved media. Never silently swallow permission, codec, capture, or command failures.

The external CLI socket must stay user-only, bounded, and line-break safe. Current incomplete native areas must remain honestly labeled: PTY sessions, OS-global wake shortcuts, realtime live API streaming, clipboard image monitoring, and guaranteed audio/video transcoding.

## UI rules

- Keep the System table scan-friendly: compact Name, RAM constrained to an about-seven-character display, Port wide enough for two port badges, Net/Disk metrics next, PID at the far right, and reset table scroll to top after sort changes.

- Preserve the vertical workspace tabs and horizontal subtab model.
- Keep horizontal subtabs between 60px and 100px wide. Terminal, Clipboard, System, and Info use the short labels `Term`, `Copym`, `Sys`, and `Info`. Clicking the left icon must focus its tab before opening the command-backed Reload, standalone/main-window movement, and Close menu; do not add a separate right-side close button. When focus changes to a partially hidden tab, center it horizontally in the tab strip.
- Every workspace retains its own folder, terminal cwd/history, viewer, and subtab selection.
- Keep the folder pane compact: navigation icon actions come first, the editable path sits directly below in bold, and redundant `FILES`/folder-name headings and per-entry type glyphs stay omitted. File and folder names wrap without a line clamp so each row grows tall enough to show the complete name; directory expansion retains its separate accessible toggle.
- Every terminal subtab owns an independent `cwd`. Before switching away, refresh and store that terminal's native PTY `pwd`; after selecting another terminal, refresh its `pwd` and move the folder pane to that path. Never run `cd` merely because a terminal gained focus. Inactive terminal cwd notifications update only that terminal record and must not move the visible folder pane or overwrite the active terminal cwd.
- Terminal remains the central panel.
- Enter inserts a newline; Command/Ctrl+Enter runs.
- Terminal path/URL previews belong in `TerminalSession`: reconstruct the clicked logical xterm line by walking backward and forward through `isWrapped` buffer rows, while keeping the preview anchor on the actual clicked cell. Treat the complete drag selection as the first candidate so unquoted filenames and paths containing spaces stay intact; only when that exact selection is not a valid target should parsing scan for contained targets. Resolve absolute, `~/`, explicit `./` and `../`, recognized bare filenames and nested relative file paths, plus relative directory paths that end in `/`, against the session `cwd`; keep other implicit matching behind the common-file extension allowlist so dotted prose, versions, domains, flags, assignments, and unrelated URI schemes do not become file targets. Strip compiler-style `:line[:column]` suffixes before opening. Position the card below the anchor or above when space is tight, and recalculate placement after aspect-ratio media sizing. Files route through `file open`, URLs through a fresh `webview` plus `web open`, and directories preview with the query-free loopback folder URL before opening through the shared `folder cd` command. Native image and video previews must use the raw loopback resource URL and render only the media—no outer header or file-viewer filename/path chrome. Preserve context-menu selection copy. Keep website iframe previews best-effort because remote embedding policy may block them; the card must still open the URL in a real web subtab.
- Use Unicode icons only when system fonts reliably render them; retain accessible labels and tooltips.
- Keep the aurora-light, modern, clean visual language and avoid boxes around every element.
- Every click has hover, pressed, focus, busy, success, or error feedback as appropriate.
- Clipboard text longer than 150 characters renders the first 100 and last 50 characters only. Clipboard image Info must show the complete persisted image path; the path is a command-backed copy target and successful clicks show a `Copied` toast.
- Linux clipboard writes must retain a live native clipboard owner so X11/Wayland targets can request the selected data after focus changes. Paste-back uses `xdotool` on X11, prefers `wtype` on Wayland, falls back to `ydotool`, and reports injection failures through the command path instead of detaching and discarding them.
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
- README.md and AGENTS.md record important workflow, architecture, and behavior changes from the task.
auri live record toggle                                                       Connect and record, or disconnect the active Live chat.
