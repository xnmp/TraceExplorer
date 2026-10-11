#![cfg(target_os = "linux")]
use image_generation_backend::credential_command::{run, shutdown};
use std::{
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

#[test]
fn disconnect_shutdown_kills_the_helper_and_its_descendant() {
    let directory = tempfile::tempdir().unwrap();
    let helper = directory.path().join("helper.sh");
    let parent = directory.path().join("parent");
    let descendant = directory.path().join("descendant");
    std::fs::write(
        &helper,
        "sleep 60 &\nprintf '%s' $! > \"$2.tmp\"\nmv \"$2.tmp\" \"$2\"\nprintf '%s' $$ > \"$1.tmp\"\nmv \"$1.tmp\" \"$1\"\nwait\n",
    )
    .unwrap();
    let argv = vec![
        "/bin/sh".into(),
        helper.to_str().unwrap().into(),
        parent.to_str().unwrap().into(),
        descendant.to_str().unwrap().into(),
    ];
    let worker =
        std::thread::spawn(move || run(&argv, &AtomicBool::new(false), Duration::from_secs(30)));
    let deadline = Instant::now() + Duration::from_secs(5);
    while (!parent.exists() || !descendant.exists()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let parent: i32 = std::fs::read_to_string(parent).unwrap().parse().unwrap();
    let descendant: i32 = std::fs::read_to_string(descendant)
        .unwrap()
        .parse()
        .unwrap();
    shutdown();
    assert!(worker.join().unwrap().is_err());
    assert_eq!(unsafe { libc::kill(parent, 0) }, -1);
    // PID 1 owns orphan reaping; a zombie has stopped executing.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match std::fs::read_to_string(format!("/proc/{descendant}/stat")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Ok(stat) if stat.rsplit_once(") ").unwrap().1.starts_with('Z') => break,
            _ if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => panic!("credential descendant survived shutdown"),
        }
    }
    let failure = run(
        &["/bin/sh".into(), "-c".into(), "printf key".into()],
        &AtomicBool::new(false),
        Duration::from_secs(1),
    )
    .unwrap_err();
    assert_eq!(failure.message, "Credential command was cancelled");
}
