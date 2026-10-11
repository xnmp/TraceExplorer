//! In-memory credential process IO. Never forwards process diagnostics.
use crate::{
    domain::credential_rules::{command_key, validate_argv, MAX_STDOUT},
    error::{error, Result},
};
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

/// Resolve only against the supplied PATH, in order; never use Windows' implicit
/// executable/system-directory search. Relative PATH entries use the supplied cwd.
pub fn resolve_on_path(
    name: &str,
    path: Option<&std::ffi::OsStr>,
    cwd: &Path,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    #[cfg(windows)]
    let name = if Path::new(name).extension().is_none() {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    std::env::split_paths(path?).find_map(|directory| {
        let candidate = cwd.join(directory).join(&name);
        (candidate.is_absolute() && exists(&candidate)).then_some(candidate)
    })
}

#[cfg(unix)]
type ChildIdentity = i32;
#[cfg(windows)]
type ChildIdentity = usize;
#[derive(Default)]
struct Children {
    stopped: bool,
    live: std::collections::HashSet<ChildIdentity>,
}
static CHILDREN: OnceLock<Mutex<Children>> = OnceLock::new();
static SHUTDOWN: AtomicBool = AtomicBool::new(false);
fn children() -> &'static Mutex<Children> {
    CHILDREN.get_or_init(|| Mutex::new(Children::default()))
}
fn identity(child: &Child) -> ChildIdentity {
    #[cfg(unix)]
    {
        child.id() as i32
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        child.as_raw_handle() as usize
    }
}
fn kill(identity: ChildIdentity) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-identity, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        // Windows descendants of a timed-out helper are not killed.
        #[link(name = "kernel32")]
        extern "system" {
            fn TerminateProcess(handle: *mut std::ffi::c_void, code: u32) -> i32;
        }
        unsafe {
            TerminateProcess(identity as *mut std::ffi::c_void, 1);
        }
    }
}
/// Called on stdin disconnect before process exit. Serialize with spawn and
/// Drop so no child escapes shutdown and no recycled identity is signalled.
pub fn shutdown() {
    let mut registry = children().lock().unwrap_or_else(|e| e.into_inner());
    registry.stopped = true;
    SHUTDOWN.store(true, Ordering::Release);
    for identity in &registry.live {
        kill(*identity);
    }
}

fn unusable() -> te_image_generation_contract::SafeError {
    error("unavailable", "Credential command printed no usable key")
}

