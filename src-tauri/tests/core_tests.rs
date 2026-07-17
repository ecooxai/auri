#[path = "../src/core/ipc.rs"]
mod ipc;

#[path = "../src/core/lifecycle.rs"]
mod lifecycle;

#[path = "../src/cli/ansi.rs"]
mod ansi;

#[path = "../src/cli/input.rs"]
mod input;

#[path = "../src/cli/view_model.rs"]
mod view_model;

#[path = "../src/cli/screen.rs"]
mod screen;

#[path = "../src/cli/session_state.rs"]
mod session_state;

#[path = "../src/core/state_sync.rs"]
mod state_sync;

#[path = "../src/core/term_bridge.rs"]
mod term_bridge;

#[path = "../src/core/util.rs"]
mod util;

#[path = "../src/cli/vt.rs"]
mod vt;

#[path = "../src/core/webserver.rs"]
mod webserver;

#[path = "../src/core/webview_sleep.rs"]
mod webview_sleep;

#[test]
fn base64_encoder_matches_standard_vectors() {
    assert_eq!(util::encode_base64(b""), "");
    assert_eq!(util::encode_base64(b"f"), "Zg==");
    assert_eq!(util::encode_base64(b"fo"), "Zm8=");
    assert_eq!(util::encode_base64(b"foo"), "Zm9v");
    assert_eq!(util::encode_base64(b"hello"), "aGVsbG8=");
}

#[test]
fn file_kinds_cover_supported_viewers() {
    assert_eq!(util::file_kind("photo.JPG"), "image");
    assert_eq!(util::file_kind("voice.m4a"), "audio");
    assert_eq!(util::file_kind("movie.webm"), "video");
    assert_eq!(util::file_kind("notes.md"), "text");
    assert_eq!(util::file_kind("scene.blend"), "model");
    assert_eq!(util::file_kind("archive.bin"), "file");
}

#[test]
fn mime_types_match_media_kind() {
    assert_eq!(util::mime_type("image.png"), "image/png");
    assert_eq!(util::mime_type("clip.mp4"), "video/mp4");
    assert_eq!(util::mime_type("readme.txt"), "text/plain");
    assert_eq!(util::mime_type("scene.blend"), "application/x-blender");
}

#[test]
fn base64_decoder_round_trips_binary_data() {
    let original = b"Auri\0media\xff";
    let encoded = util::encode_base64(original);
    assert_eq!(util::decode_base64(&encoded).unwrap(), original);
    assert!(util::decode_base64("not valid!").is_err());
}

#[test]
fn media_filenames_cannot_escape_the_storage_directory() {
    assert_eq!(util::safe_file_name("../bad/name.m4a"), "name.m4a");
    assert_eq!(util::safe_file_name("auri video.mp4"), "auri video.mp4");
}

#[test]
fn external_cli_normalizes_public_and_internal_commands() {
    assert_eq!(
        util::normalize_cli_command(&["tab".into(), "new".into(), "Work".into()]).unwrap(),
        "tab new Work"
    );
    assert_eq!(
        util::normalize_cli_command(&["auri".into(), "info".into(), "show".into()]).unwrap(),
        "info show"
    );
    assert!(util::normalize_cli_command(&[]).is_err());
    assert!(util::normalize_cli_command(&["tab\nnew".into()]).is_err());
}

#[test]
fn external_cli_requotes_arguments_containing_spaces() {
    assert_eq!(
        util::normalize_cli_command(&["tab".into(), "new".into(), "My Work".into()]).unwrap(),
        "tab new \"My Work\""
    );
    assert_eq!(
        util::normalize_cli_command(&[
            "ai".into(),
            "model".into(),
            "update".into(),
            "id".into(),
            "".into(),
            "secret".into()
        ])
        .unwrap(),
        "ai model update id \"\" secret"
    );
}

#[test]
fn closing_the_main_window_exits_the_desktop_process() {
    assert!(lifecycle::should_exit_on_close("main"));
    assert!(!lifecycle::should_exit_on_close("preview"));
}

#[test]
fn command_socket_names_are_process_scoped() {
    assert_ne!(ipc::socket_file_name(101), ipc::socket_file_name(202));
    assert_eq!(ipc::socket_file_name(101), "command-101.sock");
}

#[test]
fn focus_only_ipc_requests_are_not_dispatched_as_commands() {
    assert_eq!(
        ipc::parse_request(ipc::FOCUS_REQUEST).unwrap(),
        ipc::IncomingRequest::Focus
    );
    assert_eq!(
        ipc::parse_request("tab new Work").unwrap(),
        ipc::IncomingRequest::Command("tab new Work")
    );
    assert!(ipc::parse_request("   ").is_err());
}

