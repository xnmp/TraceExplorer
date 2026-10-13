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

// Keep candidate contexts and the exact eligibility gate on the same statuses.
const CONTEXT_STATUSES: &str = "('running','uncertain','interrupted','succeeded')";

/// SQL-only superset of `may_have_trace_at`, without traced-file stats, hashes,
/// or folder index builds. Stored artifact/locator paths were canonicalized by
/// `normalize_path` (and contexts by `context_key`), so their direct parents
/// use the same canonical namespace as `key`. Do not canonicalize each path
/// again: offline volumes and removed files must remain candidates. Simplify
/// legacy Windows verbatim prefixes with dunce, just as `key` does. Frontend
/// membership uses directoryKey for separators, trailing slashes and Windows
/// case; POSIX case remains significant.
///
/// Every exact positive, after `key` canonicalization, has a direct
/// artifact/locator or eligible context in this set. This cannot enumerate
/// arbitrary filesystem aliases of those directories; a host retaining alias
/// spellings needs a canonical identity before treating absence as definitive.
/// Missing/discarded outputs, dismissed runs and empty components deliberately
/// remain false positives. Only immediate parents are emitted.
/// Complexity: one SQL scan, O(total path bytes) expected hash deduplication,
/// O(D log D) sorting and O(D) retained directories. No per-directory queries.
fn candidates_at(database: &Path) -> Result<Vec<String>, AppError> {
    // Only the DB's existence is checked, never any recorded path. Opening
    // read-only avoids creating a journal or running schema/index setup.
    if !database.exists() {
        return Ok(Vec::new());
    }
    let connection =
        Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(sql)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(sql)?;
    let query = format!("SELECT path,0 FROM artifacts UNION ALL SELECT path,0 FROM artifact_locators UNION ALL SELECT c.folder,1 FROM image_folder_contexts c JOIN runs r ON r.id=c.run_id WHERE r.status IN {CONTEXT_STATUSES}");
    let mut statement = connection.prepare(&query).map_err(sql)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })
        .map_err(sql)?;
    let mut directories = HashSet::new();
    for row in rows {
        let (value, context) = row.map_err(sql)?;
        let path = Path::new(&value);
        let directory = if context { Some(path) } else { path.parent() };
        if let Some(directory) = directory.filter(|directory| directory.is_absolute()) {
            directories.insert(
                dunce::simplified(&lexical_path(directory))
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    let mut directories: Vec<_> = directories.into_iter().collect();
    directories.sort_unstable();
    Ok(directories)
}

pub(crate) async fn candidates() -> Result<Vec<String>, AppError> {
    tokio::task::spawn_blocking(|| candidates_at(&database_path()?))
        .await
        .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

/// Whether the folder has a Trace section. Eligibility is read from the same
/// cached folder index the view shows, so a folder is never offered the Trace
/// view with nothing to show (for example one whose only history is failed
/// edits). The cheap `may_have_trace_at` check runs first: browsing folders
/// without provenance never builds an index.
pub(super) fn has_trace_at(database: &Path, directory: &Path) -> Result<bool, AppError> {
    Ok(may_have_trace_at(database, directory)?.0
        && folder_graph::has_components_at(database, directory)?)
}

/// A necessary condition for a Trace section: some file recorded directly in
/// the folder is present, or one of its unsaved generations is active or has
/// a present output. It covers every seed of the folder index
/// (`folder_graph::load_snapshot`), so `false` means the index is empty; `true`
/// means the index decides. The second value says whether the answer may be
/// cached by the folder's mtime: only folder-local results can.
fn may_have_trace_at(database: &Path, directory: &Path) -> Result<(bool, bool), AppError> {
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
    // folder. As in the Trace folder index (`folder_graph::load_snapshot`):
    // an active run is shown, and a finished or interrupted run is shown
    // through any newest revision of its outputs that is present and not
    // discarded.
    let mut contexts = connection.prepare(&format!("SELECT r.id,r.status,r.dismissed_at IS NOT NULL FROM image_folder_contexts c JOIN runs r ON r.id=c.run_id WHERE c.folder=?1 AND r.status IN {CONTEXT_STATUSES}")).map_err(sql)?;
    let rows = contexts
        .query_map([directory], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })
        .map_err(sql)?;
    let mut has_context = false;
    for row in rows {
        has_context = true;
        let (id, status, dismissed) = row.map_err(sql)?;
        // A dismissed Interrupted run (still `uncertain`) counts as a context (so the answer
        // is not cached by mtime) but no longer makes the folder eligible.
        if matches!(status.as_str(), "running" | "uncertain")
            && !super::dismiss::hides_placeholder(&status, dismissed)
        {
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
        let database = database_path()?;
        let cached = cache
            .lock()
            .map_err(|_| AppError::Other("Folder trace cache unavailable".into()))?
            .iter()
            .find(|(path, (mtime, version, _))| {
                path == &directory && *mtime == modified && *version == revision
            })
            .map(|(_, (_, _, candidate))| *candidate);
        let candidate = match cached {
            Some(candidate) => candidate,
            None => {
                let (candidate, cacheable) = may_have_trace_at(&database, Path::new(&directory))?;
                let mut cache = cache
                    .lock()
                    .map_err(|_| AppError::Other("Folder trace cache unavailable".into()))?;
                cache.retain(|(path, _)| path != &directory);
                if cacheable {
                    cache.insert(0, (directory.clone(), (modified, revision, candidate)));
                }
                cache.truncate(128);
                candidate
            }
        };
        // The index is cached per token and shared with the view, so a folder
        // the view then opens is not indexed twice.
        Ok(candidate && folder_graph::has_components_at(&database, Path::new(&directory))?)
    })
    .await
    .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn insert_artifact(connection: &Connection, path: &Path) -> i64 {
        connection
            .execute(
                "INSERT INTO artifacts(path,digest) VALUES(?1,'test')",
                [path.to_string_lossy()],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    #[test]
    fn candidate_empty_and_missing_databases_do_not_create_history() {
        let root = crate::test_support::tempdir().unwrap();
        let db = root.path().join("trace.sqlite");
        assert!(candidates_at(&db).unwrap().is_empty());
        assert!(!db.exists());
        connection_at(&db).unwrap();
        assert!(candidates_at(&db).unwrap().is_empty());
    }

    #[test]
    fn candidates_include_only_direct_parents_and_ignore_file_presence() {
        let root = crate::test_support::tempdir().unwrap();
        let db = root.path().join("trace.sqlite");
        let child = root.path().join("pictures").join("nested");
        fs::create_dir_all(&child).unwrap();
        let child = PathBuf::from(key(&child).unwrap());
        let connection = connection_at(&db).unwrap();
        let artifact = insert_artifact(&connection, &child.join("gone.png"));
        let locator_folder = root.path().join("locator-only");
        connection
            .execute(
                "INSERT INTO artifact_locators(artifact_id,path,digest) VALUES(?1,?2,'test')",
                params![artifact, locator_folder.join("gone.png").to_string_lossy()],
            )
            .unwrap();
        let actual: HashSet<_> = candidates_at(&db).unwrap().into_iter().collect();
        let expected: HashSet<_> = [
            child.to_string_lossy().into_owned(),
            locator_folder.to_string_lossy().into_owned(),
        ]
        .into_iter()
        .collect();
        assert_eq!(actual, expected);
        assert!(!actual.contains(&child.parent().unwrap().to_string_lossy().into_owned()));
        assert!(!has_trace_at(&db, &child).unwrap()); // SQL superset includes missing files
    }

    #[test]
    fn candidate_contexts_share_eligibility_statuses_and_normalize_roots() {
        let root = crate::test_support::tempdir().unwrap();
        let db = root.path().join("trace.sqlite");
        let connection = connection_at(&db).unwrap();
        let folder = PathBuf::from(key(root.path()).unwrap());
        let filesystem_root = folder.ancestors().last().unwrap();
        insert_artifact(
            &connection,
            &filesystem_root.join("trace-candidate-test.png"),
        );
        let statuses = [
            "running",
            "uncertain",
            "interrupted",
            "succeeded",
            "failed",
            "cancelled",
        ];
        for status in statuses {
            connection.execute("INSERT INTO runs(operation,parameters,status,dismissed_at) VALUES('test','{}',?1,'dismissed')", [status]).unwrap();
            let id = connection.last_insert_rowid();
            // No folder needs to exist; trailing separators must key identically.
            connection
                .execute(
                    "INSERT INTO image_folder_contexts(folder,run_id) VALUES(?1,?2)",
                    params![
                        format!(
                            "{}{}",
                            folder.join(status).display(),
                            std::path::MAIN_SEPARATOR
                        ),
                        id
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO runs(operation,parameters,status) VALUES('test','{}','running')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO image_folder_contexts(folder,run_id) VALUES(?1,?2)",
                params![
                    format!("{}{}", filesystem_root.display(), std::path::MAIN_SEPARATOR),
                    connection.last_insert_rowid()
                ],
            )
            .unwrap();
        let actual: HashSet<_> = candidates_at(&db).unwrap().into_iter().collect();
        let expected: HashSet<_> = ["running", "uncertain", "interrupted", "succeeded"]
            .into_iter()
            .map(|status| folder.join(status).to_string_lossy().into_owned())
            .chain([filesystem_root.to_string_lossy().into_owned()])
            .collect();
        assert_eq!(actual, expected);
    }

    #[cfg(unix)]
    #[test]
    fn candidate_namespace_matches_exact_canonical_keys_not_symlink_aliases() {
        let root = crate::test_support::tempdir().unwrap();
        let db = root.path().join("trace.sqlite");
        let real = root.path().join("real");
        let alias = root.path().join("alias");
        fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let image = real.join("recorded.png");
        fs::write(&image, b"test").unwrap();
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
        assert!(has_trace_at(&db, &alias).unwrap());
        let candidates = candidates_at(&db).unwrap();
        assert!(candidates.contains(&key(&alias).unwrap()));
        assert!(!candidates.contains(&alias.to_string_lossy().into_owned()));
    }

    #[test]
    fn large_candidate_scan_deduplicates_revisions_and_locators() {
        // 30k artifacts + 30k locators but only 100 folders. One streaming SQL
        // scan and a directory set, not 60k canonicalizations/index builds.
        let root = crate::test_support::tempdir().unwrap();
        let db = root.path().join("trace.sqlite");
        let mut connection = connection_at(&db).unwrap();
        let tx = connection.transaction().unwrap();
        for index in 0..30_000 {
            let folder = root.path().join(format!("folder-{}", index % 100));
            let path = folder.join(format!("image-{index}.png"));
            let id = insert_artifact(&tx, &path);
            tx.execute(
                "INSERT INTO artifact_locators(artifact_id,path,digest) VALUES(?1,?2,'test')",
                params![id, path.to_string_lossy()],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        assert_eq!(candidates_at(&db).unwrap().len(), 100);
    }

    #[cfg(windows)]
    #[test]
    fn candidates_simplify_legacy_windows_paths_without_stats() {
        let root = crate::test_support::tempdir().unwrap();
        let db = root.path().join("trace.sqlite");
        let connection = connection_at(&db).unwrap();
        insert_artifact(&connection, Path::new(r"\\?\C:\Pictures\missing.png"));
        insert_artifact(&connection, Path::new(r"C:\root.png"));
        assert_eq!(candidates_at(&db).unwrap(), vec![r"C:\", r"C:\Pictures"]);
    }

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
        assert!(candidates_at(&db).unwrap().contains(&key(&child).unwrap()));
        fs::write(&image, b"modified current revision").unwrap();
        assert!(has_trace_at(&db, &child).unwrap());
        fs::remove_file(&image).unwrap();
        assert!(!has_trace_at(&db, &child).unwrap());
    }
}
