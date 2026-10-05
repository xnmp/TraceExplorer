//! Attach a suspended launcher before it can create any descendants.
use std::{cell::Cell, io, os::windows::io::AsRawHandle, process::Child};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::*,
        JobObjects::*,
        Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
    },
};
pub(super) struct Job(Cell<HANDLE>);
impl Job {
    pub(super) fn new() -> io::Result<Self> {
        // SAFETY: unnamed, noninheritable job; null security descriptor is valid.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(Cell::new(handle));
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: correctly sized Win32 limit structure and owned live handle.
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
    pub(super) fn attach_and_resume(&self, child: &mut Child) -> io::Result<()> {
        // SAFETY: Child retains this process handle. Its primary thread has
        // CREATE_SUSPENDED, so no descendant can escape before assignment.
        if unsafe { AssignProcessToJobObject(self.0.get(), child.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: snapshot enumerates thread metadata; all handles are closed.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let result = (|| {
            let mut found = unsafe { Thread32First(snapshot, &mut entry) } != 0;
            while found {
                if entry.th32OwnerProcessID == child.id() {
                    let thread =
                        unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                    if thread.is_null() {
                        return Err(io::Error::last_os_error());
                    }
                    let resumed = unsafe { ResumeThread(thread) };
                    let error = if resumed == u32::MAX {
                        Some(io::Error::last_os_error())
                    } else {
                        None
                    };
                    unsafe {
                        CloseHandle(thread);
                    }
                    return error.map_or(Ok(()), Err);
                }
                found = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
            }
            Err(io::Error::other("Suspended process thread is unavailable"))
        })();
        unsafe {
            CloseHandle(snapshot);
        }
        result
    }
    pub(super) fn terminate(&self) {
        let handle = self.0.replace(std::ptr::null_mut());
        if !handle.is_null() {
            unsafe {
                CloseHandle(handle);
            }
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        self.terminate();
    }
}