#[test]
fn state_and_attach_ipc_requests_parse_into_dedicated_variants() {
    assert_eq!(
        ipc::parse_request(ipc::STATE_REQUEST).unwrap(),
        ipc::IncomingRequest::StateGet
    );
    assert_eq!(
        ipc::parse_request(ipc::WATCH_REQUEST).unwrap(),
        ipc::IncomingRequest::StateWatch
    );
    assert_eq!(
        ipc::parse_request("__auri_quiet__:system refresh").unwrap(),
        ipc::IncomingRequest::QuietCommand("system refresh")
    );
    assert_eq!(
        ipc::parse_request("__auri_term_attach__:terminal-17-abc").unwrap(),
        ipc::IncomingRequest::TerminalAttach("terminal-17-abc")
    );
    assert!(ipc::parse_request("__auri_quiet__:").is_err());
    assert!(ipc::parse_request("__auri_term_attach__:").is_err());
    assert_eq!(
        ipc::parse_request("__auri_copy__:aGVsbG8=").unwrap(),
        ipc::IncomingRequest::CopyText("aGVsbG8=")
    );
    assert!(ipc::parse_request("__auri_copy__:").is_err());
}

#[test]
fn terminal_resize_ipc_requests_parse_session_and_grid() {
    assert_eq!(
        ipc::parse_request("__auri_term_resize__:terminal-1-ab:120:32").unwrap(),
        ipc::IncomingRequest::TerminalResize { session: "terminal-1-ab", cols: 120, rows: 32 }
    );
    assert!(ipc::parse_request("__auri_term_resize__:only-session").is_err());
    assert!(ipc::parse_request("__auri_term_resize__:s:0:10").is_err());
    assert!(ipc::parse_request("__auri_term_resize__::80:24").is_err());
}

#[test]
fn lifecycle_ipc_requests_parse_into_dedicated_variants() {
    assert_eq!(
        ipc::parse_request(ipc::SERVE_UI_REQUEST).unwrap(),
        ipc::IncomingRequest::ServeUi
    );
    assert_eq!(
        ipc::parse_request(ipc::QUIT_REQUEST).unwrap(),
        ipc::IncomingRequest::Quit
    );
    assert_eq!(
        ipc::parse_request(ipc::APP_INFO_REQUEST).unwrap(),
        ipc::IncomingRequest::AppInfo
    );
}

#[test]
fn web_request_heads_parse_method_path_and_host() {
    let head = webserver::parse_http_head(
        "POST /__auri__/invoke/system_snapshot HTTP/1.1\r\nHost: 127.0.0.1:8899\r\nContent-Length: 42\r\nAccept: */*\r\n\r\n",
    )
    .unwrap();
    assert_eq!(head.method, "POST");
    assert_eq!(head.path, "/__auri__/invoke/system_snapshot");
    assert_eq!(head.host, "127.0.0.1:8899");
    assert_eq!(head.content_length, 42);

    let plain = webserver::parse_http_head("GET /src/main.js?v=3 HTTP/1.1\r\nhost: localhost:8899\r\n\r\n").unwrap();
    assert_eq!(plain.method, "GET");
    assert_eq!(plain.path, "/src/main.js?v=3");
    assert_eq!(plain.host, "localhost:8899");
    assert_eq!(plain.content_length, 0);

    assert!(webserver::parse_http_head("").is_err());
    assert!(webserver::parse_http_head("GARBAGE\r\n\r\n").is_err());
}

#[test]
fn web_server_rejects_non_local_hosts_to_stop_dns_rebinding() {
    assert!(webserver::host_is_local("127.0.0.1:8899"));
    assert!(webserver::host_is_local("localhost:8899"));
    assert!(webserver::host_is_local("localhost"));
    assert!(webserver::host_is_local("[::1]:8899"));
    assert!(!webserver::host_is_local("evil.example:8899"));
    assert!(!webserver::host_is_local("127.0.0.1.evil.example"));
    assert!(!webserver::host_is_local(""));
}

#[test]
fn web_asset_paths_stay_inside_the_ui_root() {
    assert_eq!(webserver::sanitize_asset_path("/").as_deref(), Some("index.html"));
    assert_eq!(
        webserver::sanitize_asset_path("/src/main.js?v=3").as_deref(),
        Some("src/main.js")
    );
    assert_eq!(
        webserver::sanitize_asset_path("/styles%20v2.css").as_deref(),
        Some("styles v2.css")
    );
    assert_eq!(webserver::sanitize_asset_path("/a/../../etc/passwd"), None);
    assert_eq!(webserver::sanitize_asset_path("/..%2F..%2Fetc/passwd"), None);
    assert_eq!(webserver::sanitize_asset_path("/.git/config"), None);
    assert_eq!(webserver::sanitize_asset_path("relative"), None);
}

#[test]
fn web_invoke_paths_extract_safe_command_names() {
    assert_eq!(
        webserver::parse_invoke_command("/__auri__/invoke/system_snapshot"),
        Some("system_snapshot")
    );
    assert_eq!(webserver::parse_invoke_command("/__auri__/invoke/"), None);
    assert_eq!(webserver::parse_invoke_command("/__auri__/invoke/Bad-Name!"), None);
    assert_eq!(webserver::parse_invoke_command("/src/main.js"), None);
}

#[test]
fn vt_screen_renders_plain_lines_with_wrap_and_scroll() {
    let mut screen = vt::VtScreen::new(10, 3);
    screen.feed_str("one\r\ntwo\r\nthree\r\nfour");
    let lines = screen.plain_lines();
    assert_eq!(lines, vec!["two", "three", "four"]);
    assert_eq!(screen.cursor(), (4, 2));

    // Wrapping past the last column continues on the next row.
    let mut screen = vt::VtScreen::new(4, 2);
    screen.feed_str("abcdef");
    assert_eq!(screen.plain_lines(), vec!["abcd", "ef"]);
}

