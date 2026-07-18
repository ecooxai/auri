# Auri Claude Guide

This file is the implementation contract for contributors and coding agents working on Auri.

## Non-negotiable workflow

1. Write the behavioral test first and run it to observe the expected failure.
2. Implement underlying logic before GUI rendering or click handling.
3. Every actionable GUI control must call a command from the central registry. Internal calls omit `auri`; public terminal calls include it.
4. Keep MVC boundaries: models are pure, controllers coordinate, views render, services/native modules perform side effects.
5. Route recoverable errors to the Info state and provide a visible local interaction response.
6. Never fake a native capability. Expose a clear unsupported/fallback result instead.
7. Run focused tests, then `npm run check` and `cargo check --manifest-path src-tauri/Cargo.toml`.

## Startup and system monitor contract

- Startup must select the first restored workspace and its first terminal subtab, mirror that terminal working directory into the folder pane, and ensure the first workspace contains a pre-opened System monitor subtab.
- Process monitor views must sort and search the full snapshot before pagination. Render 15 process rows initially, append 15 near the scroll boundary, reset paging when search or sort changes, and keep CPU, RAM, network, disk, and port sorts independent of the visible slice.
- Keep keyboard search available on System, Disk, and Net with Command/Ctrl+F and `/`; Escape closes the focused search field.

## Command-first rule

`src/model/commands.js` is the source of truth. Add a registry entry and tests before implementing a new GUI action. GUI handlers call `executeCommand()` through `runInternal()` rather than changing state or invoking hardware directly. OS ingress that cannot originate as text—such as a file picker returning a browser `File` object—may create an attachment object, but an equivalent path-based command must exist for automation.

```text
auri tab new [title]                                                           Create and focus a new main workspace tab.
auri tab close [id]                                                            Close a main tab (the active tab by default).
auri tab select <id>                                                           Focus a main tab.
auri subtab new <terminal|webview|viewer|clipboard|audio|video|settings|system|info>  Create and focus a horizontal subtab.
auri subtab close [id]                                                         Close a horizontal subtab.
auri subtab select <id>                                                        Focus a horizontal subtab.
auri folder cd <path>                                                          Change both folder and terminal working directory.
auri folder list [path]                                                        List a directory.
auri folder toggle <path>                                                     Expand or collapse a folder row.
auri file inspect <path>                                                       Show file metadata; repeat to open it.
auri file open <path>                                                          Open a file in the viewer.
auri file external [path]                                                      Open a file with the operating system.
auri file serve [path]                                                         Serve the current folder over local HTTP and open the file in the web viewer.
auri terminal run <command...>                                                 Run a shell command in the active workspace.
auri ai ask <prompt...>                                                        Ask the selected AI with the current screenshot.
auri ai model add <name> <type> <model> <url> <key>                            Add an AI provider configuration.
auri ai model select <id>                                                      Select the AI model for the terminal.
auri ai model update <id> <url> <key>                                          Update a model endpoint and API key.
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
auri system sort <cpu|port|name|pid|ram|net|disk>                                      Sort System monitor processes.
auri system search [keyword...]                                                   Filter the process list by keyword (space separates OR terms); empty clears.
auri system refresh                                                           Refresh System monitor statistics.
auri system select <pid>                                                    Select a System monitor process.
auri system kill <pid>                                                      Kill the selected System monitor process.
auri system open-path <pid>                                                 Open the selected process path externally.
auri system tunnel start <port> [--install]                              Start a Cloudflare HTTPS tunnel for a process port.
auri system tunnel stop <port>                                           Stop the Cloudflare HTTPS tunnel for a process port.
auri info show                                                                 Open the Info subtab.
auri info clear                                                                Clear notifications and errors.
auri browser                                                                   Serve this UI at http://127.0.0.1:8899 and open it in the default web browser.
auri help                                                                      Show all available commands.
```

When a command accepts paths, prompts, shell syntax, URLs, or secrets, test quoting, whitespace, empty optional values, and malformed input. Preserve raw shell and AI tails where their punctuation is semantically meaningful.

## State snapshot and CLI mirror

