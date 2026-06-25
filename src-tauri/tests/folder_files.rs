use auri_lib::core::files::{create_file, create_folder, folder_info};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn test_directory() -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "auri-folder-integration-test-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn creates_direct_children_without_overwriting_or_nested_names() {
    let directory = test_directory();
    let directory_text = directory.to_string_lossy();

    let file = create_file(&directory_text, "note.txt").unwrap();
    let folder = create_folder(&directory_text, "Work").unwrap();

    assert_eq!(file.kind, "file");
    assert_eq!(folder.kind, "directory");
    assert!(create_file(&directory_text, "note.txt").is_err());
    assert!(create_folder(&directory_text, "nested/path").is_err());

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn reports_folder_size_owner_and_permissions() {
    let directory = test_directory();
    fs::write(directory.join("data.bin"), [1_u8, 2, 3, 4]).unwrap();

    let info = folder_info(&directory.to_string_lossy()).unwrap();

    assert_eq!(info.total_size, 4);
    assert!(info.permissions.read);
    assert!(!info.owner.is_empty());
    assert!(info.disk_total.is_some());
    assert!(info.disk_used.is_some());
    assert!(info.disk_available.is_some());

    fs::remove_dir_all(directory).unwrap();
}