#[test]
fn vt_screen_honors_cursor_addressing_like_top_redraws() {
    let mut screen = vt::VtScreen::new(20, 4);
    screen.feed_str("aaaa\r\nbbbb\r\ncccc\r\ndddd");
    // Home, clear-to-end-of-line, overwrite: how top refreshes a header.
    screen.feed_str("\x1b[H\x1b[KProcesses: 42");
    let lines = screen.plain_lines();
    assert_eq!(lines[0], "Processes: 42");
    assert_eq!(lines[1], "bbbb");
    // Absolute positioning row 3 column 2.
    screen.feed_str("\x1b[3;2HX");
    assert_eq!(screen.plain_lines()[2], "cXcc");
    // Clear the whole screen.
    screen.feed_str("\x1b[2J\x1b[H");
    assert!(screen.plain_lines().iter().all(|line| line.is_empty()));
}

#[test]
fn vt_screen_keeps_sgr_styles_and_survives_split_escapes() {
    let mut screen = vt::VtScreen::new(20, 2);
    screen.feed_str("\x1b[31mred");
    let styled = screen.styled_lines(None);
    assert!(styled[0].contains("\u{1b}[31m"), "row keeps the color: {}", styled[0]);
    assert!(styled[0].contains("red"));

    // An escape split across two feeds must not leak or corrupt.
    let mut screen = vt::VtScreen::new(20, 2);
    screen.feed_str("\x1b[3");
    screen.feed_str("2mgreen");
    assert_eq!(screen.plain_lines()[0], "green");
    assert!(screen.styled_lines(None)[0].contains("\u{1b}[32m"));
}

#[test]
fn vt_screen_supports_alt_screen_round_trip_and_resize() {
    let mut screen = vt::VtScreen::new(10, 3);
    screen.feed_str("shell$");
    screen.feed_str("\x1b[?1049h\x1b[Hvim");
    assert_eq!(screen.plain_lines()[0], "vim");
    screen.feed_str("\x1b[?1049l");
    assert_eq!(screen.plain_lines()[0], "shell$");

    screen.resize(6, 2);
    assert_eq!(screen.plain_lines().len(), 2);
    screen.feed_str("\r\nok");
    assert_eq!(screen.plain_lines()[1], "ok");
}

#[test]
fn vt_screen_scroll_region_and_reverse_index_behave() {
    let mut screen = vt::VtScreen::new(8, 4);
    screen.feed_str("a\r\nb\r\nc\r\nd");
    // Restrict scrolling to rows 2..3, then scroll up inside it.
    screen.feed_str("\x1b[2;3r\x1b[3;1H\ne");
    let lines = screen.plain_lines();
    assert_eq!(lines[0], "a", "rows outside the region stay put");
    assert_eq!(lines[3], "d");
    // Reverse index at the top of the region scrolls the region down.
    screen.feed_str("\x1b[2;1H\x1bM");
    assert_eq!(screen.plain_lines()[0], "a");
}

#[test]
fn terminal_seed_takes_only_the_last_lines() {
    let text = (1..=250).map(|line| format!("line {line}\n")).collect::<String>();
    let tail = vt::tail_lines(&text, 100);
    assert!(tail.starts_with("line 151\n"), "keeps exactly the last 100 lines");
    assert!(tail.ends_with("line 250\n"));
    assert_eq!(vt::tail_lines("short", 100), "short");
}

#[test]
fn terminal_mode_frame_renders_the_live_vt_grid_and_mode_hint() {
    let mut snapshot = sample_snapshot();
    snapshot.active_subtab_id = "sub-term".to_string();
    snapshot.workspaces[0].active_subtab_id = "sub-term".to_string();
    snapshot.workspaces[0].subtabs[0].active = true;
    snapshot.workspaces[0].subtabs[1].active = false;
    let ui = screen::UiState {
        term_mode: true,
        term_lines: vec!["top - 12:00 up".to_string(), "PID USER".to_string()],
        ..screen::UiState::default()
    };
    let frame = screen::render_frame(&snapshot, &ui, (80, 12));
    assert!(frame.plain.iter().any(|row| row.contains("top - 12:00 up")), "live grid renders");
    assert!(frame.plain.iter().any(|row| row.contains("Ctrl+B")), "the exit hint is visible");
    assert!(
        frame.plain.iter().any(|row| row.contains("TERMINAL")),
        "the status row shows terminal mode"
    );
    // No second echoed input line: the run-command prompt is gone.
    assert!(!frame.plain.iter().any(|row| row.contains("run ❯")));
}

#[test]
fn terminal_input_splits_mouse_reports_from_raw_passthrough_bytes() {
    // A mouse click sequence embedded between typed characters: the mouse
    // event is parsed for the TUI, the rest passes through untouched.
    let bytes = b"ab\x1b[<0;5;6Mcd\x1b[A";
    let (mice, raw) = input::split_terminal_input(bytes);
    assert_eq!(mice.len(), 1);
    assert_eq!((mice[0].x, mice[0].y), (4, 5));
    assert_eq!(raw, b"abcd\x1b[A".to_vec(), "non-mouse bytes pass through in order");
    let (no_mice, untouched) = input::split_terminal_input(b"plain \x1b[A arrows");
    assert!(no_mice.is_empty());
    assert_eq!(untouched, b"plain \x1b[A arrows".to_vec());
}

