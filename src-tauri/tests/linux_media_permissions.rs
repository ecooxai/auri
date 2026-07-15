#[cfg(target_os = "linux")]
#[test]
fn linux_media_status_uses_real_audio_sources_and_screen_capability() {
    let sources = "179\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPipeWire\n180\talsa_input.pci-0000_00_1f.3.analog-stereo\tPipeWire\n";
    let permissions =
        auri_lib::core::permissions::linux_permissions_from_capabilities(true, sources, true);

    assert_eq!(permissions.platform, "linux");
    assert_eq!(permissions.microphone, "authorized");
    assert_eq!(permissions.screen_recording, "authorized");
    assert_eq!(permissions.system_audio, "authorized");
}

#[cfg(target_os = "linux")]
#[test]
fn linux_media_status_does_not_mistake_monitor_sources_for_microphones() {
    let sources = "179\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPipeWire\n";
    let permissions =
        auri_lib::core::permissions::linux_permissions_from_capabilities(true, sources, false);

    assert_eq!(permissions.microphone, "unavailable");
    assert_eq!(permissions.screen_recording, "unavailable");
    assert_eq!(permissions.system_audio, "authorized");
}
