#[cfg(target_family = "unix")]
use std::os::unix::fs::PermissionsExt;

#[test]
fn path_command_search_returns_only_matching_executables_with_full_paths() {
    let root = std::env::temp_dir().join(format!("auri-path-commands-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let python = root.join("python3");
    let pytest = root.join("pytest");
    let text = root.join("python-not-executable");
    std::fs::write(&python, b"").unwrap();
    std::fs::write(&pytest, b"").unwrap();
    std::fs::write(&text, b"").unwrap();
    #[cfg(target_family = "unix")]
    {
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&pytest, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&text, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    let matches =
        auri_lib::core::system::search_executable_commands_in_paths("pyth", &[root.clone()], 20);
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].name, "python3");
    assert_eq!(matches[0].path, python.to_string_lossy());
    assert!(auri_lib::core::system::search_executable_commands_in_paths(
        "pyt",
        &[root.clone()],
        20
    )
    .is_empty());
    std::fs::remove_dir_all(root).unwrap();
}