#[test]
fn web_content_types_cover_ui_assets() {
    assert_eq!(webserver::content_type_for("index.html"), "text/html; charset=utf-8");
    assert_eq!(webserver::content_type_for("src/main.js"), "text/javascript; charset=utf-8");
    assert_eq!(webserver::content_type_for("styles.css"), "text/css; charset=utf-8");
    assert_eq!(webserver::content_type_for("data.json"), "application/json");
    assert_eq!(webserver::content_type_for("icon.svg"), "image/svg+xml");
    assert_eq!(webserver::content_type_for("photo.png"), "image/png");
    assert_eq!(webserver::content_type_for("unknown.bin"), "application/octet-stream");
}

#[test]
fn state_sync_store_publishes_serves_and_wakes_watchers() {
    assert_eq!(state_sync::latest(), None);
    assert_eq!(
        state_sync::wait_for_newer(0, std::time::Duration::from_millis(10)),
        None
    );

    state_sync::publish("{\"seq\":1}".to_string());
    let (first_seq, first_json) = state_sync::wait_for_newer(0, std::time::Duration::from_millis(10))
        .expect("published state is immediately available");
    assert_eq!(first_json, "{\"seq\":1}");
    assert_eq!(state_sync::latest(), Some("{\"seq\":1}".to_string()));

    assert_eq!(
        state_sync::wait_for_newer(first_seq, std::time::Duration::from_millis(30)),
        None,
        "watching past the newest sequence times out quietly"
    );

    let handle = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(30));
        state_sync::publish("{\"seq\":2}".to_string());
    });
    let woken = state_sync::wait_for_newer(first_seq, std::time::Duration::from_secs(2))
        .expect("a later publish wakes the watcher");
    assert_eq!(woken.1, "{\"seq\":2}");
    assert!(woken.0 > first_seq);
    handle.join().unwrap();
}

#[test]
fn terminal_text_sanitizer_keeps_colors_and_drops_cursor_control() {
    // SGR color runs survive; cursor addressing, screen clears, and OSC titles vanish.
    let lines = ansi::sanitize_terminal_text(
        "\u{1b}[2J\u{1b}[H\u{1b}]0;title\u{7}\u{1b}[31mred\u{1b}[0m plain\r\nnext\tcol",
    );
    assert_eq!(lines, vec!["\u{1b}[31mred\u{1b}[0m plain", "next    col"]);

    // A lone carriage return rewinds the line, like a progress bar does.
    assert_eq!(
        ansi::sanitize_terminal_text("progress 10%\rprogress 90%"),
        vec!["progress 90%"]
    );
}

#[test]
fn visible_width_and_clipping_ignore_color_sequences() {
    assert_eq!(ansi::visible_width("\u{1b}[32mabc\u{1b}[0m"), 3);
    let clipped = ansi::clip_visible("\u{1b}[32mabcdef\u{1b}[0m", 4);
    assert_eq!(ansi::visible_width(&clipped), 4);
    assert!(clipped.starts_with("\u{1b}[32m"));
    assert!(clipped.ends_with("\u{1b}[0m"), "clipping must reset styles: {clipped:?}");
}

#[test]
fn key_parser_decodes_characters_arrows_and_control_bytes() {
    use input::Key;
    assert_eq!(
        input::parse_keys(b"a"),
        vec![Key::Char('a')]
    );
    assert_eq!(
        input::parse_keys(b"\x1b[A\x1b[B\x1b[C\x1b[D"),
        vec![Key::Up, Key::Down, Key::Right, Key::Left]
    );
    assert_eq!(
        input::parse_keys(b"\r\x7f\t"),
        vec![Key::Enter, Key::Backspace, Key::Tab]
    );
    assert_eq!(input::parse_keys(b"\x03"), vec![Key::CtrlC]);
    assert_eq!(input::parse_keys(b"\x1b"), vec![Key::Escape]);
    assert_eq!(
        input::parse_keys(b"\x1b[5~\x1b[6~"),
        vec![Key::PageUp, Key::PageDown]
    );
}

#[test]
fn screen_formats_bytes_and_rates_for_the_monitor() {
    assert_eq!(screen::format_bytes(0), "0 B");
    assert_eq!(screen::format_bytes(2_048), "2.0 KB");
    assert_eq!(screen::format_bytes(3_500_000), "3.3 MB");
    assert_eq!(screen::format_bytes(7_000_000_000), "6.5 GB");
    assert_eq!(screen::format_rate(Some(2_048.0)), "2.0 KB/s");
    assert_eq!(screen::format_rate(None), "—");
}

