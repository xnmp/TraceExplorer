//! Directory-entry durability barrier for create/link/rename/delete, shared by
//! the Trace backend and the Image Generation provider. The host carries the
//! same contract in its own `durable_dir.rs`; keep the two in step.
//!
//! Unix fsyncs the directory. Windows has no directory fsync, but NTFS commits
//! a directory's metadata (and the earlier journal records it depends on) when
//! a writable directory handle is flushed; native windows-2022 qualification
//! measured that flush succeeding. A refused flush stays an error, so callers
//! fail closed instead of claiming durability.
use std::{io, path::Path};

pub fn sync(directory: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let handle = std::fs::File::open(directory)?;
        if !handle.metadata()?.is_dir() {
            return Err(not_a_directory());
        }
        handle.sync_all()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_SHARE_ALL: u32 = 0x1 | 0x2 | 0x4;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_ALL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(directory)?;
        let metadata = handle.metadata()?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(not_a_directory());
        }
        handle.sync_all()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = directory;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "directory durability is unavailable on this platform",
        ))
    }
}

#[cfg(any(unix, windows))]
fn not_a_directory() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "durable directory must be a real directory",
    )
}

#[cfg(test)]
mod tests {
    use super::sync;
    use std::path::PathBuf;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "te-durable-dir-{name}-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn commits_a_directory_after_entries_change() {
        let root = Scratch::new("entries");
        std::fs::write(root.0.join("entry"), b"bytes").unwrap();
        sync(&root.0).unwrap();
        std::fs::remove_file(root.0.join("entry")).unwrap();
        sync(&root.0).unwrap();
    }
    #[test]
    fn refuses_a_regular_file_or_missing_directory() {
        let root = Scratch::new("refusal");
        let file = root.0.join("file");
        std::fs::write(&file, b"bytes").unwrap();
        assert!(sync(&file).is_err());
        assert!(sync(&root.0.join("absent")).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn refuses_a_junction_instead_of_flushing_its_target() {
        let root = Scratch::new("junction");
        let target = root.0.join("target");
        let junction = root.0.join("junction");
        std::fs::create_dir(&target).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(sync(&junction).is_err());
        sync(&target).unwrap();
    }
}
