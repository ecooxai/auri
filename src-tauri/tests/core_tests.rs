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

#[path = "../src/core/state_sync.rs"]
mod state_sync;

#[path = "../src/core/term_bridge.rs"]
mod term_bridge;

#[path = "../src/core/util.rs"]
mod util;

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
    };
    let ui = screen::UiState::default();
    let frame = screen::render_frame(&snapshot, &ui, (100, 30));

    assert!(frame.contains("Home"), "workspace list renders");
    assert!(frame.contains("System"), "subtab bar renders");
    assert!(frame.contains("node"), "process table renders");
    assert!(frame.contains("42"), "pid renders");
    assert!(frame.contains("Apple M4"), "cpu metric renders");
    assert!(frame.contains("12.5"), "cpu usage renders");
    for line in frame.split("\r\n") {
        assert!(
            ansi::visible_width(line) <= 100,
            "every frame line stays within the terminal width"
        );
    }
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
