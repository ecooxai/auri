#[path = "../src/core/ipc.rs"]
mod ipc;

#[path = "../src/core/lifecycle.rs"]
mod lifecycle;

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
