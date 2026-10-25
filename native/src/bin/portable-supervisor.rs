// Packaging-only supervisor. It never injects input or terminates a running child.
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows x64 required");
    std::process::exit(1);
}
#[cfg(windows)]
mod platform {
    use std::{
        collections::hash_map::DefaultHasher,
        ffi::c_void,
        fs,
        hash::{Hash, Hasher},
        os::windows::fs::MetadataExt,
        path::Path,
        thread,
        time::Duration,
        time::{SystemTime, UNIX_EPOCH},
    };
    type Raw = *mut c_void;
    #[repr(C)]
    struct Security {
        size: u32,
        descriptor: Raw,
        inherit: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Startup {
        size: u32,
        reserved: Raw,
        desktop: Raw,
        title: Raw,
        x: u32,
        y: u32,
        dx: u32,
        dy: u32,
        chars_x: u32,
        chars_y: u32,
        fill: u32,
        flags: u32,
        show: u16,
        reserved_size: u16,
        reserved_ptr: Raw,
        input: Raw,
        output: Raw,
        error: Raw,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Process {
        process: Raw,
        thread: Raw,
        pid: u32,
        tid: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Accounting {
        user: i64,
        kernel: i64,
        period_user: i64,
        period_kernel: i64,
        page_faults: u32,
        total: u32,
        active: u32,
        terminated: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const Security,
            creation: u32,
            flags: u32,
            template: Raw,
        ) -> Raw;
        fn CloseHandle(handle: Raw) -> i32;
        fn CreateJobObjectW(security: *const Security, name: *const u16) -> Raw;
        fn OpenJobObjectW(access: u32, inherit: i32, name: *const u16) -> Raw;
        fn QueryInformationJobObject(
            job: Raw,
            class: u32,
            info: Raw,
            size: u32,
            returned: *mut u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Raw, process: Raw) -> i32;
        fn CreateProcessW(
            app: *const u16,
            command: *mut u16,
            pa: Raw,
            ta: Raw,
            inherit: i32,
            flags: u32,
            env: Raw,
            dir: *const u16,
            startup: *const Startup,
            process: *mut Process,
        ) -> i32;
        fn ResumeThread(thread: Raw) -> u32;
        fn TerminateProcess(process: Raw, code: u32) -> i32;
        fn GetStdHandle(kind: u32) -> Raw;
        fn GetExitCodeProcess(process: Raw, code: *mut u32) -> i32;
    }
    struct Handle(Raw);
    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: Handle uniquely owns a successful kernel handle.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    fn error(label: &str) -> String {
        format!("{label}: {}", std::io::Error::last_os_error())
    }
    fn reparse_free(path: &Path) -> Result<(), String> {
        for p in path.ancestors() {
            if let Ok(m) = fs::symlink_metadata(p)
                && m.file_attributes() & 0x400 != 0
            {
                return Err("reparse path rejected".into());
            }
        }
        Ok(())
    }
    fn lock(path: &Path, shared: bool, inherit: bool) -> Result<Handle, String> {
        reparse_free(path)?;
        let name = wide(&path.to_string_lossy());
        let sa = Security {
            size: std::mem::size_of::<Security>() as u32,
            descriptor: std::ptr::null_mut(),
            inherit: inherit as i32,
        };
        // SAFETY: nul-terminated name and valid SECURITY_ATTRIBUTES remain alive for the call.
        let h = unsafe {
            CreateFileW(
                name.as_ptr(),
                0xc0000000,
                if shared { 3 } else { 0 },
                &sa,
                4,
                0x80,
                std::ptr::null_mut(),
            )
        };
        if h as isize == -1 {
            return Err(error("busy: component lease unavailable"));
        }
        Ok(Handle(h))
    }
    fn active(job: Raw) -> Result<u32, String> {
        let mut info = Accounting::default();
        // SAFETY: Accounting matches JOBOBJECT_BASIC_ACCOUNTING_INFORMATION and buffer is writable.
        if unsafe {
            QueryInformationJobObject(
                job,
                1,
                &mut info as *mut _ as Raw,
                std::mem::size_of::<Accounting>() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(error("job query failed"));
        }
        Ok(info.active)
    }
    fn assert_no_jobs(dir: &Path) -> Result<(), String> {
        for e in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            reparse_free(&e.path())?;
            let name = fs::read_to_string(e.path()).map_err(|e| e.to_string())?;
            if !name.starts_with("Local\\HumanPortable.") || name.len() > 180 {
                return Err("invalid durable job journal".into());
            }
            let w = wide(&name);
            // SAFETY: opens only a named job for accounting, no process mutation.
            let raw = unsafe { OpenJobObjectW(4, 0, w.as_ptr()) };
            if raw.is_null() {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() != Some(2) {
                    return Err(format!("cannot establish child exit: {err}"));
                }
            } else {
                let job = Handle(raw);
                if active(job.0)? > 0 {
                    return Err("busy: prior supervised child tree still running".into());
                }
            }
            fs::remove_file(e.path()).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn quote(s: &str) -> String {
        let mut out = String::from("\"");
        let mut slashes = 0;
        for c in s.chars() {
            if c == '\\' {
                slashes += 1;
            } else {
                if c == '\"' {
                    out.push_str(&"\\".repeat(slashes * 2 + 1));
                } else {
                    out.push_str(&"\\".repeat(slashes));
                }
                out.push(c);
                slashes = 0;
            }
        }
        out.push_str(&"\\".repeat(slashes * 2));
        out.push('"');
        out
    }
    pub fn run() -> Result<i32, String> {
        let a: Vec<String> = std::env::args().skip(1).collect();
        if a.len() < 4
            || !matches!(a[1].as_str(), "human" | "touch")
            || !matches!(a[2].as_str(), "shared" | "exclusive" | "probe")
        {
            return Err(
                "usage: portable-supervisor ROOT human|touch shared|exclusive|probe EXE [ARGS]"
                    .into(),
            );
        }
        let root = fs::canonicalize(&a[0]).map_err(|e| e.to_string())?;
        reparse_free(&root)?;
        let locks = root.join("state/locks");
        reparse_free(&locks)?;
        fs::create_dir_all(&locks).map_err(|e| e.to_string())?;
        let journal = root.join("state/jobs").join(&a[1]);
        reparse_free(&journal)?;
        fs::create_dir_all(&journal).map_err(|e| e.to_string())?;
        // A probe already belongs to the outer component Job/lease, but needs an
        // independent subtree completion boundary. Reacquiring the exclusive
        // update's component lease here would deadlock that update.
        let gate = if a[2] == "probe" {
            None
        } else {
            Some(lock(&locks.join(format!("{}.gate", a[1])), false, false)?)
        };
        let lease = if a[2] == "probe" {
            None
        } else {
            Some(lock(
                &locks.join(format!("{}.lease", a[1])),
                a[2] == "shared",
                true,
            )?)
        };
        if a[2] == "exclusive" {
            assert_no_jobs(&journal)?;
        }
        let mut hasher = DefaultHasher::new();
        root.to_string_lossy().to_lowercase().hash(&mut hasher);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let name = format!(
            "Local\\HumanPortable.{:x}.{}.{}.{nonce}",
            hasher.finish(),
            a[1],
            std::process::id()
        );
        let w = wide(&name);
        let sa = Security {
            size: std::mem::size_of::<Security>() as u32,
            descriptor: std::ptr::null_mut(),
            inherit: 1,
        };
        // SAFETY: repr(C) SECURITY_ATTRIBUTES has its correct size and a null
        // default descriptor; it and the nul-terminated UTF-16 name outlive this
        // call. A non-null result becomes the uniquely owned Handle below.
        let raw = unsafe { CreateJobObjectW(&sa, w.as_ptr()) };
        if raw.is_null() {
            return Err(error("job creation failed"));
        }
        let job = Handle(raw);
        let entry = journal.join(format!("{nonce}.job"));
        fs::write(&entry, &name).map_err(|e| e.to_string())?;
        // SAFETY: this single-threaded packaging process owns its environment, before CreateProcess snapshots it.
        unsafe {
            for (key, _) in std::env::vars() {
                let upper = key.to_uppercase();
                if matches!(
                    upper.as_str(),
                    "NODE_OPTIONS"
                        | "NODE_PATH"
                        | "HUMAN_INPUT_WORKER"
                        | "DOTNET_STARTUP_HOOKS"
                        | "DOTNET_ADDITIONAL_DEPS"
                        | "DOTNET_SHARED_STORE"
                ) || upper.starts_with("COR_")
                    || upper.starts_with("CORECLR_")
                {
                    std::env::remove_var(key);
                }
            }
            let display = root.to_string_lossy();
            std::env::set_var(
                "HUMAN_PORTABLE_ROOT",
                display.strip_prefix(r"\\?\").unwrap_or(&display),
            );
            std::env::set_var("HUMAN_PORTABLE_COMPONENT", &a[1]);
            std::env::set_var("HUMAN_PORTABLE_MODE", &a[2]);
        }
        let app = wide(&a[3]);
        let mut cmd = wide(
            &a[3..]
                .iter()
                .map(|s| quote(s))
                .collect::<Vec<_>>()
                .join(" "),
        );
        let mut startup = Startup {
            size: std::mem::size_of::<Startup>() as u32,
            flags: 0x100,
            ..Default::default()
        };
        // SAFETY: retrieving inherited standard handles has no ownership transfer.
        unsafe {
            startup.input = GetStdHandle((-10i32) as u32);
            startup.output = GetStdHandle((-11i32) as u32);
            startup.error = GetStdHandle((-12i32) as u32);
        }
        let mut pi = Process::default();
        // SAFETY: all pointers are valid for call; writable command buffer is nul terminated. Suspended launch closes assignment race.
        if unsafe {
            CreateProcessW(
                app.as_ptr(),
                cmd.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                4 | 0x08000000,
                std::ptr::null_mut(),
                std::ptr::null(),
                &startup,
                &mut pi,
            )
        } == 0
        {
            return Err(error("child start failed"));
        }
        let process = Handle(pi.process);
        let thread = Handle(pi.thread);
        // SAFETY: child is still suspended and cannot have run any input operation.
        if unsafe { AssignProcessToJobObject(job.0, process.0) } == 0 {
            let why = error("job assignment failed");
            // SAFETY: process owns the handle returned by successful CreateProcessW.
            // Its primary thread is still suspended; no child code/input ran.
            unsafe {
                TerminateProcess(process.0, 1);
            }
            return Err(why);
        }
        // SAFETY: live suspended primary thread belongs to our child.

        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            let why = error("child resume failed");
            // SAFETY: the owned process handle is still live. ResumeThread failed
            // for the initially suspended primary thread, so child code never ran.
            unsafe {
                TerminateProcess(process.0, 1);
            }
            return Err(why);
        }
        drop(thread);
        drop(gate);
        while active(job.0)? > 0 {
            thread::sleep(Duration::from_millis(40));
        }
        let mut code = 1;
        // SAFETY: retained process handle and writable exit code pointer.
        if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
            return Err(error("child exit status unavailable"));
        }
        let _ = fs::remove_file(entry);
        drop(lease);
        Ok(code as i32)
    }
    #[cfg(test)]
    mod tests {
        use super::quote;
        #[test]
        fn quotes_windows_arguments() {
            assert_eq!(quote("a b"), "\"a b\"");
            assert_eq!(quote("C:\\空 格\\"), "\"C:\\空 格\\\\\"");
            assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        }
    }
}
#[cfg(windows)]
fn main() {
    match platform::run() {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("[portable] {e}");
            std::process::exit(1)
        }
    }
}