/// All exits kill/reap the child, including timeout, cancellation and oversized output.
struct OwnedChild {
    child: Child,
    reaped: bool,
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        {
            let mut registry = children().lock().unwrap_or_else(|e| e.into_inner());
            registry.live.remove(&identity(&self.child));
            if !self.reaped {
                // An unreaped leader pins its PID until the group is killed.
                kill(identity(&self.child));
            }
        }
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

pub fn run(argv: &[String], cancel: &AtomicBool, timeout: Duration) -> Result<String> {
    validate_argv(argv).map_err(|_| unusable())?;
    if cancel.load(Ordering::Acquire) || SHUTDOWN.load(Ordering::Acquire) {
        return Err(error("unavailable", "Credential command was cancelled"));
    }
    // Windows implicitly wraps batch files in cmd.exe. Refuse them rather
    // than weakening the direct-argv contract; explicit pwsh remains allowed.
    #[cfg(windows)]
    if crate::domain::credential_rules::implicit_windows_shell(&argv[0]) {
        return Err(error("unavailable", "Credential command could not start"));
    }
    let started = Instant::now();
    let program = if Path::new(&argv[0]).is_absolute() {
        PathBuf::from(&argv[0])
    } else {
        let cwd = std::env::current_dir()
            .map_err(|_| error("unavailable", "Credential command could not start"))?;
        resolve_on_path(
            &argv[0],
            std::env::var_os("PATH").as_deref(),
            &cwd,
            Path::is_file,
        )
        .ok_or_else(|| error("unavailable", "Credential command could not start"))?
    };
    let mut command = Command::new(program);
    // host.process.run stores stdout/stderr in files. Credential stdout must
    // stay in memory, so spawn directly without a shell and discard stderr.
    // Inherit the environment, including DBUS_SESSION_BUS_ADDRESS for keyrings.
    command
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = {
        let mut registry = children().lock().unwrap_or_else(|e| e.into_inner());
        if registry.stopped || cancel.load(Ordering::Acquire) {
            return Err(error("unavailable", "Credential command was cancelled"));
        }
        let child = command
            .spawn()
            .map_err(|_| error("unavailable", "Credential command could not start"))?;
        registry.live.insert(identity(&child));
        OwnedChild {
            child,
            reaped: false,
        }
    };
    let mut pipe = child.child.stdout.take().ok_or_else(unusable)?;
    prepare_pipe(&pipe).map_err(|_| unusable())?;
    let mut output = Vec::new();
    let mut eof = false;
    let mut status = None;
    loop {
        if cancel.load(Ordering::Acquire) || SHUTDOWN.load(Ordering::Acquire) {
            return Err(error("unavailable", "Credential command was cancelled"));
        }
        if started.elapsed() >= timeout {
            return Err(error("unavailable", "Credential command timed out"));
        }
        if status.is_none() {
            status = observe_status(&mut child).map_err(|_| unusable())?;
        }
        if let Some(exit) = status {
            if !exit.success() {
                return Err(error(
                    "unavailable",
                    &match exit.code() {
                        Some(code) => format!("Credential command exited with status {code}"),
                        None => "Credential command exited without a status code".into(),
                    },
                ));
            }
        }
        // One bounded read per iteration keeps cancellation/deadlines responsive
        // even when a process continuously fills the pipe.
        if !eof {
            let mut buffer = [0; 8192];
            match read_pipe(&mut pipe, &mut buffer) {
                Ok(0) => eof = true,
                Ok(n) => {
                    if output.len() + n > MAX_STDOUT {
                        return Err(unusable());
                    }
                    output.extend_from_slice(&buffer[..n]);
                    continue;
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return Err(unusable()),
            }
        }
        if eof && status.is_some() {
            return command_key(&output).ok_or_else(unusable);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn observe_status(child: &mut OwnedChild) -> io::Result<Option<std::process::ExitStatus>> {
    use std::os::unix::process::ExitStatusExt;
    // Observe without reaping: the leader pins its process-group ID until Drop
    // has killed descendants, including those retaining stdout after its exit.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { info.si_pid() } == 0 {
        return Ok(None);
    }
    let status = unsafe { info.si_status() };
    let raw = match info.si_code {
        libc::CLD_EXITED => status << 8,
        libc::CLD_KILLED => status,
        libc::CLD_DUMPED => status | 0x80,
        _ => return Ok(None),
    };
    Ok(Some(std::process::ExitStatus::from_raw(raw)))
}
#[cfg(windows)]
fn observe_status(child: &mut OwnedChild) -> io::Result<Option<std::process::ExitStatus>> {
    let status = child.child.try_wait()?;
    child.reaped = status.is_some();
    Ok(status)
}

#[cfg(unix)]
fn prepare_pipe(pipe: &ChildStdout) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let fd = pipe.as_raw_fd();
    // The owned pipe remains open for both fcntl calls.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(unix)]
fn read_pipe(pipe: &mut ChildStdout, buffer: &mut [u8]) -> io::Result<usize> {
    pipe.read(buffer)
}

#[cfg(windows)]
fn prepare_pipe(_: &ChildStdout) -> io::Result<()> {
    Ok(())
}
#[cfg(windows)]
fn read_pipe(pipe: &mut ChildStdout, buffer: &mut [u8]) -> io::Result<usize> {
    use std::os::windows::io::AsRawHandle;
    // Anonymous Windows pipes are synchronous. Peek before reading to preserve
    // the same cancellation/timeout contract without a blocking reader thread.
    #[link(name = "kernel32")]
    extern "system" {
        fn PeekNamedPipe(
            handle: *mut std::ffi::c_void,
            buffer: *mut std::ffi::c_void,
            size: u32,
            read: *mut u32,
            available: *mut u32,
            left: *mut u32,
        ) -> i32;
    }
    let mut available = 0;
    let ok = unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        let e = io::Error::last_os_error();
        return if e.raw_os_error() == Some(109) {
            Ok(0)
        } else {
            Err(e)
        };
    }
    if available == 0 {
        return Err(io::ErrorKind::WouldBlock.into());
    }
    let length = buffer.len().min(available as usize);
    pipe.read(&mut buffer[..length])
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn path_lookup_uses_only_path_and_adds_only_exe_for_extensionless_names() {
        let cwd = Path::new(r"C:\work");
        let path = std::ffi::OsStr::new(r"C:\first;C:\second");
        assert_eq!(
            resolve_on_path("helper", Some(path), cwd, |_| true),
            Some(PathBuf::from(r"C:\first\helper.exe"))
        );
        assert_eq!(
            resolve_on_path("helper", Some(path), cwd, |p| p
                == Path::new(r"C:\second\helper.exe")),
            Some(PathBuf::from(r"C:\second\helper.exe"))
        );
        assert_eq!(
            resolve_on_path("helper.com", Some(path), cwd, |_| true),
            Some(PathBuf::from(r"C:\first\helper.com"))
        );
        assert_eq!(resolve_on_path("helper", Some(path), cwd, |_| false), None);
        assert_eq!(resolve_on_path("helper", None, cwd, |_| true), None);
    }

    #[test]
    fn batch_files_never_implicitly_start_a_shell() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("started");
        for extension in ["bat", "CMD"] {
            let path = directory.path().join(format!("helper.{extension}"));
            std::fs::write(
                &path,
                format!(
                    "@echo off\r\necho started>\"{}\"\r\necho fixture-key\r\n",
                    marker.display()
                ),
            )
            .unwrap();
            let failure = run(
                &[path.to_str().unwrap().into()],
                &AtomicBool::new(false),
                Duration::from_secs(1),
            )
            .unwrap_err();
            assert_eq!(failure.message, "Credential command could not start");
            assert!(!marker.exists());
        }
    }
}