#[test]
fn screen_frame_mirrors_workspaces_subtabs_and_the_system_monitor() {
    let snapshot = view_model::SnapshotView {
        seq: 4,
        active_tab_id: "tab-1".to_string(),
        active_subtab_id: "sub-2".to_string(),
        workspaces: vec![view_model::WorkspaceView {
            id: "tab-1".to_string(),
            title: "Home".to_string(),
            active: true,
            active_subtab_id: "sub-2".to_string(),
            folder_path: "~/projects".to_string(),
            terminal_cwd: "~/projects".to_string(),
            terminal_running: false,
            subtabs: vec![
                view_model::SubtabView {
                    id: "sub-1".to_string(),
                    kind: "terminal".to_string(),
                    title: "Terminal".to_string(),
                    active: false,
                    cwd: Some("~/projects".to_string()),
                    url: None,
                },
                view_model::SubtabView {
                    id: "sub-2".to_string(),
                    kind: "system".to_string(),
                    title: "System".to_string(),
                    active: true,
                    cwd: None,
                    url: None,
                },
            ],
        }],
        terminals: std::collections::HashMap::new(),
        system: view_model::SystemView {
            status: "ready".to_string(),
            sort_by: "cpu".to_string(),
            sort_direction: "desc".to_string(),
            filter: String::new(),
            selected_pid: None,
            process_count: 1,
            metrics: Some(view_model::MetricsView {
                hostname: "mini".to_string(),
                os: "macOS".to_string(),
                cpu_brand: "Apple M4".to_string(),
                cpu_cores: 10,
                cpu_usage_percent: Some(12.5),
                memory_used_bytes: 8_000_000_000,
                memory_total_bytes: 16_000_000_000,
                download_bytes_per_second: Some(1_024.0),
                upload_bytes_per_second: Some(512.0),
                disk_used_bytes: 500_000_000_000,
                disk_total_bytes: 1_000_000_000_000,
                disk_read_bytes_per_second: Some(0.0),
                disk_write_bytes_per_second: Some(0.0),
            }),
            processes: vec![view_model::ProcessView {
                pid: 42,
                name: "node".to_string(),
                cpu_percent: 12.0,
                memory_bytes: 123_000_000,
                download_bytes_per_second: 0.0,
                upload_bytes_per_second: 0.0,
                read_bytes_per_second: 0.0,
                write_bytes_per_second: 0.0,
                ports: vec![3000],
                priority: Some(0),
            }],
        },
        info: view_model::InfoView { unread: 0, items: vec![] },
        clipboard_count: 2,
        clipboard_items: vec![],
    };
    let ui = screen::UiState::default();
    let frame = screen::render_frame(&snapshot, &ui, (100, 30));

    assert!(
        frame.plain.iter().any(|row| row.contains("1 projects")),
        "workspace list renders as number + folder"
    );
    assert!(frame.text.contains("System"), "subtab bar renders");
    assert!(frame.text.contains("node"), "process table renders");
    assert!(frame.text.contains("42"), "pid renders");
    assert!(frame.text.contains("Apple M4"), "cpu metric renders");
    assert!(frame.text.contains("12.5"), "cpu usage renders");
    for line in frame.text.split("\r\n") {
        assert!(
            ansi::visible_width(line) <= 100,
            "every frame line stays within the terminal width"
        );
    }
}

#[test]
fn mouse_reports_decode_press_release_drag_and_wheel() {
    use input::{Event, Key, Mouse, MouseKind};
    let events = input::parse_events(b"\x1b[<0;5;3M\x1b[<0;9;3m\x1b[<32;6;4M\x1b[<64;2;2M\x1b[<65;2;2Mq");
    assert_eq!(
        events,
        vec![
            Event::Mouse(Mouse { kind: MouseKind::Press, x: 4, y: 2 }),
            Event::Mouse(Mouse { kind: MouseKind::Release, x: 8, y: 2 }),
            Event::Mouse(Mouse { kind: MouseKind::Drag, x: 5, y: 3 }),
            Event::Mouse(Mouse { kind: MouseKind::WheelUp, x: 1, y: 1 }),
            Event::Mouse(Mouse { kind: MouseKind::WheelDown, x: 1, y: 1 }),
            Event::Key(Key::Char('q')),
        ]
    );
}

fn sample_snapshot() -> view_model::SnapshotView {
    let mut snapshot = view_model::SnapshotView {
        seq: 1,
        active_tab_id: "tab-1".to_string(),
        active_subtab_id: "sub-sys".to_string(),
        ..Default::default()
    };
    snapshot.workspaces = vec![
        view_model::WorkspaceView {
            id: "tab-1".to_string(),
            title: "Home".to_string(),
            active: true,
            active_subtab_id: "sub-sys".to_string(),
            folder_path: "/Users/eco/project/tem".to_string(),
            terminal_cwd: "~/project/tem".to_string(),
            terminal_running: false,
            subtabs: vec![
                view_model::SubtabView {
                    id: "sub-term".to_string(),
                    kind: "terminal".to_string(),
                    title: "Terminal".to_string(),
                    active: false,
                    cwd: Some("~".to_string()),
                    url: None,
                },
                view_model::SubtabView {
                    id: "sub-sys".to_string(),
                    kind: "system".to_string(),
                    title: "System".to_string(),
                    active: true,
                    cwd: None,
                    url: None,
                },
            ],
        },
        view_model::WorkspaceView {
            id: "tab-2".to_string(),
            title: "Space 2".to_string(),
            active: false,
            folder_path: "/tmp/demo".to_string(),
            ..Default::default()
        },
    ];
    snapshot.system.processes = vec![view_model::ProcessView {
        pid: 42,
        name: "node".to_string(),
        ports: vec![3000],
        ..Default::default()
    }];
    snapshot.system.process_count = 1;
    snapshot.clipboard_items = vec![view_model::ClipboardItemView {
        id: "clip-9".to_string(),
        kind: "text".to_string(),
        pinned: false,
        preview: "copied text".to_string(),
    }];
    snapshot.clipboard_count = 1;
    snapshot
}

