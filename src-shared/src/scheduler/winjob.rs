//! Windows job object that kills the transient rclone daemon when the runner dies for ANY
//! reason. Task Scheduler's ExecutionTimeLimit hard-kills via TerminateProcess, which runs no
//! Rust destructors (DaemonGuard::drop never fires) and does not touch child processes — so a
//! hung, hard-killed runner would orphan its daemon until the next fire's stale-lock reap.
//! JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE ties the daemon's lifetime to this handle instead: the
//! kernel closes every handle of a terminated process, closing the job, killing the members.

use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct KillOnCloseJob {
    handle: HANDLE,
}

// HANDLE is a raw pointer type, hence !Send by default; the handle itself is just a kernel
// object reference — closed exactly once (Drop) and never dereferenced.
unsafe impl Send for KillOnCloseJob {}

impl KillOnCloseJob {
    /// Creates a kill-on-close job and assigns `child` to it. Best-effort by contract: on Err
    /// the caller proceeds without the safety net (the graceful DaemonGuard shutdown and the
    /// next run's stale-lock reap still apply, as before this existed).
    pub fn assign(child: &std::process::Child) -> Result<Self, String> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(format!(
                    "CreateJobObject failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(format!("SetInformationJobObject failed: {}", error));
            }
            if AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) == 0 {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(format!("AssignProcessToJobObject failed: {}", error));
            }
            Ok(Self { handle })
        }
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        // In the normal path the daemon is already down (DaemonGuard's graceful shutdown runs
        // first); closing the last job handle only kills a survivor. On TerminateProcess the
        // kernel performs this close for us — that is the entire point.
        unsafe { CloseHandle(self.handle) };
    }
}
