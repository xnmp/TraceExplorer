//! Durable, read-only provenance for committed image transformations.
//! Artifact identity includes content and path; source revisions are never
//! inferred from a filename after it has changed.
use crate::{config, error::AppError, image_crop};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

const MAX_IMAGE_BYTES: u64 = 200 * 1024 * 1024;
static TRACE_OWNER: OnceLock<Mutex<Option<File>>> = OnceLock::new();

pub(crate) struct CropMetadata {
    pub source_path: String,
    pub source_digest: String,
    pub rect: image_crop::CropRect,
    pub viewport: image_crop::SvgViewport,
}

#[derive(Clone)]
pub(crate) struct TraceRunHandle {
    database: PathBuf,
    id: i64,
}

pub(crate) struct OperationInput {
    pub path: String,
    pub digest: String,
}

#[cfg(test)]
struct OperationRecord {
    pub operation: String,
    pub parameters: serde_json::Value,
    pub inputs: Vec<OperationInput>,
    pub output_path: String,
    pub output_digest: String,
}

pub(crate) struct OperationStart {
    pub operation: String,
    pub parameters: serde_json::Value,
    pub inputs: Vec<OperationInput>,
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_start(start: &OperationStart) -> Result<(), AppError> {
    if start.inputs.len() > 16 {
        return Err(AppError::Other(
            "Trace operation accepts at most 16 inputs".into(),
        ));
    }
    if start.operation.is_empty() || start.operation.len() > 128 {
        return Err(AppError::Other("Invalid Trace operation name".into()));
    }
    if start
        .inputs
        .iter()
        .any(|input| !valid_digest(&input.digest))
    {
        return Err(AppError::Other("Invalid Trace content digest".into()));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Artifact {
    id: i64,
    path: String,
    digest: String,
    created_at: String,
    generating_run: Option<i64>,
    path_state: ArtifactPathState,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ArtifactPathState {
    Present,
    Missing,
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Run {
    id: i64,
    operation: String,
    parameters: serde_json::Value,
    created_at: String,
    status: String,
    finished_at: Option<String>,
    error: Option<String>,
    recovered: bool,
    details: Option<serde_json::Value>,
    input_ids: Vec<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceGraph {
    current_artifact_id: i64,
    selected_revision_status: SelectedRevisionStatus,
    artifacts: Vec<Artifact>,
    runs: Vec<Run>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageRunHistory {
    run: Run,
    output_path: Option<String>,
    prepared_output_path: Option<String>,
}

fn read_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    let parameters: String = row.get(2)?;
    Ok(Run {
        id: row.get(0)?,
        operation: row.get(1)?,
        parameters: serde_json::from_str(&parameters).unwrap_or_default(),
        created_at: row.get(3)?,
        status: row.get(4)?,
        finished_at: row.get(5)?,
        error: row.get(6)?,
        recovered: row.get(7)?,
        details: row
            .get::<_, Option<String>>(8)?
            .and_then(|value| serde_json::from_str(&value).ok()),
        input_ids: Vec::new(),
    })
}

pub(crate) fn recent_image_runs_at(database: &Path) -> Result<Vec<ImageRunHistory>, AppError> {
    if !database.exists() {
        return Ok(Vec::new());
    }
    let connection = connection_at(database)?;
    let mut statement = connection.prepare(
        "SELECT id,operation,parameters,created_at,status,finished_at,error,recovered,result_details FROM runs WHERE operation IN ('openai.image.edit','openai.image.generate') ORDER BY id DESC LIMIT 64"
    ).map_err(sql)?;
    let runs = statement
        .query_map([], read_run)
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    drop(statement);
    runs.into_iter()
        .map(|mut run| {
            let output_path = connection
                .query_row(
                    "SELECT path FROM artifacts WHERE generating_run=?1 ORDER BY id DESC LIMIT 1",
                    [run.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sql)?;
            let prepared_output_path = if output_path.is_none()
                && matches!(run.status.as_str(), "pending" | "uncertain")
            {
                connection
                    .query_row(
                        "SELECT prepared_output_path FROM runs WHERE id=?1",
                        [run.id],
                        |row| row.get(0),
                    )
                    .map_err(sql)?
            } else {
                None
            };
            let mut inputs = connection
                .prepare("SELECT artifact_id FROM run_inputs WHERE run_id=?1 ORDER BY position")
                .map_err(sql)?;
            run.input_ids = inputs
                .query_map([run.id], |row| row.get(0))
                .map_err(sql)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql)?;
            Ok(ImageRunHistory {
                run,
                output_path,
                prepared_output_path,
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn recent_openai_image_runs() -> Result<Vec<ImageRunHistory>, AppError> {
    tauri::async_runtime::spawn_blocking(move || recent_image_runs_at(&database_path()?))
        .await
        .map_err(|_| AppError::Other("Image run history query failed".into()))?
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SelectedRevisionStatus {
    Matched,
    Changed,
    Unverified,
}

fn sql(error: rusqlite::Error) -> AppError {
    AppError::Other(format!("Trace database: {error}"))
}

fn connection_at(path: &Path) -> Result<Connection, AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(AppError::Other(
                "Trace database must be a regular file".into(),
            ));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
    }
    let connection = Connection::open(path).map_err(sql)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(sql)?;
    let schema_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql)?;
    if schema_version > 3 {
        return Err(AppError::Other(format!(
            "Trace database schema {schema_version} is newer than this app supports"
        )));
    }
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS artifacts (
           id INTEGER PRIMARY KEY,
           path TEXT NOT NULL,
           digest TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           generating_run INTEGER REFERENCES runs(id)
         );
         CREATE INDEX IF NOT EXISTS artifacts_by_path ON artifacts(path, digest, id DESC);
         CREATE TABLE IF NOT EXISTS runs (
           id INTEGER PRIMARY KEY,
           operation TEXT NOT NULL,
           parameters TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         );
         CREATE TABLE IF NOT EXISTS run_inputs (
           run_id INTEGER NOT NULL REFERENCES runs(id),
           artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
           position INTEGER NOT NULL,
           PRIMARY KEY (run_id, position)
         );
         CREATE INDEX IF NOT EXISTS run_inputs_by_artifact ON run_inputs(artifact_id);
         ",
        )
        .map_err(sql)?;
    if schema_version < 2 {
        connection
            .execute_batch(
                "BEGIN;
                 ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'succeeded';
                 ALTER TABLE runs ADD COLUMN finished_at TEXT;
                 ALTER TABLE runs ADD COLUMN error TEXT;
                 ALTER TABLE runs ADD COLUMN prepared_output_path TEXT;
                 ALTER TABLE runs ADD COLUMN prepared_output_digest TEXT;
                 ALTER TABLE runs ADD COLUMN prepared_object_identity TEXT;
                 ALTER TABLE runs ADD COLUMN prepared_anchor_path TEXT;
                 ALTER TABLE runs ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0;
                 PRAGMA user_version=2;
                 COMMIT;",
            )
            .map_err(sql)?;
    }
    if schema_version < 3 {
        connection.execute_batch(
            "BEGIN; ALTER TABLE runs ADD COLUMN result_details TEXT; PRAGMA user_version=3; COMMIT;",
        ).map_err(sql)?;
    }
    Ok(connection)
}

fn database_path() -> Result<std::path::PathBuf, AppError> {
    Ok(config::config_dir()?.join("trace.sqlite"))
}

fn open_owner_lock(path: &Path) -> Result<File, AppError> {
    #[cfg(unix)]
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    match options.open(path) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(AppError::Other(
                    "Trace owner lock must be a regular file".into(),
                ));
            }
            #[cfg(unix)]
            if metadata.permissions().mode() & 0o077 != 0 {
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            }
            Ok(OpenOptions::new().read(true).write(true).open(path)?)
        }
        Err(error) => Err(error.into()),
    }
}

fn with_trace_owner<T>(action: impl FnOnce(&Path) -> Result<T, AppError>) -> Result<T, AppError> {
    let owner = TRACE_OWNER.get_or_init(|| Mutex::new(None));
    let mut guard = owner
        .lock()
        .map_err(|_| AppError::Other("Trace owner lock is unavailable".into()))?;
    let database = database_path()?;
    if guard.is_none() {
        let lock = open_owner_lock(&database.with_file_name("trace-owner.lock"))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(AppError::Other(
                    "Trace recording is active in another Explorer process".into(),
                ));
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
        }
        reconcile_unfinished_at(&database)?;
        *guard = Some(lock);
    }
    action(&database)
}

fn digest(path: &Path) -> Result<String, AppError> {
    let mut file = File::open(path)?;
    digest_file(&mut file)
}

fn digest_file(file: &mut File) -> Result<String, AppError> {
    if file.metadata()?.len() > MAX_IMAGE_BYTES {
        return Err(AppError::Other(
            "Image exceeds Trace's 200 MiB revision limit".into(),
        ));
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn normalize_path(path: &Path) -> Result<String, AppError> {
    if !path.is_absolute() {
        return Err(AppError::InvalidPath(
            "Trace requires an absolute image path".into(),
        ));
    }
    let resolved = fs::canonicalize(path).or_else(|_| {
        let parent = path
            .parent()
            .ok_or_else(|| std::io::Error::other("Image has no parent"))?;
        let name = path
            .file_name()
            .ok_or_else(|| std::io::Error::other("Image has no name"))?;
        Ok::<_, std::io::Error>(fs::canonicalize(parent)?.join(name))
    })?;
    // Canonical Windows drive paths use verbatim prefixes. Use compatible
    // drive notation for existing records and explorer locators; preserve
    // UNC and other verbatim syntax that cannot be safely simplified.
    Ok(dunce::simplified(&resolved).to_string_lossy().into_owned())
}

fn artifact_path_state(path: &Path) -> ArtifactPathState {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => ArtifactPathState::Present,
        Ok(_) => ArtifactPathState::Unavailable,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ArtifactPathState::Missing,
        Err(_) => ArtifactPathState::Unavailable,
    }
}

/// Move the locator of the exact revision that Explorer renamed. Earlier
/// revisions at the old name remain historical facts; graph edges use IDs.
pub(crate) fn relocate_image(source: &Path, target: &Path) -> Result<(), AppError> {
    relocate_at(&database_path()?, source, target)
}

pub(crate) async fn relocate_after_rename(
    source: PathBuf,
    target: PathBuf,
) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || relocate_image(&source, &target))
        .await
        .map_err(|error| AppError::Other(format!("Trace relocation failed: {error}")))?
}

fn relocate_at(database: &Path, source: &Path, target: &Path) -> Result<(), AppError> {
    if !database.exists() || !target.is_file() {
        return Ok(());
    }
    let source_path = normalize_path(source)?;
    let target_path = normalize_path(target)?;
    let connection = connection_at(database)?;
    let known: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE path=?1)",
            [source_path.as_str()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if !known {
        return Ok(());
    }
    let current_digest = digest(target)?;
    connection
        .execute(
            "UPDATE artifacts SET path=?1 WHERE id=(SELECT id FROM artifacts WHERE path=?2 AND digest=?3 ORDER BY id DESC LIMIT 1)",
            params![target_path, source_path, current_digest],
        )
        .map_err(sql)?;
    Ok(())
}

#[cfg(test)]
fn record_crop_at(
    database: &Path,
    metadata: CropMetadata,
    output_path: &str,
    output_digest: &str,
) -> Result<(), AppError> {
    record_operation_at(database, crop_record(metadata, output_path, output_digest))
}

#[cfg(test)]
fn crop_record(metadata: CropMetadata, output_path: &str, output_digest: &str) -> OperationRecord {
    OperationRecord {
        operation: "image.crop".into(),
        parameters: serde_json::json!({ "rect": metadata.rect, "viewport": metadata.viewport }),
        inputs: vec![OperationInput {
            path: metadata.source_path,
            digest: metadata.source_digest,
        }],
        output_path: output_path.into(),
        output_digest: output_digest.into(),
    }
}

#[cfg(test)]
fn record_operation_at(database: &Path, record: OperationRecord) -> Result<(), AppError> {
    let start = OperationStart {
        operation: record.operation,
        parameters: record.parameters,
        inputs: record.inputs,
    };
    validate_start(&start)?;
    if !valid_digest(&record.output_digest) {
        return Err(AppError::Other("Invalid Trace content digest".into()));
    }
    let output_path = normalize_path(Path::new(&record.output_path))?;
    let mut connection = connection_at(database)?;
    let tx = connection.transaction().map_err(sql)?;
    let run_id = insert_start(&tx, &start, "succeeded")?;
    tx.execute(
        "INSERT INTO artifacts(path,digest,generating_run) VALUES (?1,?2,?3)",
        params![output_path, record.output_digest, run_id],
    )
    .map_err(sql)?;
    tx.commit().map_err(sql)?;
    Ok(())
}

fn insert_start(
    tx: &rusqlite::Transaction<'_>,
    start: &OperationStart,
    status: &str,
) -> Result<i64, AppError> {
    let mut input_ids = Vec::with_capacity(start.inputs.len());
    for input in &start.inputs {
        let path = normalize_path(Path::new(&input.path))?;
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM artifacts WHERE path=?1 AND digest=?2 ORDER BY id DESC LIMIT 1",
                params![path, input.digest],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?;
        let id = match existing {
            Some(id) => id,
            None => {
                tx.execute(
                    "INSERT INTO artifacts(path,digest) VALUES (?1,?2)",
                    params![path, input.digest],
                )
                .map_err(sql)?;
                tx.last_insert_rowid()
            }
        };
        input_ids.push(id);
    }
    let parameters = serde_json::to_string(&start.parameters)
        .map_err(|error| AppError::Other(error.to_string()))?;
    tx.execute(
        "INSERT INTO runs(operation,parameters,status) VALUES (?1,?2,?3)",
        params![start.operation, parameters, status],
    )
    .map_err(sql)?;
    let run_id = tx.last_insert_rowid();
    for (position, input_id) in input_ids.into_iter().enumerate() {
        tx.execute(
            "INSERT INTO run_inputs(run_id,artifact_id,position) VALUES (?1,?2,?3)",
            params![run_id, input_id, position as i64],
        )
        .map_err(sql)?;
    }
    Ok(run_id)
}

pub(crate) fn begin_crop(metadata: &CropMetadata) -> Result<TraceRunHandle, AppError> {
    begin_operation(crop_start(metadata))
}

pub(crate) fn begin_operation(start: OperationStart) -> Result<TraceRunHandle, AppError> {
    with_trace_owner(|database| {
        let id = begin_operation_at(database, start)?;
        Ok(TraceRunHandle {
            database: database.to_owned(),
            id,
        })
    })
}

fn crop_start(metadata: &CropMetadata) -> OperationStart {
    OperationStart {
        operation: "image.crop".into(),
        parameters: serde_json::json!({ "rect": metadata.rect, "viewport": metadata.viewport }),
        inputs: vec![OperationInput {
            path: metadata.source_path.clone(),
            digest: metadata.source_digest.clone(),
        }],
    }
}

#[cfg(test)]
fn begin_crop_at(database: &Path, metadata: &CropMetadata) -> Result<i64, AppError> {
    begin_operation_at(database, crop_start(metadata))
}

fn begin_operation_at(database: &Path, start: OperationStart) -> Result<i64, AppError> {
    validate_start(&start)?;
    let mut connection = connection_at(database)?;
    let tx = connection.transaction().map_err(sql)?;
    let run_id = insert_start(&tx, &start, "running")?;
    tx.commit().map_err(sql)?;
    Ok(run_id)
}

#[cfg(test)]
pub(crate) fn begin_crop_for_test(
    database: &Path,
    metadata: &CropMetadata,
) -> Result<TraceRunHandle, AppError> {
    let id = begin_crop_at(database, metadata)?;
    Ok(TraceRunHandle {
        database: database.to_owned(),
        id,
    })
}

#[cfg(test)]
pub(crate) fn begin_operation_for_test(
    database: &Path,
    start: OperationStart,
) -> Result<TraceRunHandle, AppError> {
    let id = begin_operation_at(database, start)?;
    Ok(TraceRunHandle {
        database: database.to_owned(),
        id,
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn prepare_linked_output(
    run: &TraceRunHandle,
    target: &Path,
    digest: &str,
    publisher: &Path,
) -> Result<(), AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::InvalidPath("Trace output has no parent".into()))?;
    let mut evidence = crate::files::publication::StagedEntry::prepare(parent, |path| {
        fs::hard_link(publisher, path)?;
        Ok(())
    })?;
    let anchor = evidence.trace_anchor()?;
    prepare_operation_output(run, target, digest, Some(&anchor))?;
    evidence.retain_trace_anchor();
    Ok(())
}

pub(crate) fn prepare_crop_output(
    run: &TraceRunHandle,
    output_path: &Path,
    output_digest: &str,
    staged_path: Option<&Path>,
) -> Result<(), AppError> {
    prepare_operation_output(run, output_path, output_digest, staged_path)
}

pub(crate) fn prepare_operation_output(
    run: &TraceRunHandle,
    output_path: &Path,
    output_digest: &str,
    staged_path: Option<&Path>,
) -> Result<(), AppError> {
    if staged_path.is_none() {
        return Err(AppError::Other(
            "Trace publication requires retained native evidence".into(),
        ));
    }
    prepare_output_at(
        &run.database,
        run.id,
        output_path,
        output_digest,
        staged_path,
    )
}

fn prepare_output_at(
    database: &Path,
    run_id: i64,
    output_path: &Path,
    output_digest: &str,
    staged_path: Option<&Path>,
) -> Result<(), AppError> {
    if !valid_digest(output_digest) {
        return Err(AppError::Other("Invalid Trace content digest".into()));
    }
    let output_path = normalize_path(output_path)?;
    let staged_identity = staged_path
        .map(crate::files::trace_file_identity)
        .transpose()?;
    let anchor_path = staged_path.map(normalize_path).transpose()?;
    let connection = connection_at(database)?;
    let changed = connection
        .execute(
            "UPDATE runs SET prepared_output_path=?1,prepared_output_digest=?2,prepared_object_identity=?3,prepared_anchor_path=?4
             WHERE id=?5 AND status='running' AND prepared_output_digest IS NULL",
            params![output_path, output_digest, staged_identity, anchor_path, run_id],
        )
        .map_err(sql)?;
    if changed != 1 {
        return Err(AppError::Other(
            "Trace run is not awaiting an output".into(),
        ));
    }
    Ok(())
}

pub(crate) fn complete_crop(run: &TraceRunHandle, published_path: &str) -> Result<(), AppError> {
    complete_operation(run, published_path)
}

pub(crate) fn complete_operation(
    run: &TraceRunHandle,
    published_path: &str,
) -> Result<(), AppError> {
    complete_run_at(&run.database, run.id, published_path, false)
}

fn complete_run_at(
    database: &Path,
    run_id: i64,
    published_path: &str,
    recovered: bool,
) -> Result<(), AppError> {
    let path = normalize_path(Path::new(published_path))?;
    let connection = connection_at(database)?;
    type Evidence = (String, String, Option<String>, Option<String>);
    let prepared: Option<Evidence> = connection.query_row(
        "SELECT prepared_output_path,prepared_output_digest,prepared_object_identity,prepared_anchor_path FROM runs
         WHERE id=?1 AND status IN ('running','uncertain') AND prepared_output_digest IS NOT NULL",
        [run_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(sql)?;
    drop(connection);
    let Some((prepared_path, prepared_digest, identity, anchor)) = prepared else {
        return Err(AppError::Other("Trace run has no prepared output".into()));
    };
    if path != prepared_path {
        return Err(AppError::Other(
            "Trace output path changed before completion".into(),
        ));
    }
    let proven = match (&identity, &anchor) {
        (Some(identity), Some(anchor)) => matches!(
            observe_publication(
                Path::new(&path),
                Path::new(anchor),
                &prepared_digest,
                identity
            ),
            PublicationObservation::Published
        ),
        _ => false,
    };
    let mut connection = connection_at(database)?;
    let tx = connection.transaction().map_err(sql)?;
    let current: Option<Evidence> = tx.query_row(
        "SELECT prepared_output_path,prepared_output_digest,prepared_object_identity,prepared_anchor_path FROM runs
         WHERE id=?1 AND status IN ('running','uncertain') AND prepared_output_digest IS NOT NULL",
        [run_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(sql)?;
    if current != Some((prepared_path, prepared_digest.clone(), identity, anchor)) {
        return Err(AppError::Other(
            "Trace run changed while verifying its publication".into(),
        ));
    }
    if !proven {
        tx.execute("UPDATE runs SET status='uncertain',error='publication_evidence_unverified' WHERE id=?1", [run_id]).map_err(sql)?;
        tx.commit().map_err(sql)?;
        return Err(AppError::Other(
            "Trace could not verify the published image revision; evidence is retained".into(),
        ));
    }
    tx.execute(
        "INSERT INTO artifacts(path,digest,generating_run) VALUES (?1,?2,?3)",
        params![path, prepared_digest, run_id],
    )
    .map_err(sql)?;
    tx.execute(
        "UPDATE runs SET status='succeeded',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error=NULL,recovered=?2 WHERE id=?1",
        params![run_id, recovered],
    )
    .map_err(sql)?;
    tx.commit().map_err(sql)?;
    if let Err(error) = cleanup_anchor_at(database, run_id) {
        log::warn!(
            "Trace run {run_id} finished but its staging anchor could not be cleaned: {error}"
        );
    }
    Ok(())
}

pub(crate) fn fail_crop(run: &TraceRunHandle) -> Result<(), AppError> {
    fail_operation(run, "crop_failed")
}

pub(crate) fn fail_operation(run: &TraceRunHandle, reason: &str) -> Result<(), AppError> {
    fail_run_at(&run.database, run.id, reason)
}

pub(crate) fn cancel_operation(run: &TraceRunHandle) -> Result<(), AppError> {
    let connection = connection_at(&run.database)?;
    connection.execute(
        "UPDATE runs SET status='cancelled',error='cancelled',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND status='running'",
        [run.id],
    ).map_err(sql)?;
    cleanup_anchor_at(&run.database, run.id)
}

pub(crate) fn record_operation_details(
    run: &TraceRunHandle,
    details: &serde_json::Value,
) -> Result<(), AppError> {
    let connection = connection_at(&run.database)?;
    connection
        .execute(
            "UPDATE runs SET result_details=?2 WHERE id=?1 AND status='running'",
            params![run.id, details.to_string()],
        )
        .map_err(sql)?;
    Ok(())
}

pub(crate) fn mark_crop_uncertain(run: &TraceRunHandle) -> Result<(), AppError> {
    mark_operation_uncertain(run, "crop_result_uncertain")
}

pub(crate) fn mark_operation_uncertain(run: &TraceRunHandle, reason: &str) -> Result<(), AppError> {
    let connection = connection_at(&run.database)?;
    connection
        .execute(
            "UPDATE runs SET status='uncertain',error=?2 WHERE id=?1 AND status='running'",
            params![run.id, reason],
        )
        .map_err(sql)?;
    Ok(())
}

fn fail_run_at(database: &Path, run_id: i64, reason: &str) -> Result<(), AppError> {
    let connection = connection_at(database)?;
    connection
        .execute(
            "UPDATE runs SET status='failed',error=?2,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id=?1 AND status='running'",
            params![run_id, reason],
        )
        .map_err(sql)?;
    if let Err(error) = cleanup_anchor_at(database, run_id) {
        log::warn!(
            "Trace run {run_id} failed but its staging anchor could not be cleaned: {error}"
        );
    }
    Ok(())
}

fn cleanup_anchor_at(database: &Path, run_id: i64) -> Result<(), AppError> {
    let connection = connection_at(database)?;
    let evidence: Option<(Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT prepared_anchor_path,prepared_object_identity FROM runs WHERE id=?1 AND status NOT IN ('running','uncertain')",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    let Some((Some(anchor), Some(expected_identity))) = evidence else {
        return Ok(());
    };
    let anchor = Path::new(&anchor);
    let directory = anchor
        .parent()
        .ok_or_else(|| AppError::InvalidPath("Trace anchor has no parent".into()))?;
    let safe_name = anchor
        .file_name()
        .is_some_and(|name| name == "trace-anchor")
        && directory
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(".tauri-explorer-stage-"));
    if !safe_name {
        return Err(AppError::Other(
            "Trace anchor path is not a private staging directory".into(),
        ));
    }
    match fs::symlink_metadata(directory) {
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(AppError::Other(
                "Trace anchor directory changed type".into(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !directory.parent().is_some_and(|parent| parent.is_dir()) {
                return Err(AppError::Other("Trace anchor volume is unavailable".into()));
            }
        }
        Err(error) => return Err(error.into()),
    }
    match fs::symlink_metadata(anchor) {
        Ok(_) => {
            if crate::files::trace_file_identity(anchor)? != expected_identity {
                return Err(AppError::Other("Trace anchor identity changed".into()));
            }
            let payload = directory.join("payload");
            match fs::symlink_metadata(&payload) {
                Ok(_) => {
                    if crate::files::trace_file_identity(&payload)? != expected_identity {
                        return Err(AppError::Other(
                            "Trace stage payload identity changed".into(),
                        ));
                    }
                    fs::remove_file(payload)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            fs::remove_file(anchor)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    match fs::remove_dir(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    connection
        .execute(
            "UPDATE runs SET prepared_anchor_path=NULL WHERE id=?1",
            [run_id],
        )
        .map_err(sql)?;
    Ok(())
}

fn cleanup_terminal_anchors_at(database: &Path) -> Result<(), AppError> {
    let connection = connection_at(database)?;
    let mut statement = connection
        .prepare("SELECT id FROM runs WHERE prepared_anchor_path IS NOT NULL AND status NOT IN ('running','uncertain')")
        .map_err(sql)?;
    let run_ids = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    drop(statement);
    drop(connection);
    for run_id in run_ids {
        if let Err(error) = cleanup_anchor_at(database, run_id) {
            log::warn!("Trace run {run_id} staging anchor still needs cleanup: {error}");
        }
    }
    Ok(())
}

enum PublicationObservation {
    Published,
    NotPublished,
    Unavailable,
}

fn observed_file_at(path: &Path) -> Result<Option<File>, PublicationObservation> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Ok(None);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return match path.parent().and_then(|parent| fs::metadata(parent).ok()) {
                Some(parent) if parent.is_dir() => Ok(None),
                _ => Err(PublicationObservation::Unavailable),
            };
        }
        Err(_) => return Err(PublicationObservation::Unavailable),
    }
    File::open(path)
        .map(Some)
        .map_err(|_| PublicationObservation::Unavailable)
}

fn observe_publication(
    path: &Path,
    anchor: &Path,
    expected_digest: &str,
    staged_identity: &str,
) -> PublicationObservation {
    let _anchor_file = match observed_file_at(anchor) {
        Ok(Some(file)) if matches!(crate::files::trace_file_identity_of(&file), Ok(identity) if identity == staged_identity) => {
            file
        }
        Ok(_) => return PublicationObservation::NotPublished,
        Err(observation) => return observation,
    };
    let mut target_file = match observed_file_at(path) {
        Ok(Some(file)) if matches!(crate::files::trace_file_identity_of(&file), Ok(identity) if identity == staged_identity) => {
            file
        }
        Ok(_) => return PublicationObservation::NotPublished,
        Err(observation) => return observation,
    };
    match digest_file(&mut target_file) {
        Ok(observed) if observed == expected_digest => {}
        Ok(_) => return PublicationObservation::NotPublished,
        Err(_) => return PublicationObservation::Unavailable,
    }
    match crate::files::trace_file_identity(path) {
        Ok(observed) if observed == staged_identity => PublicationObservation::Published,
        Ok(_) => PublicationObservation::NotPublished,
        Err(_) => PublicationObservation::Unavailable,
    }
}

/// A crash can separate publication from the final SQLite commit. The staged
/// object's retained hard link, native identity, and digest prove a staged
/// publication reached the target without relying on a reusable object ID alone.
/// A missing target is definitive only while its parent is accessible.
pub(crate) fn reconcile_unfinished_at(database: &Path) -> Result<(), AppError> {
    if !database.exists() {
        return Ok(());
    }
    let connection = connection_at(database)?;
    let mut statement = connection
        .prepare("SELECT id,prepared_output_path,prepared_output_digest,prepared_object_identity,prepared_anchor_path FROM runs WHERE status IN ('running','uncertain')")
        .map_err(sql)?;
    let pending = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    drop(statement);
    drop(connection);
    for (run_id, path, expected, identity, anchor) in pending {
        let observation = match (&path, &expected, &identity, &anchor) {
            (Some(path), Some(expected), Some(identity), Some(anchor)) => {
                observe_publication(Path::new(path), Path::new(anchor), expected, identity)
            }
            _ => PublicationObservation::NotPublished,
        };
        match observation {
            PublicationObservation::Published => {
                complete_run_at(database, run_id, path.as_deref().unwrap(), true)?;
            }
            PublicationObservation::NotPublished => {
                let connection = connection_at(database)?;
                connection.execute(
                    "UPDATE runs SET status='interrupted',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND status IN ('running','uncertain')",
                    [run_id],
                ).map_err(sql)?;
            }
            PublicationObservation::Unavailable => {
                log::warn!(
                    "Trace output for run {run_id} could not be checked; recovery remains pending"
                );
            }
        }
    }
    cleanup_terminal_anchors_at(database)?;
    Ok(())
}

pub(crate) fn reconcile_unfinished() -> Result<(), AppError> {
    with_trace_owner(|_| Ok(()))
}

pub(crate) fn graph_for_path_at(
    database: &Path,
    path: &Path,
) -> Result<Option<TraceGraph>, AppError> {
    if !path.is_absolute() || !path.is_file() {
        return Ok(None);
    }
    if !database.exists() {
        return Ok(None);
    }
    let connection = connection_at(database)?;
    let path_text = normalize_path(path)?;
    let known: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE path=?1)",
            [path_text.as_str()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if !known {
        return Ok(None);
    }
    let selected_digest = if fs::metadata(path)?.len() > MAX_IMAGE_BYTES {
        None
    } else {
        Some(digest(path)?)
    };
    let current: Option<i64> = match selected_digest.as_ref() {
        Some(digest) => connection
            .query_row(
                "SELECT id FROM artifacts WHERE path=?1 AND digest=?2 ORDER BY id DESC LIMIT 1",
                params![path_text.as_str(), digest],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?,
        None => None,
    };
    let selected_revision_status = match (&selected_digest, &current) {
        (None, _) => SelectedRevisionStatus::Unverified,
        (Some(_), Some(_)) => SelectedRevisionStatus::Matched,
        (Some(_), None) => SelectedRevisionStatus::Changed,
    };
    let current_artifact_id = match current {
        Some(id) => id,
        None => connection
            .query_row(
                "SELECT id FROM artifacts WHERE path=?1 ORDER BY id DESC LIMIT 1",
                [path_text.as_str()],
                |row| row.get(0),
            )
            .map_err(sql)?,
    };
    let mut graph = TraceGraph {
        current_artifact_id,
        selected_revision_status,
        artifacts: Vec::new(),
        runs: Vec::new(),
    };
    let mut pending_artifacts = vec![current_artifact_id];
    let mut pending_runs = Vec::new();
    let mut scheduled_artifacts = HashSet::from([current_artifact_id]);
    let mut scheduled_runs = HashSet::new();
    while !pending_artifacts.is_empty() || !pending_runs.is_empty() {
        if let Some(id) = pending_artifacts.pop() {
            let (artifact_id, path, digest, created_at, generating_run): (
                i64,
                String,
                String,
                String,
                Option<i64>,
            ) = connection
                .query_row(
                    "SELECT id,path,digest,created_at,generating_run FROM artifacts WHERE id=?1",
                    [id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .map_err(sql)?;
            let artifact = Artifact {
                id: artifact_id,
                path_state: artifact_path_state(Path::new(&path)),
                path,
                digest,
                created_at,
                generating_run,
            };
            if let Some(run_id) = artifact.generating_run {
                if scheduled_runs.insert(run_id) {
                    pending_runs.push(run_id);
                }
            }
            let mut outgoing = connection
            .prepare("SELECT DISTINCT run_id FROM run_inputs WHERE artifact_id=?1 ORDER BY run_id LIMIT 1025")
            .map_err(sql)?;
            let run_ids = outgoing
                .query_map([id], |row| row.get(0))
                .map_err(sql)?
                .collect::<Result<Vec<i64>, _>>()
                .map_err(sql)?;
            for run_id in run_ids {
                if scheduled_runs.insert(run_id) {
                    if scheduled_runs.len() > 1024 {
                        return Err(AppError::Other("Trace graph exceeds 1024 runs".into()));
                    }
                    pending_runs.push(run_id);
                }
            }
            graph.artifacts.push(artifact);
        } else if let Some(run_id) = pending_runs.pop() {
            let mut run = connection
                .query_row(
                    "SELECT id,operation,parameters,created_at,status,finished_at,error,recovered,result_details FROM runs WHERE id=?1",
                    [run_id],
                    read_run,
                )
                .map_err(sql)?;
            let mut inputs = connection
                .prepare("SELECT artifact_id FROM run_inputs WHERE run_id=?1 ORDER BY position")
                .map_err(sql)?;
            run.input_ids = inputs
                .query_map([run_id], |row| row.get(0))
                .map_err(sql)?
                .collect::<Result<Vec<i64>, _>>()
                .map_err(sql)?;
            for input_id in &run.input_ids {
                if scheduled_artifacts.insert(*input_id) {
                    if scheduled_artifacts.len() > 1024 {
                        return Err(AppError::Other("Trace graph exceeds 1024 artifacts".into()));
                    }
                    pending_artifacts.push(*input_id);
                }
            }
            let mut outputs = connection
                .prepare("SELECT id FROM artifacts WHERE generating_run=?1 ORDER BY id LIMIT 1025")
                .map_err(sql)?;
            let output_ids = outputs
                .query_map([run_id], |row| row.get(0))
                .map_err(sql)?
                .collect::<Result<Vec<i64>, _>>()
                .map_err(sql)?;
            for output_id in output_ids {
                if scheduled_artifacts.insert(output_id) {
                    if scheduled_artifacts.len() > 1024 {
                        return Err(AppError::Other("Trace graph exceeds 1024 artifacts".into()));
                    }
                    pending_artifacts.push(output_id);
                }
            }
            graph.runs.push(run);
        }
    }
    Ok(Some(graph))
}

#[tauri::command]
pub(crate) async fn trace_for_image(path: String) -> Result<Option<TraceGraph>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        graph_for_path_at(&database_path()?, Path::new(&path))
    })
    .await
    .map_err(|error| AppError::Other(format!("Trace query failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crop(source: &Path) -> CropMetadata {
        CropMetadata {
            source_path: source.to_string_lossy().into_owned(),
            source_digest: digest(source).unwrap(),
            rect: image_crop::CropRect {
                left: 1,
                top: 2,
                right: 11,
                bottom: 12,
            },
            viewport: image_crop::SvgViewport {
                width: 20,
                height: 20,
            },
        }
    }

    fn staged_result(root: &Path, bytes: &[u8]) -> (PathBuf, PathBuf) {
        let directory = tempfile::Builder::new()
            .prefix(".tauri-explorer-stage-")
            .tempdir_in(root)
            .unwrap()
            .keep();
        let payload = directory.join("payload");
        let anchor = directory.join("trace-anchor");
        fs::write(&payload, bytes).unwrap();
        fs::hard_link(&payload, &anchor).unwrap();
        (payload, anchor)
    }

    #[test]
    fn crop_chain_is_durable_and_bound_to_exact_output_revision() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let first = dir.path().join("first.png");
        let second = dir.path().join("second.png");
        let branch = dir.path().join("branch.png");
        std::fs::write(&source, b"source pixels").unwrap();
        std::fs::write(&first, b"first crop").unwrap();
        record_crop_at(
            &db,
            crop(&source),
            first.to_str().unwrap(),
            &digest(&first).unwrap(),
        )
        .unwrap();
        std::fs::write(&second, b"second crop").unwrap();
        record_crop_at(
            &db,
            crop(&first),
            second.to_str().unwrap(),
            &digest(&second).unwrap(),
        )
        .unwrap();
        fs::write(&branch, b"another first crop").unwrap();
        record_crop_at(
            &db,
            crop(&source),
            branch.to_str().unwrap(),
            &digest(&branch).unwrap(),
        )
        .unwrap();

        let graph = graph_for_path_at(&db, &second).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 4);
        assert_eq!(graph.runs.len(), 3);
        assert_eq!(
            graph
                .runs
                .iter()
                .map(|run| run.operation.as_str())
                .collect::<Vec<_>>(),
            ["image.crop", "image.crop", "image.crop"]
        );
        assert!(graph
            .artifacts
            .iter()
            .any(|artifact| artifact.path == source.to_string_lossy()));
        let source_graph = graph_for_path_at(&db, &source).unwrap().unwrap();
        assert_eq!(source_graph.artifacts.len(), 4);
        assert!(source_graph
            .artifacts
            .iter()
            .any(|artifact| artifact.path == branch.to_string_lossy()));

        fs::remove_file(&source).unwrap();
        let missing_source_graph = graph_for_path_at(&db, &first).unwrap().unwrap();
        assert_eq!(
            missing_source_graph
                .artifacts
                .iter()
                .find(|artifact| artifact.path == source.to_string_lossy())
                .unwrap()
                .path_state,
            ArtifactPathState::Missing
        );

        std::fs::write(&second, b"changed outside the app").unwrap();
        let changed_graph = graph_for_path_at(&db, &second).unwrap().unwrap();
        assert_eq!(
            changed_graph.selected_revision_status,
            SelectedRevisionStatus::Changed
        );
        assert_eq!(changed_graph.artifacts.len(), 4);
        assert!(changed_graph
            .artifacts
            .iter()
            .any(|artifact| artifact.id == changed_graph.current_artifact_id
                && artifact.digest != digest(&second).unwrap()));
    }

    #[test]
    fn started_crop_finishes_with_a_durable_output_revision() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let output = dir.path().join("output.png");
        fs::write(&source, b"source").unwrap();
        let run_id = begin_crop_at(&db, &crop(&source)).unwrap();
        let output_digest = hex::encode(Sha256::digest(b"result"));
        let (stage, anchor) = staged_result(dir.path(), b"result");
        prepare_output_at(&db, run_id, &output, &output_digest, Some(&anchor)).unwrap();
        fs::rename(stage, &output).unwrap();
        complete_run_at(&db, run_id, output.to_str().unwrap(), false).unwrap();

        let graph = graph_for_path_at(&db, &output).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 2);
        assert_eq!(graph.runs.len(), 1);
        assert_eq!(graph.runs[0].status, "succeeded");
        assert!(graph.runs[0].finished_at.is_some());
        assert!(!graph.runs[0].recovered);
        assert_eq!(
            graph.selected_revision_status,
            SelectedRevisionStatus::Matched
        );
    }

    #[test]
    fn completion_cannot_attribute_an_external_replacement_even_with_identical_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let output = dir.path().join("output.png");
        fs::write(&source, b"source").unwrap();
        let run = begin_crop_at(&db, &crop(&source)).unwrap();
        let (stage, anchor) = staged_result(dir.path(), b"result");
        prepare_output_at(
            &db,
            run,
            &output,
            &hex::encode(Sha256::digest(b"result")),
            Some(&anchor),
        )
        .unwrap();
        fs::rename(stage, &output).unwrap();
        fs::remove_file(&output).unwrap();
        fs::write(&output, b"result").unwrap();
        assert!(complete_run_at(&db, run, output.to_str().unwrap(), false).is_err());
        let graph = graph_for_path_at(&db, &source).unwrap().unwrap();
        assert_eq!(graph.runs[0].status, "uncertain");
        assert_eq!(graph.artifacts.len(), 1);
        assert!(anchor.exists());
    }

    #[test]
    fn failed_crop_is_visible_from_its_source_without_an_output() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        fs::write(&source, b"source").unwrap();
        let run_id = begin_crop_at(&db, &crop(&source)).unwrap();
        fail_run_at(&db, run_id, "crop_failed").unwrap();

        let graph = graph_for_path_at(&db, &source).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 1);
        assert_eq!(graph.runs.len(), 1);
        assert_eq!(graph.runs[0].status, "failed");
        assert_eq!(graph.runs[0].error.as_deref(), Some("crop_failed"));
        assert!(!graph
            .artifacts
            .iter()
            .any(|artifact| artifact.generating_run == Some(run_id)));
    }

    #[test]
    fn restart_recovers_published_bytes_and_keeps_missing_output_interrupted() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let published = dir.path().join("published.png");
        let absent = dir.path().join("absent.png");
        fs::write(&source, b"source").unwrap();
        let first = begin_crop_at(&db, &crop(&source)).unwrap();
        let second = begin_crop_at(&db, &crop(&source)).unwrap();
        let expected = hex::encode(Sha256::digest(b"result"));
        let (stage, anchor) = staged_result(dir.path(), b"result");
        prepare_output_at(&db, first, &published, &expected, Some(&anchor)).unwrap();
        prepare_output_at(&db, second, &absent, &expected, None).unwrap();
        fs::rename(&stage, &published).unwrap();

        reconcile_unfinished_at(&db).unwrap();
        let graph = graph_for_path_at(&db, &source).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 2);
        assert_eq!(graph.runs.len(), 2);
        let recovered = graph.runs.iter().find(|run| run.id == first).unwrap();
        assert_eq!(recovered.status, "succeeded");
        assert!(recovered.recovered);
        let interrupted = graph.runs.iter().find(|run| run.id == second).unwrap();
        assert_eq!(interrupted.status, "interrupted");
        assert!(!anchor.exists());
        assert!(!graph
            .artifacts
            .iter()
            .any(|artifact| artifact.generating_run == Some(second)));
    }

    #[test]
    fn version_one_history_migrates_without_losing_its_lineage() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let output = dir.path().join("output.png");
        fs::write(&source, b"source").unwrap();
        fs::write(&output, b"output").unwrap();
        let old = Connection::open(&db).unwrap();
        old.execute_batch(
            "CREATE TABLE artifacts (id INTEGER PRIMARY KEY,path TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL,generating_run INTEGER);
             CREATE TABLE runs (id INTEGER PRIMARY KEY,operation TEXT NOT NULL,parameters TEXT NOT NULL,created_at TEXT NOT NULL);
             CREATE TABLE run_inputs (run_id INTEGER NOT NULL,artifact_id INTEGER NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(run_id,position));
             PRAGMA user_version=1;",
        )
        .unwrap();
        old.execute(
            "INSERT INTO artifacts(id,path,digest,created_at) VALUES (1,?1,?2,'2026-10-03T00:00:00Z')",
            params![source.to_str().unwrap(), digest(&source).unwrap()],
        )
        .unwrap();
        old.execute(
            "INSERT INTO runs(id,operation,parameters,created_at) VALUES (2,'image.crop','{}','2026-10-03T00:00:01Z')",
            [],
        )
        .unwrap();
        old.execute("INSERT INTO run_inputs VALUES (2,1,0)", [])
            .unwrap();
        old.execute(
            "INSERT INTO artifacts(id,path,digest,created_at,generating_run) VALUES (3,?1,?2,'2026-10-03T00:00:02Z',2)",
            params![output.to_str().unwrap(), digest(&output).unwrap()],
        )
        .unwrap();
        drop(old);

        let graph = graph_for_path_at(&db, &output).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 2);
        assert_eq!(graph.runs.len(), 1);
        assert_eq!(graph.runs[0].status, "succeeded");
        let version: i64 = connection_at(&db)
            .unwrap()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
    }

    #[test]
    fn recovery_does_not_invent_an_output_when_replacement_bytes_are_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        fs::write(&source, b"same bytes").unwrap();
        let run_id = begin_crop_at(&db, &crop(&source)).unwrap();
        let same_digest = digest(&source).unwrap();
        prepare_output_at(&db, run_id, &source, &same_digest, None).unwrap();

        reconcile_unfinished_at(&db).unwrap();
        let graph = graph_for_path_at(&db, &source).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 1);
        assert_eq!(graph.runs[0].status, "interrupted");
        assert!(!graph.runs[0].recovered);
    }