#[test]
fn workspace_labels_use_left_index_numbers_instead_of_space_names() {
    // Default titles ("Home", "Space N") collapse to just the number; the
    // folder name next to it carries the meaning. Custom titles stay.
    assert_eq!(screen::workspace_label(1, "Home"), "1");
    assert_eq!(screen::workspace_label(2, "Space 2"), "2");
    assert_eq!(screen::workspace_label(1, "Space 12"), "1");
    assert_eq!(screen::workspace_label(3, ""), "3");
    assert_eq!(screen::workspace_label(2, "Notes"), "2 Notes");
    assert_eq!(screen::workspace_label(2, "Space station"), "2 Space station");
}

#[test]
fn frame_puts_workspaces_with_folder_names_above_the_subtab_bar_and_exposes_click_regions() {
    let snapshot = sample_snapshot();
    let ui = screen::UiState::default();
    let frame = screen::render_frame(&snapshot, &ui, (100, 24));

    let workspace_row = frame
        .plain
        .iter()
        .position(|row| row.contains("1 tem") && row.contains("2 demo"))
        .expect("workspace chips show an index number with the folder name");
    let subtab_row = frame
        .plain
        .iter()
        .position(|row| row.contains("Terminal") && row.contains("System"))
        .expect("subtab bar renders");
    assert!(workspace_row < subtab_row, "workspaces sit above the subtab bar");
    assert!(
        !frame.plain[workspace_row].contains("Space 2") && !frame.plain[workspace_row].contains("Home"),
        "default space names stay out of the tab bar"
    );

    let click = |x: usize, y: usize| screen::hit_test(&frame.regions, x, y).cloned();
    let workspace_x = frame.plain[workspace_row].find("2 demo").unwrap();
    assert_eq!(
        click(workspace_x + 1, workspace_row),
        Some(screen::Action::SelectWorkspace("tab-2".to_string()))
    );
    let subtab_x = frame.plain[subtab_row].find("Terminal").unwrap();
    assert_eq!(
        click(subtab_x, subtab_row),
        Some(screen::Action::SelectSubtab("sub-term".to_string()))
    );

    let header_row = frame
        .plain
        .iter()
        .position(|row| row.contains("CPU%") && row.contains("PORT"))
        .expect("system header renders");
    let cpu_x = frame.plain[header_row].find("CPU%").unwrap();
    assert_eq!(click(cpu_x + 1, header_row), Some(screen::Action::SortBy("cpu".to_string())));
    let port_x = frame.plain[header_row].find("PORT").unwrap();
    assert_eq!(click(port_x + 1, header_row), Some(screen::Action::SortBy("port".to_string())));
    let process_row = frame
        .plain
        .iter()
        .position(|row| row.contains("node"))
        .expect("process row renders");
    assert_eq!(click(10, process_row), Some(screen::Action::SelectProcess(42)));
}

#[test]
fn terminal_panel_regions_cover_the_buffer_area_for_click_focus_and_selection() {
    let mut snapshot = sample_snapshot();
    snapshot.active_subtab_id = "sub-term".to_string();
    snapshot.workspaces[0].active_subtab_id = "sub-term".to_string();
    snapshot.workspaces[0].subtabs[0].active = true;
    snapshot.workspaces[0].subtabs[1].active = false;
    snapshot.terminals.insert(
        "sub-term".to_string(),
        view_model::TerminalBufferView {
            session_id: "session-1".to_string(),
            text: (1..=40).map(|line| format!("line {line}\r\n")).collect(),
            cols: 0,
            rows: 0,
        },
    );
    let ui = screen::UiState::default();
    let frame = screen::render_frame(&snapshot, &ui, (80, 20));
    let terminal_region = frame
        .regions
        .iter()
        .find(|region| region.action == screen::Action::FocusTerminal)
        .expect("terminal area is clickable");
    assert!(terminal_region.height >= 10, "terminal area covers the panel");

    // Scrolled view shows earlier lines.
    let scrolled = screen::render_frame(
        &snapshot,
        &screen::UiState { terminal_scroll: 10, ..screen::UiState::default() },
        (80, 20),
    );
    let bottom_line = |frame: &screen::Frame| frame
        .plain
        .iter()
        .rev()
        .find(|row| row.contains("line "))
        .cloned()
        .unwrap_or_default();
    assert!(bottom_line(&frame).contains("line 40"));
    assert!(bottom_line(&scrolled).contains("line 30"));
}

#[test]
fn clipboard_panel_lists_items_with_copy_regions() {
    let snapshot = sample_snapshot();
    let mut with_clipboard = snapshot.clone();
    with_clipboard.active_subtab_id = "sub-clip".to_string();
    with_clipboard.workspaces[0].active_subtab_id = "sub-clip".to_string();
    with_clipboard.workspaces[0].subtabs.push(view_model::SubtabView {
        id: "sub-clip".to_string(),
        kind: "clipboard".to_string(),
        title: "Clipboard".to_string(),
        active: true,
        cwd: None,
        url: None,
    });
    let frame = screen::render_frame(&with_clipboard, &screen::UiState::default(), (90, 20));
    let row = frame
        .plain
        .iter()
        .position(|line| line.contains("copied text"))
        .expect("clipboard item preview renders");
    assert_eq!(
        screen::hit_test(&frame.regions, 5, row).cloned(),
        Some(screen::Action::CopyClipboardItem("clip-9".to_string()))
    );
}

