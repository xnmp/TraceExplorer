#![cfg(target_os = "linux")]

use image_generation_backend::{
    error::{error, Result},
    host::Host,
    service::Service,
};
use serde_json::Value;
use std::{
    fs::File,
    io::Read,
    os::fd::FromRawFd,
    sync::{atomic::AtomicBool, Arc},
};

struct LocalHost;
impl Host for LocalHost {
    fn call(&self, _: &str, _: Value, _: &AtomicBool) -> Result<Value> {
        Err(error("method_not_found", "No host IO expected"))
    }
    fn event(&self, _: &str, _: Value) -> Result<()> {
        Ok(())
    }
}

/// Model a parallel Command child between fork and exec. The child must use
/// only async-signal-safe libc calls: the test process can have other threads.
struct PreExecChild {
    pid: libc::pid_t,
    release: Option<File>,
}
impl PreExecChild {
    fn hold_inherited_descriptors() -> Self {
        let mut entered = [0; 2];
        let mut release = [0; 2];
        unsafe {
            assert_eq!(libc::pipe(entered.as_mut_ptr()), 0);
            assert_eq!(libc::pipe(release.as_mut_ptr()), 0);
            let pid = libc::fork();
            assert!(pid >= 0);
            if pid == 0 {
                libc::close(entered[0]);
                libc::close(release[1]);
                let mut byte = [1u8];
                if libc::write(entered[1], byte.as_ptr().cast(), 1) != 1 {
                    libc::_exit(1);
                }
                loop {
                    if libc::read(release[0], byte.as_mut_ptr().cast(), 1) >= 0 {
                        libc::_exit(0);
                    }
                    if *libc::__errno_location() != libc::EINTR {
                        libc::_exit(1);
                    }
                }
            }
            libc::close(entered[1]);
            libc::close(release[0]);
            let child = Self {
                pid,
                release: Some(File::from_raw_fd(release[1])),
            };
            let mut entered = File::from_raw_fd(entered[0]);
            entered.read_exact(&mut [0u8]).unwrap();
            child
        }
    }
}
impl Drop for PreExecChild {
    fn drop(&mut self) {
        // EOF releases the child even when an assertion panics.
        drop(self.release.take());
        unsafe {
            while libc::waitpid(self.pid, std::ptr::null_mut(), 0) < 0 {
                if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                    break;
                }
            }
        }
    }
}

#[tokio::test]
async fn service_drop_releases_ownership_while_a_parallel_child_is_before_exec() {
    let directory = tempfile::tempdir().unwrap();
    let host = Arc::new(LocalHost);
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let child = PreExecChild::hold_inherited_descriptors();
    let recovered = Service::new(directory.path(), host.clone()).unwrap();
    assert_eq!(recovered.activate().unwrap_err().code, "busy");
    service.shutdown();
    assert_eq!(recovered.activate().unwrap_err().code, "busy");
    drop(service);
    // No retry, sleep or child exit: ownership ends when the service is dropped.
    recovered.activate().unwrap();
    drop(child);
    let contender = Service::new(directory.path(), host).unwrap();
    assert_eq!(contender.activate().unwrap_err().code, "busy");
    drop(recovered);
    contender.activate().unwrap();
}
