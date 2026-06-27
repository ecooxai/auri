#[path = "../src/core/ipc.rs"]
mod ipc;

#[path = "../src/core/lifecycle.rs"]
mod lifecycle;

#[path = "../src/core/util.rs"]
mod util;

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
    assert_eq!(util::file_kind("archive.bin"), "file");
}

#[test]
fn mime_types_match_media_kind() {
    assert_eq!(util::mime_type("image.png"), "image/png");
    assert_eq!(util::mime_type("clip.mp4"), "video/mp4");
    assert_eq!(util::mime_type("readme.txt"), "text/plain");
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
git status".to_string(),
        "cargo check
npm test".to_string(),
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