    #[test]
    fn matching_bytes_from_another_file_do_not_prove_crop_publication() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let output = dir.path().join("output.png");
        fs::write(&source, b"source").unwrap();
        let (stage, anchor) = staged_result(dir.path(), b"same result");
        let run_id = begin_crop_at(&db, &crop(&source)).unwrap();
        let expected = digest(&stage).unwrap();
        prepare_output_at(&db, run_id, &output, &expected, Some(&anchor)).unwrap();
        fs::write(&output, b"same result").unwrap();

        reconcile_unfinished_at(&db).unwrap();
        let graph = graph_for_path_at(&db, &source).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 1);
        assert_eq!(graph.runs[0].status, "interrupted");
        assert!(!anchor.exists());
    }

    #[test]
    fn unavailable_parent_keeps_recovery_pending_until_the_output_returns() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let mount = dir.path().join("removable");
        fs::create_dir(&mount).unwrap();
        let output = mount.join("output.png");
        fs::write(&source, b"source").unwrap();
        let (stage, anchor) = staged_result(dir.path(), b"result");
        let run_id = begin_crop_at(&db, &crop(&source)).unwrap();
        let expected = digest(&stage).unwrap();
        prepare_output_at(&db, run_id, &output, &expected, Some(&anchor)).unwrap();
        fs::remove_dir(&mount).unwrap();

        reconcile_unfinished_at(&db).unwrap();
        let pending = graph_for_path_at(&db, &source).unwrap().unwrap();
        assert_eq!(pending.runs[0].status, "running");
        fs::create_dir(&mount).unwrap();
        fs::rename(&stage, &output).unwrap();
        reconcile_unfinished_at(&db).unwrap();
        let recovered = graph_for_path_at(&db, &source).unwrap().unwrap();
        assert_eq!(recovered.runs[0].status, "succeeded");
        assert!(recovered.runs[0].recovered);
    }

    #[test]
    fn replacement_after_publication_cannot_be_attributed_to_crop() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let output = dir.path().join("output.png");
        fs::write(&source, b"source pixels").unwrap();
        fs::write(&output, b"encoded crop").unwrap();
        let intended_digest = digest(&output).unwrap();
        fs::write(&output, b"replaced by another process").unwrap();
        record_crop_at(
            &db,
            crop(&source),
            output.to_str().unwrap(),
            &intended_digest,
        )
        .unwrap();
        let graph = graph_for_path_at(&db, &output).unwrap().unwrap();
        assert_eq!(
            graph.selected_revision_status,
            SelectedRevisionStatus::Changed
        );
        assert_eq!(graph.artifacts.len(), 2);
    }

    #[test]
    fn oversized_selected_image_has_unverified_status_without_claiming_a_change() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let output = dir.path().join("output.png");
        fs::write(&source, b"source pixels").unwrap();
        fs::write(&output, b"encoded crop").unwrap();
        record_crop_at(
            &db,
            crop(&source),
            output.to_str().unwrap(),
            &digest(&output).unwrap(),
        )
        .unwrap();
        OpenOptions::new()
            .write(true)
            .open(&output)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        let graph = graph_for_path_at(&db, &output).unwrap().unwrap();
        assert_eq!(
            graph.selected_revision_status,
            SelectedRevisionStatus::Unverified
        );
        assert_eq!(graph.artifacts.len(), 2);
    }

    #[test]
    fn relocated_output_retains_its_graph_identity() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let output = dir.path().join("output.png");
        let renamed = dir.path().join("renamed.png");
        fs::write(&source, b"source pixels").unwrap();
        fs::write(&output, b"encoded crop").unwrap();
        record_crop_at(
            &db,
            crop(&source),
            output.to_str().unwrap(),
            &digest(&output).unwrap(),
        )
        .unwrap();
        fs::rename(&output, &renamed).unwrap();
        relocate_at(&db, &output, &renamed).unwrap();
        let graph = graph_for_path_at(&db, &renamed).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 2);
        assert_eq!(
            graph.current_artifact_id,
            graph
                .artifacts
                .iter()
                .find(|artifact| artifact.path == renamed.to_string_lossy())
                .unwrap()
                .id
        );
        fs::rename(&renamed, &output).unwrap();
        relocate_at(&db, &renamed, &output).unwrap();
        assert!(graph_for_path_at(&db, &output).unwrap().is_some());
    }

    #[test]
    fn one_operation_can_join_two_source_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let left = dir.path().join("left.png");
        let right = dir.path().join("right.png");
        let output = dir.path().join("composite.png");
        fs::write(&left, b"left").unwrap();
        fs::write(&right, b"right").unwrap();
        fs::write(&output, b"combined").unwrap();
        record_operation_at(
            &db,
            OperationRecord {
                operation: "image.compose".into(),
                parameters: serde_json::json!({"blend": "multiply"}),
                inputs: vec![
                    OperationInput {
                        path: left.to_string_lossy().into_owned(),
                        digest: digest(&left).unwrap(),
                    },
                    OperationInput {
                        path: right.to_string_lossy().into_owned(),
                        digest: digest(&right).unwrap(),
                    },
                ],
                output_path: output.to_string_lossy().into_owned(),
                output_digest: digest(&output).unwrap(),
            },
        )
        .unwrap();
        let graph = graph_for_path_at(&db, &left).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 3);
        assert_eq!(graph.runs.len(), 1);
        assert_eq!(graph.runs[0].input_ids.len(), 2);
        assert!(graph
            .artifacts
            .iter()
            .any(|artifact| artifact.path == right.to_string_lossy()));
        assert!(graph
            .artifacts
            .iter()
            .any(|artifact| artifact.path == output.to_string_lossy()));
    }

    #[test]
    fn oversized_branching_graph_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        fs::write(&source, b"source pixels").unwrap();
        let mut connection = connection_at(&db).unwrap();
        let tx = connection.transaction().unwrap();
        tx.execute(
            "INSERT INTO artifacts(path,digest) VALUES (?1,?2)",
            params![source.to_str().unwrap(), digest(&source).unwrap()],
        )
        .unwrap();
        let source_id = tx.last_insert_rowid();
        for position in 0..1024 {
            tx.execute(
                "INSERT INTO runs(operation,parameters) VALUES ('image.crop','{}')",
                [],
            )
            .unwrap();
            let run_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO run_inputs(run_id,artifact_id,position) VALUES (?1,?2,0)",
                params![run_id, source_id],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO artifacts(path,digest,generating_run) VALUES (?1,?2,?3)",
                params![format!("child-{position}.png"), "a".repeat(64), run_id],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        assert!(graph_for_path_at(&db, &source)
            .err()
            .unwrap()
            .to_string()
            .contains("exceeds 1024 artifacts"));
    }

    #[cfg(unix)]
    #[test]
    fn trace_database_is_private_even_when_an_old_file_is_too_permissive() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        connection_at(&db).unwrap();
        assert_eq!(
            fs::metadata(&db).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&db, fs::Permissions::from_mode(0o644)).unwrap();
        connection_at(&db).unwrap();
        assert_eq!(
            fs::metadata(&db).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
