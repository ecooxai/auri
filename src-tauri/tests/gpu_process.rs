#[cfg(target_os = "linux")]
use auri_lib::core::system::parse_nvidia_pmon_line;

#[cfg(target_os = "linux")]
#[test]
fn nvidia_pmon_graphics_and_compute_clients_keep_pid_name_and_usage() {
    let (gpu_index, process) =
        parse_nvidia_pmon_line("0 1030534 C+G 25 1 - - - - chromium --type=gpu-process").unwrap();
    assert_eq!(gpu_index, 0);
    assert_eq!(process.pid, 1_030_534);
    assert_eq!(process.name, "chromium");
    assert_eq!(process.usage_percent, Some(25.0));

    let (_, graphics) = parse_nvidia_pmon_line("0 670086 G - - - - - - Xorg").unwrap();
    assert_eq!(graphics.name, "Xorg");
    assert_eq!(graphics.usage_percent, None);
}
