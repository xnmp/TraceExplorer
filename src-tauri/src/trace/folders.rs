//! Folder visibility uses locator indexes and existence checks, never image hashes.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
static REVISION: AtomicU64 = AtomicU64::new(0);
pub(crate) fn invalidate() {
    REVISION.fetch_add(1, Ordering::Relaxed);
}
pub(super) fn revision() -> u64 {
    REVISION.load(Ordering::Relaxed)
}

pub(super) fn key(directory: &Path) -> Result<String, AppError> {
    if !directory.is_absolute() {
        return Err(AppError::InvalidPath(
            "Trace requires a local absolute folder".into(),
        ));
    }
    let directory = fs::canonicalize(directory)?;
    if !directory.is_dir() {
        return Err(AppError::InvalidPath("Trace requires a folder".into()));
    }
    Ok(dunce::simplified(&directory).to_string_lossy().into_owned())
}

// Persist historical absolute hints even when their volume is temporarily absent.
pub(super) fn context_key(directory: &Path) -> Result<String, AppError> {
    if !directory.is_absolute() {
        return Err(AppError::InvalidPath(
            "Trace requires an absolute folder hint".into(),
        ));
    }
    let resolved = resolve_context_path(directory, 32);
    Ok(dunce::simplified(&resolved).to_string_lossy().into_owned())
}

// Canonicalize the existing prefix and resolve dangling links while a volume is offline.
fn resolve_context_path(path: &Path, remaining_links: u8) -> PathBuf {
    if let Ok(resolved) = fs::canonicalize(path) {
        return resolved;
    }
    if remaining_links > 0 {
        for ancestor in path.ancestors() {
            let suffix = path.strip_prefix(ancestor).expect("path ancestor");
            if let Ok(target) = fs::read_link(ancestor) {
                let target = if target.is_absolute() {
                    target
                } else {
                    ancestor.parent().unwrap_or(ancestor).join(target)
                };
                return resolve_context_path(&target.join(suffix), remaining_links - 1);
            }
            if let Ok(prefix) = fs::canonicalize(ancestor) {
                return lexical_path(&prefix.join(suffix));
            }
        }
    }
    lexical_path(path)
}

fn lexical_path(path: &Path) -> PathBuf {
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            _ => resolved.push(component.as_os_str()),
        }
    }
    resolved
}

pub(super) fn has_trace_at(database: &Path, directory: &Path) -> Result<bool, AppError> {
    Ok(folder_state_at(database, directory)?.0)
}

// Only folder-local results can use the directory mtime as a cache token.
fn folder_state_at(database: &Path, directory: &Path) -> Result<(bool, bool), AppError> {
    if !database.exists() {
        return Ok((false, true));
    }
    let directory = key(directory)?;
    let separator = std::path::MAIN_SEPARATOR;
    let prefix = if directory.ends_with(separator) {
        directory.clone()
    } else {
        format!("{directory}{separator}")
    };
    let mut upper = prefix.clone();
    upper.pop();
    upper.push(char::from_u32(separator as u32 + 1).expect("ASCII path separator"));
    let connection = connection_at(database)?;
    let mut statement = connection.prepare("SELECT path FROM artifacts WHERE path>=?1 AND path<?2 AND instr(substr(path,?3),?4)=0 UNION ALL SELECT path FROM artifact_locators WHERE path>=?1 AND path<?2 AND instr(substr(path,?3),?4)=0").map_err(sql)?;
    let rows = statement
        .query_map(
            params![
                prefix,
                upper,
                prefix.chars().count() as i64 + 1,
                separator.to_string()
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(sql)?;
    for path in rows {
        if Path::new(&path.map_err(sql)?).is_file() {
            return Ok((true, true));
        }
    }
    // Unsaved generation workflows remain reachable in their intended save
    // folder. Mirrors the Trace folder index (`folder_graph::load_snapshot`):
    // an active run is shown, and a finished or interrupted run is shown
    // through any newest revision of its outputs that is present and not
    // discarded.
    let mut contexts = connection.prepare("SELECT r.id,r.status FROM image_folder_contexts c JOIN runs r ON r.id=c.run_id WHERE c.folder=?1 AND r.status IN ('running','uncertain','interrupted','succeeded')").map_err(sql)?;
    let rows = contexts
        .query_map([directory], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sql)?;
    let mut has_context = false;
    for row in rows {
        has_context = true;
        let (id, status) = row.map_err(sql)?;
        if matches!(status.as_str(), "running" | "uncertain") {
            return Ok((true, false));
        }
        let mut outputs=connection.prepare("SELECT a.path FROM artifacts a WHERE a.generating_run=?1 AND NOT EXISTS(SELECT 1 FROM image_discards d WHERE d.artifact_id=a.id AND d.completed=1) AND NOT EXISTS(SELECT 1 FROM artifacts n WHERE n.path=a.path AND n.id>a.id)").map_err(sql)?;
        for path in outputs
            .query_map([id], |row| row.get::<_, String>(0))
            .map_err(sql)?
        {
            if Path::new(&path.map_err(sql)?).is_file() {
                return Ok((true, false));
            }
        }
    }
    Ok((false, !has_context))
}

pub(crate) async fn has_trace(directory: String) -> Result<bool, AppError> {
    type CacheEntry = (Option<std::time::SystemTime>, u64, bool);
    static CACHE: std::sync::OnceLock<Mutex<Vec<(String, CacheEntry)>>> =
        std::sync::OnceLock::new();
    tokio::task::spawn_blocking(move || {
        let directory = key(Path::new(&directory))?;
        let modified = fs::metadata(&directory)?.modified().ok();
        let revision = REVISION.load(Ordering::Relaxed);
        let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
        if let Some((_, (_, _, eligible))) = cache
            .lock()
            .map_err(|_| AppError::Other("Folder trace cache unavailable".into()))?
            .iter()
            .find(|(path, (mtime, version, _))| {
                path == &directory && *mtime == modified && *version == revision
            })
        {
            return Ok(*eligible);
        }
        let (eligible, cacheable) = folder_state_at(&database_path()?, Path::new(&directory))?;
        let mut cache = cache
            .lock()
            .map_err(|_| AppError::Other("Folder trace cache unavailable".into()))?;
        cache.retain(|(path, _)| path != &directory);
        if cacheable {
            cache.insert(0, (directory, (modified, revision, eligible)));
        }
        cache.truncate(128);
        Ok(eligible)
    })
    .await
    .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_direct_present_files_qualify_and_modified_bytes_need_no_hash() {
        let root = crate::test_support::tempdir().unwrap();
        let db = root.path().join("trace.sqlite");
        let folder = root.path().join("pictures");
        let child = folder.join("child");
        fs::create_dir_all(&child).unwrap();
        let image = child.join("recorded.png");
        fs::write(&image, b"original").unwrap();
        record_operation_at(
            &db,
            OperationRecord {
                operation: "image.test".into(),
                parameters: serde_json::Value::Null,
                inputs: vec![],
                output_path: image.to_string_lossy().into_owned(),
                output_digest: digest(&image).unwrap(),
            },
        )
        .unwrap();
        assert!(!has_trace_at(&db, &folder).unwrap());
        assert!(has_trace_at(&db, &child).unwrap());
        fs::write(&image, b"modified current revision").unwrap();
        assert!(has_trace_at(&db, &child).unwrap());
        fs::remove_file(&image).unwrap();
        assert!(!has_trace_at(&db, &child).unwrap());
    }
}