#[test]
fn selection_extracts_trimmed_text_between_two_grid_points() {
    let plain = vec![
        "first row text  ".to_string(),
        "second row      ".to_string(),
        "third           ".to_string(),
    ];
    assert_eq!(screen::selection_text(&plain, (6, 0), (10, 1)), "row text\nsecond row");
    // Reversed drag order normalises.
    assert_eq!(screen::selection_text(&plain, (10, 1), (6, 0)), "row text\nsecond row");
    assert_eq!(screen::selection_text(&plain, (0, 2), (4, 2)), "third");
}

#[test]
fn local_session_state_manages_workspaces_subtabs_and_command_routing() {
    use session_state::SessionState;
    let mut state = SessionState::new("~/home");
    assert_eq!(state.workspaces.len(), 1);
    let first_terminal = state.workspaces[0].subtabs[0].id.clone();

    state.apply("tab new Research").unwrap();
    assert_eq!(state.workspaces.len(), 2);
    assert_eq!(state.workspaces[1].title, "Research");
    assert_eq!(state.active_tab_id, state.workspaces[1].id);

    state.apply("subtab new system").unwrap();
    let active = state.active_workspace().unwrap();
    assert_eq!(active.subtabs.len(), 4, "terminal, clipboard, info, then the new system subtab");
    assert_eq!(active.active_subtab().unwrap().kind, "system");

    let second_tab = state.active_tab_id.clone();
    state.apply(&format!("tab select {}", state.workspaces[0].id)).unwrap();
    assert_eq!(state.workspaces[0].id, state.active_tab_id);
    state.apply(&format!("tab close {second_tab}")).unwrap();
    assert_eq!(state.workspaces.len(), 1);

    assert_eq!(
        state.apply("terminal run echo hello").unwrap(),
        session_state::Effect::RunTerminal { subtab_id: first_terminal, command: "echo hello".to_string() }
    );
    assert_eq!(
        state.apply("system sort ram").unwrap(),
        session_state::Effect::None
    );
    assert_eq!(state.system_sort_by, "ram");
    state.apply("system search node web").unwrap();
    assert_eq!(state.system_filter, "node web");
    assert!(state.apply("web open https://x").is_err(), "unsupported domains error honestly");
}

#[test]
fn local_process_sort_and_filter_match_the_gui_rules() {
    use session_state::{filter_processes, sort_processes, LocalProcess};
    let processes = vec![
        LocalProcess { pid: 1, name: "chrome".into(), cpu_percent: 5.0, memory_bytes: 300, ports: vec![], ..Default::default() },
        LocalProcess { pid: 2, name: "node api".into(), cpu_percent: 1.0, memory_bytes: 900, ports: vec![8080], ..Default::default() },
        LocalProcess { pid: 3, name: "node worker".into(), cpu_percent: 9.0, memory_bytes: 100, ports: vec![3000], ..Default::default() },
    ];
    let filtered = filter_processes(&processes, "node chrome");
    assert_eq!(filtered.len(), 3, "space separates OR keywords");
    let filtered = filter_processes(&processes, "node");
    assert_eq!(filtered.len(), 2);

    let mut by_ram = filtered.clone();
    sort_processes(&mut by_ram, "ram", "desc");
    assert_eq!(by_ram[0].pid, 2);

    let mut by_port = processes.clone();
    sort_processes(&mut by_port, "port", "desc");
    assert_eq!(by_port[0].pid, 3, "port sort puts the lowest listening port first");
    assert_eq!(by_port.last().unwrap().pid, 1, "portless processes sort last");
}

#[test]
fn terminal_taps_forward_bytes_and_prune_dropped_receivers() {
    let receiver = term_bridge::attach("session-a");
    term_bridge::forward("session-a", b"hello");
    assert_eq!(receiver.recv().unwrap(), b"hello".to_vec());
    assert_eq!(term_bridge::tap_count("session-a"), 1);

    drop(receiver);
    term_bridge::forward("session-a", b"more");
    assert_eq!(term_bridge::tap_count("session-a"), 0, "dead taps are pruned on forward");

    let survivor = term_bridge::attach("session-a");
    term_bridge::clear("session-a");
    assert_eq!(term_bridge::tap_count("session-a"), 0);
    assert!(
        survivor.recv().is_err(),
        "clearing a session disconnects its attached watchers"
    );
}

#[test]
fn shell_history_parser_handles_zsh_extended_and_bash_timestamp_lines() {
    assert_eq!(
        util::shell_history_command(": 1712345678:0;git status"),
        Some("git status".to_string())
    );
    assert_eq!(
        util::shell_history_command("npm test"),
        Some("npm test".to_string())
    );
    assert_eq!(util::shell_history_command("#1712345678"), None);
    assert_eq!(util::shell_history_command("   "), None);
}