- Background subtabs must live as serializable state, never as retained DOM: background terminals sleep (`TerminalSession.sleep()` — PTY and output records stay, emulator and DOM go), background web tabs sleep to disk and drop their WebKit process after a short grace, and leaving the System monitor trims the process list from state.
- After every state change the controller mirrors the full app state as one JSON line (`src/model/snapshot.js` → `sync_app_state`). The command socket serves it: `__auri_state__` (one-shot), `__auri_watch__` (stream), `__auri_quiet__:<command>` (execute without focusing the GUI), `__auri_term_attach__:<sessionId>` (raw PTY bridge), `__auri_term_resize__:<sessionId>:<cols>:<rows>` (shared-PTY grid), `__auri_copy__:<base64>` (clipboard copy), `__auri_serve_ui__` (start the browser UI server, replies `ok:<url>`), `__auri_quit__` (stop the app), `__auri_appinfo__` (pid + executable, for `auri restart`).
- `auri cli` (or bare `auri`) is a TUI client of that snapshot and socket. It renders state and sends registry commands; it must never reimplement command behavior or fake a panel it cannot render (say "renders in the GUI window" instead). Without a running app it hosts real local sessions itself, tmux-style (`src-tauri/src/cli/local.rs` + `session_state.rs`), reusing the same tauri-free core modules — real PTYs, monitor, and clipboard, honestly labeled standalone.
- The TUI terminal panel is a real terminal: entering it (click, Enter, `r`/`i`/`a`) attaches the shared PTY raw, renders through the std-only VT emulator (`src-tauri/src/core/vt.rs`), resizes the PTY to the panel, and seeds the last 100 buffer lines; Ctrl+B returns to normal mode and restores the GUI's PTY grid. Workspace chips render as a 1-based index plus the folder name — default "Home"/"Space N" titles collapse to just the number (`screen::workspace_label`).
- GUI and browser terminals have no frontend emulator: the app backend hosts one `VtScreen` per PTY session (`core/term_emulator.rs`), and the frontends render its styled frames as plain HTML rows (`terminal_frame`/`terminal_scrollback` invokes, refreshed on `terminal-data` events; key input encoded by `src/services/terminal-screen.js`). Mounts render only the last 100 scrollback lines (`TERMINAL_RENDER_TAIL_LINES`) and load older rows when the user scrolls to the top. GUI message blocks print through `terminal_print` (emulator + broadcast, never PTY stdin). Shells launch with an app-managed rc (bare `%`/`$` prompt, OSC 777 cwd marker).
- The browser UI (`auri browser`, `core/webserver.rs`) serves the same frontend at `http://127.0.0.1:8899`: static assets plus `POST /__auri__/invoke/<command>` routed to the same tauri command functions and `GET /__auri__/events` (SSE) for terminal events. Loopback binding with `Host`-header validation only. The hosted web session is a second frontend: it never publishes `sync_app_state`, never receives external `auri-command` events, and opens web subtabs as plain browser tabs instead of embedded webviews.
- The hosted web session is a live mirror of the desktop window: it seeds from `GET /__auri__/state`, follows `app-state` SSE frames (`MIRROR_WORKSPACES_SYNC` reconciles tabs by snapshot ids while local panel state survives), adopts the GUI's PTY sessions (`TerminalSession.adopt` — adopt-only sessions never start, resize, or stop the shared PTY), and forwards mirrored-state commands (`tab`, `subtab`, `terminal`, `web`, `settings`, `info`, `folder cd` — `mirrorForwardsCommand`) to the desktop window via `POST /__auri__/command`, which emits `auri-command` without focusing the window. Everything else (native reads, system sorts, media, AI) runs locally over the invoke bridge.
- CLI lifecycle: `auri stop` quits the running app, `auri restart` relaunches its executable and re-enters the TUI, bare `auri` opens the TUI.

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

- Preserve the vertical workspace tabs and horizontal subtab model.
- Every workspace retains its own folder, terminal cwd/history, viewer, and subtab selection.
- Terminal remains the central panel.
- Enter inserts a newline; Command/Ctrl+Enter runs.
- Use Unicode icons only when system fonts reliably render them; retain accessible labels and tooltips.
- Keep the aurora-light, modern, clean visual language and avoid boxes around every element.
- Every click has hover, pressed, focus, busy, success, or error feedback as appropriate.
- Clipboard text longer than 150 characters renders the first 100 and last 50 characters only.
- Unrenderable content and network errors also appear in Info.

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
