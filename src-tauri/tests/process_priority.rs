use auri_lib::core::system::{process_executable_path, valid_process_nice};

#[test]
fn process_priority_accepts_the_os_nice_range_including_the_named_presets() {
    assert!(valid_process_nice(19));
    assert!(valid_process_nice(1));
    assert!(valid_process_nice(10));
    assert!(valid_process_nice(15));
    assert!(valid_process_nice(-10));
    assert!(valid_process_nice(0));
    assert!(valid_process_nice(-20));
    assert!(!valid_process_nice(20));
    assert!(!valid_process_nice(-21));
}

#[cfg(target_os = "linux")]
#[test]
fn linux_process_identity_resolves_the_canonical_executable_path() {
    let expected = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    assert_eq!(
        process_executable_path(std::process::id()),
        Some(expected.to_string_lossy().into_owned())
    );
}