#[test]
fn recent_shell_history_is_newest_first_deduplicated_and_bounded() {
    let histories = vec![
        "old command
: 1712345678:0;git status
npm test
git status"
            .to_string(),
        "cargo check
npm test"
            .to_string(),
    ];
    assert_eq!(
        util::recent_shell_history_commands(&histories, 3),
        vec![
            "git status".to_string(),
            "npm test".to_string(),
            "old command".to_string()
        ]
    );
}

#[test]
fn file_server_ports_keep_release_on_8890_and_development_on_8895_or_later() {
    assert_eq!(util::default_file_server_port(false), 8_890);
    assert_eq!(util::default_file_server_port(true), 8_895);
    assert!(util::default_file_server_port(true) >= 8_895);
}

#[test]
fn media_bitrate_defaults_to_four_megabits_with_codec_safe_caps() {
    assert_eq!(util::normalized_video_bitrate(None), 4_000);
    assert_eq!(util::normalized_audio_bitrate("m4a", None), 4_000);
    assert_eq!(util::normalized_audio_bitrate("mp3", None), 320);
    assert_eq!(util::normalized_audio_bitrate("mp3", Some(192)), 192);
    assert_eq!(util::normalized_video_bitrate(Some(50_000)), 20_000);
}

#[test]
fn main_webview_fills_the_window_from_the_origin() {
    assert_eq!(util::main_fill_bounds(800, 760), (0, 0, 800, 760));
    assert_eq!(util::main_fill_bounds(1920, 1080), (0, 0, 1920, 1080));
}

#[test]
fn main_webview_bounds_grow_when_the_window_is_enlarged() {
    // Reproduces the reported bug: enlarging the window must enlarge the main
    // webview to match, instead of leaving it at its original startup size.
    let small = util::main_fill_bounds(800, 760);
    let large = util::main_fill_bounds(2560, 1440);
    assert_eq!(small, (0, 0, 800, 760));
    assert_eq!(large, (0, 0, 2560, 1440));
    assert!(large.2 > small.2 && large.3 > small.3);
}

#[test]
fn linux_webkit_disables_only_the_crashing_pipewire_device_provider() {
    assert_eq!(
        util::webkit_gstreamer_feature_rank(None),
        "pipewiredeviceprovider:NONE"
    );
    assert_eq!(
        util::webkit_gstreamer_feature_rank(Some("vaapidecodebin:MAX")),
        "vaapidecodebin:MAX,pipewiredeviceprovider:NONE"
    );
    assert_eq!(
        util::webkit_gstreamer_feature_rank(Some("pipewiredeviceprovider:PRIMARY")),
        "pipewiredeviceprovider:PRIMARY"
    );
}

fn sleep_test_directory(name: &str) -> std::path::PathBuf {
    let directory =
        std::env::temp_dir().join(format!("auri-webview-sleep-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

fn sleep_record(id: &str) -> webview_sleep::SleepRecord {
    webview_sleep::SleepRecord {
        id: id.to_string(),
        url: "https://example.com/page".to_string(),
        slept_at_ms: 42,
    }
}

#[test]
fn webview_sleep_state_round_trips_through_disk_and_is_consumed_on_wake() {
    let directory = sleep_test_directory("roundtrip");
    webview_sleep::write_record(&directory, &sleep_record("subtab-1")).unwrap();
    assert_eq!(
        webview_sleep::take_record(&directory, "subtab-1"),
        Some(sleep_record("subtab-1"))
    );
    assert_eq!(webview_sleep::take_record(&directory, "subtab-1"), None);
}

#[test]
fn webview_sleep_removal_discards_the_saved_state() {
    let directory = sleep_test_directory("remove");
    webview_sleep::write_record(&directory, &sleep_record("subtab-2")).unwrap();
    webview_sleep::remove_record(&directory, "subtab-2");
    assert_eq!(webview_sleep::take_record(&directory, "subtab-2"), None);
}

#[test]
fn webview_sleep_ignores_corrupted_or_non_web_records() {
    let directory = sleep_test_directory("corrupt");
    std::fs::write(directory.join("subtab-3.sleep"), "not a sleep record").unwrap();
    assert_eq!(webview_sleep::take_record(&directory, "subtab-3"), None);
    assert!(!directory.join("subtab-3.sleep").exists());

    let mut record = sleep_record("subtab-4");
    record.url = "file:///etc/passwd".to_string();
    webview_sleep::write_record(&directory, &record).unwrap();
    assert_eq!(webview_sleep::take_record(&directory, "subtab-4"), None);
}

#[test]
fn webview_sleep_file_names_stay_safe_for_unusual_ids() {
    let directory = sleep_test_directory("safe-names");
    webview_sleep::write_record(&directory, &sleep_record("a/b:c")).unwrap();
    assert_eq!(
        webview_sleep::take_record(&directory, "a/b:c"),
        Some(sleep_record("a/b:c"))
    );
    assert!(directory.read_dir().unwrap().next().is_none());
}

#[test]
fn webview_sleep_rejects_records_with_line_breaks() {
    let directory = sleep_test_directory("linebreaks");
    let mut record = sleep_record("subtab-5");
    record.url = "https://example.com/\nfake".to_string();
    assert!(webview_sleep::write_record(&directory, &record).is_err());
}
