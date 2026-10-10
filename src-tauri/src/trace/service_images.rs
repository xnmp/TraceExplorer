//! Durable consumer ownership for shared image generation. Provider dispatch,
//! local publication, and transfer acknowledgement have separate checkpoints.
//! No legacy producer/Attempt is used: remote success with unavailable delivery
//! remains recoverable and must never become a retryable local failure.
use super::*;
use crate::{
    events::EventEmitter,
    host_image::{self, ImageHost, NativeHost},
    service_image_domain::ImageRequest,
};
use serde_json::{json, Value};
use std::{
    io::Write,
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use te_image_generation_contract::{
    ArtifactDescriptor, Delivery, EffectiveRecipe, Execution, OperationStatus, Preparation,
    PrepareRequest, StartRequest,
};
const SCHEMA: i64 = 1;
const APPLICATION_ID: i64 = 0x54454943;
const MAX_OUTPUT: u64 = 50 * 1024 * 1024;
const MAX_LIVE: usize = 16;
static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
static HEAVY_IO: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
static WORKERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static ADMISSION: Mutex<()> = Mutex::new(());
static NEXT_OWNER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1u64 << 63);
fn job_owner(control: crate::plugin_job::JobControl) -> crate::plugin_job::JobLease {
    crate::plugin_job::own_job(
        NEXT_OWNER.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        control,
    )
}
const MAX_DOCUMENT: usize = 1024 * 1024;
const MAX_FORMATTED_PROMPT: usize = 100 * 1024;
const MAX_RECIPE: usize = 256 * 1024;
fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}
fn document<T: Serialize>(value: &T) -> Result<String, AppError> {
    let raw = serde_json::to_string(value)
        .map_err(|_| invalid("Image consumer metadata could not be serialized"))?;
    if raw.len() > MAX_DOCUMENT {
        return Err(invalid("Image consumer metadata exceeds its limit"));
    }
    Ok(raw)
}
fn parse<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, AppError> {
    if raw.len() > MAX_DOCUMENT {
        return Err(invalid("Image consumer metadata exceeds its limit"));
    }
    serde_json::from_str(raw)
        .map_err(|_| invalid("Image consumer metadata is malformed; retain it for recovery"))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Captured {
    source_path: String,
    artifact: ArtifactDescriptor,
    width: u32,
    height: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Link {
    operation_id: String,
    job_id: u64,
    run_id: i64,
    revision: u64,
    request_digest: String,
    provider_digest: String,
    request: ImageRequest,
    prepared: StartRequest,
    recipe: EffectiveRecipe,
    captured: Vec<Captured>,
    target: PathBuf,
    phase: String,
    receipt: Option<OperationStatus>,
    output: Option<ArtifactDescriptor>,
    transfer_receipt: Option<String>,
    preparation_release_pending: bool,
    error: Option<String>,
    deadline_ms: u64,
}
/// Known additive extension; initialized links are never healed after loss.
pub(crate) fn ensure_schema(connection: &Connection) -> Result<(), AppError> {
    let marker:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='image_service_schema')",[],|r|r.get(0)).map_err(sql)?;
    let links:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='image_service_operations')",[],|r|r.get(0)).map_err(sql)?;
    let cancellations:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='image_service_cancellations')",[],|r|r.get(0)).map_err(sql)?;
    let application: i64 = connection
        .pragma_query_value(None, "application_id", |r| r.get(0))
        .map_err(sql)?;
    if !marker {
        if application != 0 || links || cancellations {
            return Err(invalid(
                "Shared image ownership schema is incomplete; recover Trace data",
            ));
        }
        let tx = connection.unchecked_transaction().map_err(sql)?;
        tx.execute_batch("CREATE TABLE image_service_schema(version INTEGER NOT NULL); INSERT INTO image_service_schema VALUES(1); CREATE TABLE image_service_operations(operation_id TEXT PRIMARY KEY,run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id),job_id INTEGER NOT NULL,request_digest TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE image_service_cancellations(operation_id TEXT PRIMARY KEY);").map_err(sql)?;
        tx.pragma_update(None, "application_id", APPLICATION_ID)
            .map_err(sql)?;
        tx.commit().map_err(sql)?;
    } else {
        let versions: Vec<i64> = connection
            .prepare("SELECT version FROM image_service_schema")
            .map_err(sql)?
            .query_map([], |r| r.get(0))
            .map_err(sql)?
            .collect::<Result<_, _>>()
            .map_err(sql)?;
        if application != APPLICATION_ID || versions != [SCHEMA] || !links || !cancellations {
            return Err(invalid(
                "Shared image ownership schema is missing or unsupported",
            ));
        }
    }
    Ok(())
}
fn managed_target(database: &Path, target: &Path) -> Result<(), AppError> {
    let root = database
        .parent()
        .ok_or_else(|| invalid("Image journal has no profile root"))?
        .join("generated");
    let relative = target
        .strip_prefix(&root)
        .map_err(|_| invalid("Image journal destination is outside its managed storage"))?;
    let parts = relative.components().collect::<Vec<_>>();
    let valid = match parts.as_slice() {
        [std::path::Component::Normal(directory), std::path::Component::Normal(filename)] => {
            let directory = directory.to_str().unwrap_or("");
            let filename = filename.to_str().unwrap_or("");
            directory.starts_with("generation-")
                && directory.len() > 11
                && directory.len() <= 128
                && directory
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                && crate::plugin_job::is_valid_output_filename(filename)
                && filename.ends_with(".png")
        }
        _ => false,
    };
    if !valid {
        return Err(invalid(
            "Image journal destination is not a native managed output",
        ));
    }
    Ok(())
}
type LinkRow = (String, i64, i64, String, String);
fn row_at(row: &rusqlite::Row<'_>) -> rusqlite::Result<LinkRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}
fn checked_link(connection: &Connection, database: &Path, row: LinkRow) -> Result<Link, AppError> {
    let (operation, run, job, digest, raw) = row;
    let link: Link = parse(&raw)?;
    validate_link(&link)?;
    managed_target(database, &link.target)?;
    if link.operation_id != operation
        || link.run_id != run
        || i64::try_from(link.job_id).ok() != Some(job)
        || link.request_digest != digest
        || !valid_digest(&digest)
        || !valid_digest(&link.provider_digest)
        || run <= 0
        || job <= 0
        || job > 9_007_199_254_740_991
    {
        return Err(invalid(
            "Image journal conflicts with its durable acceptance identity",
        ));
    }
    let accepted:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM image_jobs j JOIN runs r ON r.id=j.run_id WHERE j.operation_id=?1 AND j.run_id=?2 AND j.job_id=?3 AND j.request_digest=?4)",params![operation,run,job,digest],|r|r.get(0)).map_err(sql)?;
    if !accepted {
        return Err(invalid(
            "Image journal has no matching Trace job acceptance",
        ));
    }
    let parameters:String=connection.query_row("SELECT CASE WHEN length(CAST(parameters AS BLOB))<=1048576 THEN parameters ELSE NULL END FROM runs WHERE id=?1",[run],|r|r.get(0)).map_err(sql)?;
    let parameters: Value = parse(&parameters)?;
    let recipe = serde_json::to_value(&link.recipe).map_err(|_| invalid("Invalid image recipe"))?;
    for (key, expected) in [
        ("effective_recipe", recipe),
        (
            "effective_recipe_digest",
            json!(link.prepared.effective_recipe_digest),
        ),
        ("connection_id", json!(link.request.connection_id)),
        (
            "connection_revision",
            json!(link.request.expected_connection_revision),
        ),
        ("provider_digest", json!(link.provider_digest)),
        ("provider_package", json!(host_image::PACKAGE)),
        ("operation_id", json!(link.operation_id)),
        ("prompt", json!(link.request.prompt)),
        ("model", json!(link.request.model)),
        ("input_roles", json!(link.recipe.input_roles)),
        ("submitted_prompt", json!(link.recipe.submitted_prompt)),
        ("agent_task", json!(link.recipe.agent_task)),
        ("size", json!(link.request.size)),
        ("resolution", json!(link.request.resolution)),
        ("aspect_ratio", json!(link.request.aspect_ratio)),
        ("quality", json!(link.request.quality)),
        ("background", json!(link.request.background)),
    ] {
        if parameters.get(key) != Some(&expected) {
            return Err(invalid(
                "Trace parameters conflict with the immutable prepared image recipe",
            ));
        }
    }
    // output_storage/save_directory_hint legitimately change during a later
    // user Save. They are presentation state and excluded from recipe identity.
    Ok(link)
}
fn links_at(connection: &Connection) -> Result<Vec<Link>, AppError> {
    let mut q=connection.prepare("SELECT CASE WHEN length(operation_id)<=128 THEN operation_id ELSE NULL END,run_id,job_id,CASE WHEN length(request_digest)=64 THEN request_digest ELSE NULL END,CASE WHEN length(CAST(body AS BLOB))<=1048576 THEN body ELSE NULL END FROM image_service_operations").map_err(sql)?;
    let rows = q.query_map([], row_at).map_err(sql)?;
    let mut links = vec![];
    for row in rows {
        let database = connection
            .path()
            .filter(|p| !p.is_empty())
            .map(Path::new)
            .ok_or_else(|| invalid("Image journal requires its native database owner"))?;
        links.push(checked_link(connection, database, row.map_err(sql)?)?);
    }
    Ok(links)
}
/// Validate only an owned history row; unlinked legacy history is unchanged.
pub(crate) fn validate_history_run(connection: &Connection, run_id: i64) -> Result<(), AppError> {
    let row=connection.query_row("SELECT CASE WHEN length(operation_id)<=128 THEN operation_id ELSE NULL END,run_id,job_id,CASE WHEN length(request_digest)=64 THEN request_digest ELSE NULL END,CASE WHEN length(CAST(body AS BLOB))<=1048576 THEN body ELSE NULL END FROM image_service_operations WHERE run_id=?1",[run_id],row_at).optional().map_err(sql)?;
    if let Some(row) = row {
        let database = connection
            .path()
            .filter(|p| !p.is_empty())
            .map(Path::new)
            .ok_or_else(|| invalid("Image history requires its native database owner"))?;
        checked_link(connection, database, row)?;
    }
    Ok(())
}
pub(crate) fn protected_runs(connection: &Connection) -> Result<HashSet<i64>, AppError> {
    Ok(links_at(connection)?
        .into_iter()
        .map(|link| link.run_id)
        .collect())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn remaining_budget(deadline_ms: u64, wall_now_ms: u64) -> Duration {
    Duration::from_millis(deadline_ms.saturating_sub(wall_now_ms).min(600_000))
}
fn budget_expired(
    remaining: Duration,
    elapsed: Duration,
    deadline_ms: u64,
    wall_now_ms: u64,
) -> bool {
    elapsed >= remaining || wall_now_ms >= deadline_ms
}
fn terminal(phase: &str) -> bool {
    matches!(phase, "succeeded" | "failed" | "cancelled" | "discarded")
}
fn load_link(
    connection: &Connection,
    database: &Path,
    operation: &str,
) -> Result<Option<Link>, AppError> {
    let row=connection.query_row("SELECT CASE WHEN length(operation_id)<=128 THEN operation_id ELSE NULL END,run_id,job_id,CASE WHEN length(request_digest)=64 THEN request_digest ELSE NULL END,CASE WHEN length(CAST(body AS BLOB))<=1048576 THEN body ELSE NULL END FROM image_service_operations WHERE operation_id=?1",[operation],row_at).optional().map_err(sql)?;
    row.map(|row| checked_link(connection, database, row))
        .transpose()
}
fn read_link(database: &Path, operation: &str) -> Result<Option<Link>, AppError> {
    load_link(&connection_at(database)?, database, operation)
}
fn save_link(tx: &rusqlite::Transaction<'_>, link: &Link) -> Result<(), AppError> {
    let changed=tx.execute("UPDATE image_service_operations SET body=?2 WHERE operation_id=?1 AND run_id=?3 AND request_digest=?4",params![link.operation_id,document(link)?,link.run_id,link.request_digest]).map_err(sql)?;
    if changed != 1 {
        return Err(invalid("Image consumer ownership changed"));
    }
    Ok(())
}
fn update(
    database: &Path,
    operation: &str,
    f: impl FnOnce(&rusqlite::Transaction<'_>, &mut Link) -> Result<(), AppError>,
) -> Result<Link, AppError> {
    let mut connection = connection_at(database)?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(sql)?;
    let mut link = load_link(&tx, database, operation)?
        .ok_or_else(|| invalid("Image journal operation is missing"))?;
    let identity = (
        link.operation_id.clone(),
        link.run_id,
        link.job_id,
        link.request_digest.clone(),
    );
    let before = document(&link)?;
    f(&tx, &mut link)?;
    if before != document(&link)? {
        link.revision = link
            .revision
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(|| invalid("Image state revision overflow"))?;
    }
    validate_link(&link)?;
    managed_target(database, &link.target)?;
    if identity
        != (
            link.operation_id.clone(),
            link.run_id,
            link.job_id,
            link.request_digest.clone(),
        )
    {
        return Err(invalid("Image transition changed its acceptance identity"));
    }
    save_link(&tx, &link)?;
    tx.commit().map_err(sql)?;
    Ok(link)
}
fn cancelled_at(connection: &Connection, operation: &str) -> Result<bool, AppError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM image_service_cancellations WHERE operation_id=?1)",
            [operation],
            |r| r.get(0),
        )
        .map_err(sql)
}
fn cancel_at(database: &Path, operation: &str) -> Result<(), AppError> {
    if !te_image_generation_contract::valid_operation_id(operation) {
        return Err(invalid("Invalid image operation ID"));
    }
    let mut connection = connection_at(database)?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(sql)?;
    let accepted: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM image_service_operations WHERE operation_id=?1)",
            [operation],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let pending:i64=tx.query_row("SELECT COUNT(*) FROM image_service_cancellations c WHERE NOT EXISTS(SELECT 1 FROM image_service_operations o WHERE o.operation_id=c.operation_id)",[],|r|r.get(0)).map_err(sql)?;
    if !accepted && !cancelled_at(&tx, operation)? && pending >= 128 {
        return Err(invalid("Too many pending image cancellation intents"));
    }
    tx.execute(
        "INSERT OR IGNORE INTO image_service_cancellations(operation_id)VALUES(?1)",
        [operation],
    )
    .map_err(sql)?;
    tx.commit().map_err(sql)?;
    Ok(())
}
pub(crate) fn cancel_operation(operation: &str) -> Result<(), AppError> {
    with_trace_owner(|database| cancel_at(database, operation))
}
fn snapshot_at(database: &Path, operation: &str) -> Result<Option<Value>, AppError> {
    let connection = connection_at(database)?;
    let Some(link) = links_at(&connection)?
        .into_iter()
        .find(|l| l.operation_id == operation)
    else {
        return Ok(None);
    };
    let state: String = connection
        .query_row("SELECT status FROM runs WHERE id=?1", [link.run_id], |r| {
            r.get(0)
        })
        .map_err(sql)?;
    let output: Option<String> = connection
        .query_row(
            "SELECT path FROM artifacts WHERE generating_run=?1 ORDER BY id DESC LIMIT 1",
            [link.run_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    Ok(Some(
        json!({"jobId":link.job_id,"runId":link.run_id,"operationId":link.operation_id,"revision":link.revision,"preparationReleasePending":link.preparation_release_pending,"workerActive":worker_active(database,operation),"status":state,"outputPath":output,"error":link.error,"recoveryState":link.phase,"providerExecution":link.receipt.as_ref().map(|r|&r.execution),"providerDelivery":link.receipt.as_ref().map(|r|&r.delivery)}),
    ))
}
pub(crate) fn status(operation: &str) -> Result<Option<Value>, AppError> {
    snapshot_at(&database_path()?, operation)
}
fn artifact_valid(d: &ArtifactDescriptor, output: bool) -> bool {
    te_image_generation_contract::valid_operation_id(&d.handle)
        && valid_digest(&d.sha256)
        && d.byte_length > 0
        && d.byte_length <= if output { MAX_OUTPUT } else { 20 * 1024 * 1024 }
        && if output {
            d.media_type == "image/png"
        } else {
            matches!(
                d.media_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp"
            )
        }
}
fn recipe_representable(recipe: &EffectiveRecipe) -> Result<bool, AppError> {
    Ok(!recipe.submitted_prompt.trim().is_empty()
        && recipe.submitted_prompt.len() <= MAX_FORMATTED_PROMPT
        && recipe
            .agent_task
            .as_ref()
            .is_none_or(|task| !task.trim().is_empty() && task.len() <= MAX_FORMATTED_PROMPT)
        && document(recipe)?.len() <= MAX_RECIPE)
}
fn validate_link(l: &Link) -> Result<(), AppError> {
    l.request.validate()?;
    if !recipe_representable(&l.recipe)?
        || l.request_digest != hex::encode(Sha256::digest(document(&l.request)?.as_bytes()))
        || l.recipe.schema_version != 1
        || l.recipe.formatter_version != 1
        || l.recipe.input_roles.len() != l.captured.len()
        || l.prepared.preparation_token.is_empty()
        || l.prepared.preparation_token.len() > 256
        || l.revision == 0
        || l.revision > 9_007_199_254_740_991
        || !te_image_generation_contract::valid_operation_id(&l.operation_id)
        || l.prepared.operation_id != l.operation_id
        || l.recipe.digest() != l.prepared.effective_recipe_digest
        || l.prepared.connection_id != l.request.connection_id
        || l.prepared.expected_connection_revision != l.request.expected_connection_revision
        || l.prepared.model != l.request.model
        || l.prepared.prompt != l.request.prompt
        || l.prepared.options != l.request.options()
        || l.recipe.model != l.request.model
        || !matches!(l.recipe.adapter.as_str(), "openai-images" | "codex-cli")
        || l.recipe.endpoint_identity.is_empty()
        || l.recipe.endpoint_identity.len() > 4096
        || l.recipe.connection_id != l.request.connection_id
        || l.recipe.connection_revision != l.request.expected_connection_revision
        || l.recipe.options != l.request.options()
        || l.recipe.input_digests
            != l.captured
                .iter()
                .map(|i| i.artifact.sha256.clone())
                .collect::<Vec<_>>()
        || l.prepared.inputs
            != l.captured
                .iter()
                .map(|i| i.artifact.clone())
                .collect::<Vec<_>>()
        || !matches!(
            l.phase.as_str(),
            "accepted"
                | "forwarding"
                | "running"
                | "needs_attention"
                | "copy_pending"
                | "ack_pending"
                | "succeeded"
                | "failed"
                | "cancelled"
                | "discarded"
        )
        || l.captured.len() > 8
        || l.captured.iter().any(|i| {
            !Path::new(&i.source_path).is_absolute()
                || !artifact_valid(&i.artifact, false)
                || i.width == 0
                || i.height == 0
                || u64::from(i.width) * u64::from(i.height) > 16_777_216
        })
        || !l.target.is_absolute()
        || l.target.to_string_lossy().len() > 4096
        || l.target
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || l.output.as_ref().is_some_and(|o| !artifact_valid(o, true))
        || l.deadline_ms == 0
        || l.preparation_release_pending && (l.phase != "cancelled" || l.receipt.is_some())
    {
        return Err(invalid(
            "Image consumer journal is inconsistent; retain its evidence",
        ));
    }
    if let Some(receipt) = &l.receipt {
        receipt_valid(l, receipt)?;
        match &receipt.delivery {
            Delivery::Available { output } if l.output.as_ref() != Some(output) => {
                return Err(invalid(
                    "Image journal output conflicts with provider evidence",
                ))
            }
            Delivery::Acquired { transfer_receipt }
                if l.transfer_receipt.as_ref() != Some(transfer_receipt) || l.output.is_none() =>
            {
                return Err(invalid("Image journal acquisition evidence is missing"))
            }
            _ => {}
        }
    }
    Ok(())
}
fn mark_initialized(database: &Path) -> Result<(), AppError> {
    let path = database.with_file_name(".image-service-initialized");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(b"TEIC1\n")?;
            file.sync_all()?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let mut file = regular(&path)?;
            let mut body = vec![];
            std::io::Read::by_ref(&mut file)
                .take(16)
                .read_to_end(&mut body)?;
            if body != b"TEIC1\n" {
                return Err(invalid(
                    "Image consumer initialization evidence is malformed",
                ));
            }
            drop(file);
            sync_regular(&path)?;
        }
        Err(e) => return Err(e.into()),
    };
    sync_ancestors(
        path.parent()
            .ok_or_else(|| invalid("Missing profile root"))?,
    )
}
fn regular(path: &Path) -> Result<File, AppError> {
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::ffi::OsStrExt,
            },
        };
        if !path.is_absolute() {
            return Err(invalid("Image evidence path must be absolute"));
        }
        let parts = path
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(name) => Some(Ok(name)),
                std::path::Component::RootDir => None,
                _ => Some(Err(invalid("Invalid image evidence ancestor"))),
            })
            .collect::<Result<Vec<_>, _>>()?;
        if parts.is_empty() || parts.len() > 128 {
            return Err(invalid("Image evidence path is too deep"));
        }
        let root = CString::new("/").unwrap();
        let fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut directory = unsafe { File::from_raw_fd(fd) };
        for (index, name) in parts.iter().enumerate() {
            let name = CString::new(name.as_bytes())
                .map_err(|_| invalid("Invalid image evidence path"))?;
            let flags = libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | libc::O_NOCTTY
                | libc::O_CLOEXEC
                | if index + 1 < parts.len() {
                    libc::O_DIRECTORY
                } else {
                    0
                };
            let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let next = unsafe { File::from_raw_fd(fd) };
            if index + 1 == parts.len() {
                if !next.metadata()?.is_file() {
                    return Err(invalid("Image evidence must be a regular file"));
                }
                return Ok(next);
            }
            directory = next;
        }
        unreachable!()
    }
    #[cfg(not(unix))]
    {
        if !path.is_absolute() {
            return Err(invalid("Image evidence path must be absolute"));
        }
        // FILE_FLAG_OPEN_REPARSE_POINT covers only the final component; Windows
        // still follows a junction or symlink substituted for an ancestor
        // directory. `is_symlink` is true for every name-surrogate reparse
        // point, junctions included, matching the Unix no-follow walk.
        for ancestor in path.ancestors().skip(1) {
            if ancestor.parent().is_none() {
                break;
            }
            if fs::symlink_metadata(ancestor)?.file_type().is_symlink() {
                return Err(invalid(
                    "Image evidence ancestor must not be a link or junction",
                ));
            }
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000);
        }
        let file = options.open(path)?;
        let meta = file.metadata()?;
        if !meta.is_file() || fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(invalid("Image evidence must be a regular file"));
        }
        Ok(file)
    }
}
/// Flushes an existing regular file. Unix fsyncs the no-follow handle from
/// `regular`; Windows needs a writable handle to flush.
fn sync_regular(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        regular(path)?.sync_all()?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Ok(te_plugin_runtime::durable_dir::sync_file(path)?)
    }
}
fn sync_ancestors(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        for ancestor in path.ancestors() {
            let fd = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_NONBLOCK)
                .open(ancestor)?;
            fd.sync_all()?;
        }
        Ok(())
    }
    // NTFS journals namespace changes in order, so flushing the deepest
    // directory also commits the earlier creation of its ancestors. Ancestors
    // such as a drive root are not writable by ordinary users anyway.
    #[cfg(not(unix))]
    {
        Ok(te_plugin_runtime::durable_dir::sync(path)?)
    }
}
fn inherited_hint(database: &Path, captured: &Captured) -> Result<Option<String>, AppError> {
    let path = normalize_path(Path::new(&captured.source_path))?;
    let connection = connection_at(database)?;
    let Some(id) = artifact_for_locator(&connection, &path, Some(&captured.artifact.sha256))?
    else {
        return Ok(None);
    };
    let raw:Option<String>=connection.query_row("SELECT CASE WHEN length(CAST(r.parameters AS BLOB))<=1048576 THEN r.parameters ELSE NULL END FROM artifacts a JOIN runs r ON r.id=a.generating_run WHERE a.id=?1",[id],|r|r.get(0)).optional().map_err(sql)?.flatten();
    Ok(raw
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| {
            value["save_directory_hint"]
                .as_str()
                .filter(|v| v.len() <= 4096 && !v.contains('\0'))
                .map(str::to_owned)
        }))
}
struct Acceptance {
    link: Link,
    fresh: bool,
}
/// Execution evidence recorded for a run: the shared-service receipt
/// (`provider_execution`) or a legacy adapter's `execution`, as an object with
/// a `state` or as a bare state string. `None` when the run recorded none.
fn recorded_execution_state(details: &Value) -> Option<Option<&str>> {
    let execution = details
        .get("provider_execution")
        .or_else(|| details.get("execution"))?;
    Some(match execution {
        Value::Object(fields) => fields.get("state").and_then(Value::as_str),
        other => other.as_str(),
    })
}
/// A Retry is a new paid operation, so its source must be an image run whose
/// outcome was an explicit failure. Unknown, unavailable, cancelled, running
/// and successful runs (and anything malformed) are refused before any IO.
fn retry_source_failed(database: &Path, run_id: i64) -> Result<(), AppError> {
    let refused = || invalid("Only an explicitly failed image run can be retried");
    let connection = connection_at(database)?;
    let Some((operation, status, details)) = connection
        .query_row(
            "SELECT operation,status,CASE WHEN length(CAST(result_details AS BLOB))<=1048576 THEN result_details ELSE NULL END FROM runs WHERE id=?1",
            [run_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)),
        )
        .optional()
        .map_err(sql)?
    else {
        return Err(refused());
    };
    if !matches!(
        operation.as_str(),
        "openai.image.generate" | "openai.image.edit"
    ) || status != "failed"
    {
        return Err(refused());
    }
    if let Some(details) = details {
        let details: Value = parse(&details).map_err(|_| refused())?;
        if recorded_execution_state(&details).is_some_and(|state| state != Some("failed")) {
            return Err(refused());
        }
    }
    let row=connection.query_row("SELECT CASE WHEN length(operation_id)<=128 THEN operation_id ELSE NULL END,run_id,job_id,CASE WHEN length(request_digest)=64 THEN request_digest ELSE NULL END,CASE WHEN length(CAST(body AS BLOB))<=1048576 THEN body ELSE NULL END FROM image_service_operations WHERE run_id=?1",[run_id],row_at).optional().map_err(sql)?;
    if let Some(row) = row {
        let link = checked_link(&connection, database, row).map_err(|_| refused())?;
        if link.phase != "failed"
            || !link
                .receipt
                .as_ref()
                .is_some_and(|r| matches!(r.execution, Execution::Failed { .. }))
        {
            return Err(refused());
        }
    }
    Ok(())
}
#[cfg(test)]
fn accept_with(host:&dyn ImageHost,database:&Path,generated:&Path,request:ImageRequest,job_id:u64,operation:String,control:&crate::plugin_job::JobControl,production:bool)->Result<Acceptance,AppError> {
    accept_with_deadline(host,database,generated,request,job_id,operation,control,production,now_ms().saturating_add(600_000))
}
fn accept_with_deadline(
    host: &dyn ImageHost,
    database: &Path,
    generated: &Path,
    request: ImageRequest,
    job_id: u64,
    operation: String,
    control: &crate::plugin_job::JobControl,
    production: bool,
    deadline_ms:u64,
) -> Result<Acceptance, AppError> {
    let started=Instant::now();
    let remaining=remaining_budget(deadline_ms,now_ms());
    let expired=||budget_expired(remaining,started.elapsed(),deadline_ms,now_ms());
    let check=|| {control.check()?;if expired(){Err(AppError::Service{code:"timed_out".into(),message:"Image admission deadline elapsed before paid dispatch".into()})}else{Ok(())}};
    request.validate()?;
    if !te_image_generation_contract::valid_operation_id(&operation)
        || job_id == 0
        || job_id > 9_007_199_254_740_991
    {
        return Err(invalid("Invalid image acceptance identity"));
    }
    let request_digest = hex::encode(Sha256::digest(document(&request)?.as_bytes()));
    if let Some(link) = read_link(database, &operation)? {
        if link.request_digest != request_digest {
            return Err(invalid(
                "Image operation ID already belongs to another request",
            ));
        }
        return Ok(Acceptance { link, fresh: false });
    }
    if let Some(source) = request.retry_of {
        retry_source_failed(database, source)?;
    }
    check()?;
    if cancelled_at(&connection_at(database)?, &operation)? {
        return Err(invalid("Image operation cancelled before acceptance"));
    }
    let availability = host_image::describe(host)?;
    if !availability.available {
        return Err(AppError::Service {
            code: "service_unavailable".into(),
            message: "Image Generation is unavailable; configure or enable the provider".into(),
        });
    }
    let provider_digest = availability
        .provider_digest
        .filter(|d| valid_digest(d))
        .ok_or_else(|| invalid("Image provider identity is missing"))?;
    let inputs = request.inputs()?;
    let result = (|| {
        let captured: Vec<Captured> = if inputs.is_empty() {
            vec![]
        } else {
            let value=host.call("host.artifacts.capture",json!({"operationId":operation,"inputs":inputs.iter().map(|(path,digest)|json!({"path":path,"expectedDigest":digest})).collect::<Vec<_>>()}),&||control.check().is_err()||expired())?;
            let captured: Vec<Captured> = serde_json::from_value(value["inputs"].clone())
                .map_err(|_| invalid("Invalid host image capture"))?;
            if captured.len() != inputs.len()
                || captured.iter().zip(&inputs).any(|(capture, (_, digest))| {
                    !artifact_valid(&capture.artifact, false)
                        || !Path::new(&capture.source_path).is_absolute()
                        || capture.source_path.len() > 4096
                        || capture.source_path.contains('\0')
                        || capture.width == 0
                        || capture.height == 0
                        || u64::from(capture.width) * u64::from(capture.height) > 16_777_216
                        || digest
                            .as_ref()
                            .is_some_and(|d| d != &capture.artifact.sha256)
                })
                || captured
                    .iter()
                    .try_fold(0u64, |sum, c| sum.checked_add(c.artifact.byte_length))
                    .is_none_or(|sum| sum > 64 * 1024 * 1024)
            {
                return Err(invalid(
                    "Host capture does not match the ordered image inputs",
                ));
            }
            captured
        };
        check()?;
        let prepare = PrepareRequest {
            operation_id: operation.clone(),
            connection_id: request.connection_id.clone(),
            expected_connection_revision: request.expected_connection_revision.clone(),
            model: request.model.clone(),
            prompt: request.prompt.clone(),
            inputs: captured.iter().map(|i| i.artifact.clone()).collect(),
            options: request.options(),
        };
        let value = host_image::invoke(
            host,
            "prepare",
            serde_json::to_value(&prepare).map_err(|_| invalid("Invalid preparation"))?,
            &|| control.check().is_err()||expired(),
        )?;
        check()?;
        let preparation: Preparation =
            serde_json::from_value(value).map_err(|_| invalid("Invalid image preparation"))?;
        let recipe = preparation.effective_recipe;
        if preparation.preparation_token.is_empty()
            || preparation.preparation_token.len() > 256
            || recipe.digest() != preparation.effective_recipe_digest
            || recipe.schema_version != 1
            || recipe.formatter_version != 1
            || recipe.connection_id != request.connection_id
            || recipe.connection_revision != request.expected_connection_revision
            || recipe.model != request.model
            || recipe.options != request.options()
            || recipe.input_digests
                != captured
                    .iter()
                    .map(|i| i.artifact.sha256.clone())
                    .collect::<Vec<_>>()
            || recipe.input_roles.len() != captured.len()
            || recipe.submitted_prompt.is_empty()
            || !recipe_representable(&recipe)?
            || recipe.adapter.is_empty()
            || recipe.endpoint_identity.is_empty()
        {
            return Err(invalid("Prepared image recipe does not match this request"));
        }
        let prepared = StartRequest {
            operation_id: operation.clone(),
            connection_id: prepare.connection_id,
            expected_connection_revision: prepare.expected_connection_revision,
            preparation_token: preparation.preparation_token,
            effective_recipe_digest: preparation.effective_recipe_digest,
            model: prepare.model,
            prompt: prepare.prompt,
            inputs: prepare.inputs,
            options: prepare.options,
        };
        let save_hint = captured
            .first()
            .map(|input| inherited_hint(database, input))
            .transpose()?
            .flatten()
            .unwrap_or_else(|| request.output_dir.clone());
        let output = crate::temporary_output::prepare(
            generated,
            request.source_path.as_deref().map(Path::new),
            save_hint,
        )?;
        let target = output.directory.join(&output.filename);
        sync_ancestors(&output.directory)?;
        let mut parameters = json!({"prompt":request.prompt,"model":request.model,"size":request.size,"resolution":request.resolution,"aspect_ratio":request.aspect_ratio,"quality":request.quality,"background":request.background,"input_roles":recipe.input_roles,"submitted_prompt":recipe.submitted_prompt,"agent_task":recipe.agent_task,"effective_recipe":recipe,"effective_recipe_digest":prepared.effective_recipe_digest,"connection_id":request.connection_id,"connection_revision":request.expected_connection_revision,"provider_package":host_image::PACKAGE,"provider_digest":provider_digest,"operation_id":operation,"output_storage":"temporary","save_directory_hint":output.save_directory_hint,"suggested_filename":output.filename});
        if let Some(batch) = &request.batch {
            parameters["batch"] =
                serde_json::to_value(batch).map_err(|_| invalid("Invalid batch"))?;
        }
        if let Some(retry) = request.retry_of {
            parameters["retry_of"] = retry.into();
        }
        document(&parameters)?;
        let start = OperationStart {
            operation: if !captured.is_empty() {
                "openai.image.edit"
            } else {
                "openai.image.generate"
            }
            .into(),
            parameters,
            inputs: captured
                .iter()
                .map(|i| OperationInput {
                    path: i.source_path.clone(),
                    digest: i.artifact.sha256.clone(),
                })
                .collect(),
        };
        let mut link = Link {
            operation_id: operation.clone(),
            job_id,
            run_id: 0,
            revision: 1,
            request_digest: request_digest.clone(),
            provider_digest,
            request,
            prepared,
            recipe,
            captured,
            target,
            phase: "accepted".into(),
            receipt: None,
            output: None,
            transfer_receipt: None,
            preparation_release_pending: false,
            error: None,
            deadline_ms,
        };
        // The complete metadata must fit before any durable local acceptance.
        // The transactional writer repeats this check after assigning the run ID.
        document(&link)?;
        let action = |database: &Path| {
            // Only metadata is protected here. Capture and prepare already finished.
            let _gate = ADMISSION
                .lock()
                .map_err(|_| invalid("Image acceptance guard is unavailable"))?;
            if production && !READY.load(std::sync::atomic::Ordering::Acquire) {
                return Err(invalid("Trace is draining; image acceptance is closed"));
            }
            check()?;
            if links_at(&connection_at(database)?)?
                .iter()
                .filter(|l| !terminal(&l.phase) || l.preparation_release_pending)
                .count()
                >= MAX_LIVE
                && read_link(database, &operation)?.is_none()
            {
                return Err(invalid(
                    "Resolve retained image operations before starting more",
                ));
            }
            if cancelled_at(&connection_at(database)?, &operation)? {
                return Err(invalid("Image operation cancelled before acceptance"));
            }
            let accepted = jobs::accept_at_with_link(
                database,
                start,
                &operation,
                job_id,
                &request_digest,
                |tx, run| {
                    link.run_id = run;
                    tx.execute("INSERT INTO image_service_operations(operation_id,run_id,job_id,request_digest,body)VALUES(?1,?2,?3,?4,?5)",params![operation,run,job_id as i64,request_digest,document(&link)?]).map_err(sql)?;
                    Ok(())
                },
            )?;
            Ok(accepted)
        };
        let (_, fresh, _) = if production {
            with_trace_owner(action)?
        } else {
            action(database)?
        };
        let saved = read_link(database, &operation)?
            .ok_or_else(|| invalid("Accepted image ownership is missing"))?;
        // TemporaryOutput removes only empty directories. Persisted target belongs
        // to the journal and needs its namespace even before first publication.
        std::mem::forget(output);
        mark_initialized(database)?;
        Ok(Acceptance { link: saved, fresh })
    })();
    if result.is_err() && read_link(database, &operation)?.is_none() {
        let _ = host.call(
            "host.artifacts.release",
            json!({"operationId":operation}),
            &|| false,
        );
    }
    result
}
fn receipt_valid(link: &Link, receipt: &OperationStatus) -> Result<(), AppError> {
    if receipt.version != 1
        || receipt.operation_id != link.operation_id
        || receipt.request_fingerprint != link.recipe.digest()
        || receipt.provider.package_id != host_image::PACKAGE
        || receipt.provider.service_id != host_image::SERVICE
        || receipt.provider.major != 1
        || receipt.revision == 0
        || receipt.revision > 9_007_199_254_740_991
    {
        return Err(invalid(
            "Image receipt does not match the accepted operation",
        ));
    }
    if receipt
        .diagnostics
        .as_ref()
        .is_some_and(|d| !d.valid(matches!(receipt.execution, Execution::Succeeded { .. })))
    {
        return Err(invalid("Invalid image turn diagnostics"));
    }
    let safe_error = |e: &te_image_generation_contract::SafeError| {
        !e.code.is_empty()
            && e.code.len() <= 128
            && !e.message.is_empty()
            && e.message.len() <= 1024
            && e.correlation_id.as_ref().is_none_or(|id| id.len() <= 128)
    };
    match &receipt.execution {
        Execution::Succeeded { metadata } => {
            if metadata.adapter != link.recipe.adapter
                || metadata.endpoint_identity != link.recipe.endpoint_identity
                || metadata.requested_model != link.recipe.model
                || metadata.options != link.recipe.options
                || metadata
                    .actual_model
                    .as_ref()
                    .is_some_and(|m| m.len() > 1024)
                || metadata
                    .external_request_id
                    .as_ref()
                    .is_some_and(|m| m.len() > 1024)
                || metadata.thread_id.as_ref().is_some_and(|m| m.len() > 1024)
            {
                return Err(invalid(
                    "Image execution metadata conflicts with the prepared recipe",
                ));
            }
            match &receipt.delivery {
                Delivery::Available { output } if artifact_valid(output, true) => {}
                Delivery::Unavailable { reason } if !reason.is_empty() && reason.len() <= 1024 => {}
                Delivery::Acquired { transfer_receipt }
                    if te_image_generation_contract::valid_operation_id(transfer_receipt) => {}
                Delivery::Discarded {} => {}
                _ => return Err(invalid("Invalid successful image delivery")),
            }
        }
        Execution::Failed { error } | Execution::Unknown { error } => {
            if !safe_error(error) || receipt.delivery != (Delivery::None {}) {
                return Err(invalid("Invalid image failure receipt"));
            }
        }
        _ => {
            if receipt.delivery != (Delivery::None {}) {
                return Err(invalid(
                    "Non-successful image execution cannot deliver an image",
                ));
            }
        }
    }
    Ok(())
}
fn receipt_transition(old: &OperationStatus, new: &OperationStatus) -> Result<(), AppError> {
    if let Some(before) = &old.diagnostics {
        let Some(after) = &new.diagnostics else {
            return Err(invalid("Image receipt discarded its turn diagnostics"));
        };
        let (
            te_image_generation_contract::OperationDiagnostics::CodexImageTurn {
                thread_id: a,
                explanation: ea,
                ..
            },
            te_image_generation_contract::OperationDiagnostics::CodexImageTurn {
                thread_id: b,
                explanation: eb,
                ..
            },
        ) = (before, after);
        if a != b
            || ea.as_ref().is_some_and(|e| Some(e) != eb.as_ref())
            || !matches!(old.execution, Execution::Accepted {} | Execution::Running {}) && before != after
        {
            return Err(invalid(
                "Image receipt changed its durable turn diagnostics",
            ));
        }
    }
    if matches!(
        old.execution,
        Execution::Succeeded { .. }
            | Execution::Failed { .. }
            | Execution::Cancelled {}
            | Execution::Unknown { .. }
    ) && old.execution != new.execution
    {
        return Err(invalid("Image receipt changed its terminal execution"));
    }
    if matches!(old.execution, Execution::Running {}) && matches!(new.execution, Execution::Accepted {}) {
        return Err(invalid("Image receipt regressed execution"));
    }
    match (&old.delivery, &new.delivery) {
        (Delivery::Acquired { .. } | Delivery::Discarded {}, _) if old.delivery != new.delivery => {
            return Err(invalid("Image receipt changed disposed delivery"))
        }
        (Delivery::Available { output: a }, Delivery::Available { output: b }) if a != b => {
            return Err(invalid("Image receipt changed its sealed output"))
        }
        _ => {}
    }
    Ok(())
}
fn known_fields(raw: &Value, typed: &Value) -> bool {
    match (raw, typed) {
        (Value::Object(a), Value::Object(b)) => a
            .iter()
            .all(|(key, value)| b.get(key).is_some_and(|typed| known_fields(value, typed))),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| known_fields(a, b))
        }
        _ => raw == typed,
    }
}
fn observe(database: &Path, operation: &str, value: Value) -> Result<Link, AppError> {
    if serde_json::to_vec(&value)
        .map_err(|_| invalid("Invalid image receipt"))?
        .len()
        > 16 * 1024
    {
        return Err(invalid("Image receipt exceeds its limit"));
    }
    let receipt: OperationStatus =
        serde_json::from_value(value.clone()).map_err(|_| invalid("Malformed image receipt"))?;
    if !known_fields(
        &value,
        &serde_json::to_value(&receipt).map_err(|_| invalid("Invalid image receipt"))?,
    ) {
        return Err(invalid("Image receipt contains unsupported fields"));
    }
    update(database, operation, |tx, link| {
        receipt_valid(link, &receipt)?;
        if let Some(old) = &link.receipt {
            if receipt.revision < old.revision {
                return Ok(());
            }
            if receipt.revision == old.revision {
                if old != &receipt {
                    return Err(invalid("Image provider reused a receipt revision"));
                }
                return Ok(());
            }
            receipt_transition(old, &receipt)?;
        }
        if let Delivery::Available { output } = &receipt.delivery {
            if link.output.as_ref().is_some_and(|saved| saved != output) {
                return Err(invalid("Image provider changed the owned output"));
            }
            link.output = Some(output.clone());
        }
        if let Delivery::Acquired { transfer_receipt } = &receipt.delivery {
            if link.transfer_receipt.as_ref() != Some(transfer_receipt) {
                return Err(invalid(
                    "Image acknowledgement has no durable local acquisition proof",
                ));
            }
        }
        if matches!(receipt.execution, Execution::Accepted {} | Execution::Running {}) {
            link.phase = "running".into();
        }
        let mut details = json!({"provider_execution":receipt.execution,"provider_delivery":receipt.delivery,"provider_receipt_revision":receipt.revision});
        if let Some(diagnostics) = &receipt.diagnostics {
            details["provider_diagnostics"] = serde_json::to_value(diagnostics)
                .map_err(|_| invalid("Invalid image diagnostics"))?;
            let te_image_generation_contract::OperationDiagnostics::CodexImageTurn {
                thread_id,
                turn_state,
                usage,
                explanation,
            } = diagnostics;
            details["thread_id"] = json!(thread_id);
            details["turn_state"] = json!(turn_state);
            if let Some(usage) = usage {
                details["usage"] = json!({"input_tokens":usage.input_tokens,"cached_input_tokens":usage.cached_input_tokens,"output_tokens":usage.output_tokens});
            }
            if let Some(explanation) = explanation {
                let key = match explanation.kind {
                    te_image_generation_contract::ExplanationKind::Reply => "codex_reply",
                    te_image_generation_contract::ExplanationKind::Error => "codex_error",
                };
                details[key] = json!({"text":explanation.text,"truncated":explanation.truncated});
            }
        }
        tx.execute(
            "UPDATE runs SET result_details=?2 WHERE id=?1",
            params![link.run_id, document(&details)?],
        )
        .map_err(sql)?;
        link.receipt = Some(receipt);
        Ok(())
    })
}
fn attention(database: &Path, operation: &str, reason: &str) -> Result<Link, AppError> {
    update(database, operation, |tx, link| {
        if !terminal(&link.phase) {
            link.phase = "needs_attention".into();
            link.error = Some(reason.into());
            tx.execute("UPDATE runs SET status='uncertain',error=?2 WHERE id=?1 AND status IN('running','uncertain')",params![link.run_id,reason]).map_err(sql)?;
        }
        Ok(())
    })
}
fn progress(app: &EventEmitter, database: &Path, operation: &str) {
    if let Ok(Some(snapshot)) = snapshot_at(database, operation) {
        let _ = app.emit("openai-image-progress", snapshot);
    }
    let _ = app.emit("trace:changed", ());
}
fn finish(
    database: &Path,
    operation: &str,
    phase: &str,
    error: Option<String>,
) -> Result<Link, AppError> {
    update(database, operation, |tx, link| {
        if terminal(&link.phase) {
            if link.phase != phase {
                return Err(invalid("Image consumer terminal state changed"));
            }
            return Ok(());
        }
        link.phase = phase.into();
        link.error = error;
        tx.execute("UPDATE runs SET status=?2,error=?3,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND status IN('running','uncertain')",params![link.run_id,phase,link.error]).map_err(sql)?;
        Ok(())
    })
}
fn emit_terminal(app: &EventEmitter, link: &Link) {
    let _ = app.emit("trace:changed", ());
    if link.phase == "succeeded" {
        let _=app.emit("openai-image-complete",json!({"jobId":link.job_id,"runId":link.run_id,"outputPath":link.target,"operationId":link.operation_id}));
    } else {
        let _=app.emit("openai-image-error",json!({"jobId":link.job_id,"runId":link.run_id,"error":link.error.as_deref().unwrap_or(&link.phase),"operationId":link.operation_id}));
    }
}
fn claim_dispatch(database: &Path, operation: &str, fresh: bool) -> Result<(Link, bool), AppError> {
    let mut claimed = false;
    let link = update(database, operation, |tx, link| {
        if link.phase != "accepted" {
            return Ok(());
        }
        if cancelled_at(tx, operation)? {
            link.phase = "cancelled".into();
            link.preparation_release_pending = true;
            link.error = Some("Cancelled before provider dispatch".into());
            tx.execute("UPDATE runs SET status='cancelled',error='cancelled_before_dispatch',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND status='running'",[link.run_id]).map_err(sql)?;
        } else if fresh {
            link.phase = "forwarding".into();
            claimed = true;
        } else {
            // Restart cannot determine whether a process died around dispatch.
            // Even a never-forwarded row is recovered without repeating start.
            link.phase = "needs_attention".into();
            link.error = Some(
                "Accepted image requires recovery; no automatic dispatch after restart".into(),
            );
            tx.execute("UPDATE runs SET status='uncertain',error='image_recovery_pending' WHERE id=?1 AND status='running'",[link.run_id]).map_err(sql)?;
        }
        Ok(())
    })?;
    Ok((link, claimed))
}
fn prepared_evidence(
    database: &Path,
    run: i64,
) -> Result<Option<(String, String, String, String)>, AppError> {
    connection_at(database)?.query_row("SELECT prepared_output_path,prepared_output_digest,prepared_object_identity,prepared_anchor_path FROM runs WHERE id=?1 AND prepared_output_digest IS NOT NULL",[run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(sql)
}
fn published_owned(
    database: &Path,
    link: &Link,
    output: &ArtifactDescriptor,
) -> Result<bool, AppError> {
    if let Some((path, digest, identity, anchor)) = prepared_evidence(database, link.run_id)? {
        if Path::new(&path) != link.target || digest != output.sha256 {
            return Err(invalid(
                "Local image publication evidence conflicts with the output",
            ));
        }
        return match observe_publication(&link.target, Path::new(&anchor), &digest, &identity) {
            PublicationObservation::Published => Ok(true),
            PublicationObservation::NotPublished => Ok(false),
            PublicationObservation::Unavailable => Err(invalid(
                "Local image evidence is unavailable; retain it for recovery",
            )),
        };
    }
    Ok(false)
}
fn heavy_io(
    control: &crate::plugin_job::JobControl,
) -> Result<tokio::sync::OwnedSemaphorePermit, AppError> {
    let slots = HEAVY_IO
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        control.check()?;
        match slots.clone().try_acquire_owned() {
            Ok(permit) => return Ok(permit),
            Err(tokio::sync::TryAcquireError::Closed) => {
                return Err(invalid("Image byte IO is unavailable"))
            }
            Err(tokio::sync::TryAcquireError::NoPermits) => {}
        }
        if Instant::now() >= deadline {
            return Err(invalid(
                "Image byte IO is busy; the original output remains recoverable",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn copy_exact(
    host: &dyn ImageHost,
    database: &Path,
    link: &Link,
    output: &ArtifactDescriptor,
    control: &crate::plugin_job::JobControl,
) -> Result<(), AppError> {
    let _heavy = heavy_io(control)?;
    if published_owned(database, link, output)? {
        return Ok(());
    }
    if let Some((path, digest, identity, anchor)) = prepared_evidence(database, link.run_id)? {
        if Path::new(&path) != link.target || digest != output.sha256 {
            return Err(invalid("Prepared publication changed its output"));
        }
        let mut source = regular(Path::new(&anchor))?;
        if crate::files::trace_file_identity_of(&source)? != identity
            || digest_file(&mut source)? != digest
        {
            return Err(invalid(
                "Retained publication anchor does not match the sealed output",
            ));
        }
        // A hard link atomically refuses an occupied target and preserves the
        // exact previously prepared inode. Never copy or replace a racing file.
        control.check()?;
        fs::hard_link(&anchor, &link.target)?;
        sync_regular(&link.target)?;
        sync_ancestors(
            link.target
                .parent()
                .ok_or_else(|| invalid("Missing image parent"))?,
        )?;
        if !published_owned(database, link, output)? {
            return Err(invalid(
                "Recovered publication identity could not be verified",
            ));
        }
        return Ok(());
    }
    let result = host.call(
        "host.artifacts.read",
        json!({"operationId":link.operation_id,"artifact":output}),
        &|| control.check().is_err(),
    )?;
    let returned: ArtifactDescriptor = serde_json::from_value(result["artifact"].clone())
        .map_err(|_| invalid("Invalid sealed image descriptor"))?;
    if &returned != output {
        return Err(invalid("Host returned a different sealed image"));
    }
    let path = result["path"]
        .as_str()
        .filter(|p| Path::new(p).is_absolute() && p.len() <= 4096 && !p.contains('\0'))
        .ok_or_else(|| invalid("Invalid sealed image path"))?;
    let mut source = regular(Path::new(path))?;
    if source.metadata()?.len() != output.byte_length {
        return Err(invalid("Sealed image length changed"));
    }
    let parent = link
        .target
        .parent()
        .ok_or_else(|| invalid("Image destination is missing"))?;
    sync_ancestors(parent)?;
    // A temporary uncertainty state remains non-retryable; publication can use
    // the legacy proof helper only after resetting this owned run to running.
    connection_at(database)?
        .execute(
            "UPDATE runs SET status='running',error=NULL WHERE id=?1 AND status='uncertain'",
            [link.run_id],
        )
        .map_err(sql)?;
    let mut stage = crate::files::publication::StagedEntry::prepare(parent, |payload| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(payload)?;
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            control.check()?;
            let n = source.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            total = total
                .checked_add(n as u64)
                .ok_or_else(|| invalid("Image byte count overflow"))?;
            if total > output.byte_length || total > MAX_OUTPUT {
                return Err(invalid("Sealed image exceeds its declared bounds"));
            }
            hasher.update(&chunk[..n]);
            file.write_all(&chunk[..n])?;
        }
        if total != output.byte_length || hex::encode(hasher.finalize()) != output.sha256 {
            return Err(invalid("Sealed image bytes do not match their descriptor"));
        }
        file.sync_all()?;
        let mut reader = image::ImageReader::new(std::io::BufReader::new(regular(payload)?))
            .with_guessed_format()
            .map_err(|_| invalid("Invalid PNG output"))?;
        if reader.format() != Some(image::ImageFormat::Png) {
            return Err(invalid("Image output must be PNG"));
        }
        let (width, height) = image::ImageReader::new(std::io::BufReader::new(regular(payload)?))
            .with_guessed_format()
            .map_err(|_| invalid("Invalid PNG dimensions"))?
            .into_dimensions()
            .map_err(|_| invalid("Invalid PNG dimensions"))?;
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_777_216 {
            return Err(invalid("PNG dimensions exceed their limit"));
        }
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(16_777_216);
        limits.max_image_height = Some(16_777_216);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader
            .decode()
            .map_err(|_| invalid("PNG output cannot be decoded within its bounds"))?;
        if decoded.width() == 0
            || decoded.height() == 0
            || u64::from(decoded.width()) * u64::from(decoded.height()) > 16_777_216
        {
            return Err(invalid("PNG dimensions exceed their limit"));
        }
        Ok(())
    })?;
    let anchor = stage.trace_anchor()?;
    sync_regular(&anchor)?;
    sync_ancestors(
        anchor
            .parent()
            .ok_or_else(|| invalid("Image anchor has no parent"))?,
    )?;
    let run = TraceRunHandle {
        database: database.into(),
        id: link.run_id,
    };
    prepare_operation_output(&run, &link.target, &output.sha256, Some(&anchor))?;
    stage.retain_trace_anchor();
    // User cancellation cannot discard already-proven provider success. Backend
    // shutdown still interrupts byte IO, leaving the immutable proof recoverable.
    control.check()?;
    stage.publish(&link.target)?;
    sync_regular(&link.target)?;
    sync_ancestors(parent)?;
    if !published_owned(database, link, output)? {
        return Err(invalid("Published image identity could not be verified"));
    }
    Ok(())
}
fn complete_local(database: &Path, operation: &str) -> Result<Link, AppError> {
    let link =
        read_link(database, operation)?.ok_or_else(|| invalid("Image ownership is missing"))?;
    let output = link
        .output
        .as_ref()
        .ok_or_else(|| invalid("Successful image has no output descriptor"))?;
    let state: String = connection_at(database)?
        .query_row("SELECT status FROM runs WHERE id=?1", [link.run_id], |r| {
            r.get(0)
        })
        .map_err(sql)?;
    if state != "succeeded" {
        let _heavy = heavy_io(&crate::plugin_job::JobControl::new())?;
        if !published_owned(database, &link, output)? {
            return Err(invalid("Image adoption proof is missing"));
        }
        complete_operation(
            &TraceRunHandle {
                database: database.into(),
                id: link.run_id,
            },
            link.target
                .to_str()
                .ok_or_else(|| invalid("Image destination is not UTF8"))?,
        )?;
    }
    update(database, operation, |_, link| {
        link.phase = "succeeded".into();
        link.error = None;
        Ok(())
    })
}
fn handoff(
    host: &dyn ImageHost,
    database: &Path,
    link: &Link,
    control: &crate::plugin_job::JobControl,
) -> Result<Link, AppError> {
    let output = link
        .output
        .as_ref()
        .ok_or_else(|| invalid("Image output is unavailable"))?;
    if link.transfer_receipt.is_none() {
        update(database, &link.operation_id, |_, link| {
            link.phase = "copy_pending".into();
            Ok(())
        })?;
        copy_exact(host, database, link, output, control)?;
        let result = host.call(
            "host.artifacts.acquired",
            json!({"operationId":link.operation_id,"artifact":output,"evidencePath":link.target}),
            &|| control.check().is_err(),
        )?;
        let proof = result["transferReceipt"]
            .as_str()
            .filter(|s| te_image_generation_contract::valid_operation_id(s))
            .ok_or_else(|| invalid("Invalid durable acquisition receipt"))?
            .to_owned();
        update(database, &link.operation_id, |_, link| {
            link.transfer_receipt = Some(proof);
            link.phase = "ack_pending".into();
            link.error = None;
            Ok(())
        })?;
    }
    let link = read_link(database, &link.operation_id)?
        .ok_or_else(|| invalid("Image ownership is missing"))?;
    if let Some(receipt) = &link.receipt {
        if let Delivery::Acquired { transfer_receipt } = &receipt.delivery {
            if link.transfer_receipt.as_ref() != Some(transfer_receipt) {
                return Err(invalid("Provider acknowledged another image acquisition"));
            }
            return complete_local(database, &link.operation_id);
        }
    }
    let value = host_image::invoke(
        host,
        "acknowledge",
        json!({"operationId":link.operation_id,"outputSha256":output.sha256,"disposition":"acquired","transferReceipt":link.transfer_receipt}),
        &|| control.check().is_err(),
    )?;
    let current = observe(database, &link.operation_id, value)?;
    match current.receipt.as_ref().map(|r| &r.delivery) {
        Some(Delivery::Acquired { .. }) => complete_local(database, &link.operation_id),
        _ => Err(invalid("Image acquisition acknowledgement remains pending")),
    }
}
#[derive(Clone, Copy)]
struct Polling {
    interval: Duration,
    settlement: usize,
}
impl Default for Polling {
    fn default() -> Self {
        Self {
            interval: Duration::from_millis(500),
            settlement: 8,
        }
    }
}
fn run_worker(
    host: &dyn ImageHost,
    database: &Path,
    operation: &str,
    fresh: bool,
    control: &crate::plugin_job::JobControl,
    app: &EventEmitter,
    polling: Polling,
) -> Result<(), AppError> {
    let monotonic = Instant::now();
    let wall_start = now_ms();
    let recorded = read_link(database, operation)?
        .ok_or_else(|| invalid("Image consumer operation is missing"))?;
    let remaining = remaining_budget(recorded.deadline_ms, wall_start);
    mark_initialized(database)?;
    control.check()?;
    if fresh
        && recorded.phase == "accepted"
        && budget_expired(
            remaining,
            monotonic.elapsed(),
            recorded.deadline_ms,
            now_ms(),
        )
    {
        cancel_at(database, operation)?;
    }
    let (mut link, dispatch) = claim_dispatch(database, operation, fresh)?;
    if terminal(&link.phase) {
        if link.preparation_release_pending {
            let response = host.call(
                "host.artifacts.release",
                json!({"operationId":operation}),
                &|| false,
            )?;
            if !response["released"].is_boolean() {
                return Err(invalid("Invalid preparation cleanup acknowledgement"));
            }
            link = update(database, operation, |_, link| {
                link.preparation_release_pending = false;
                Ok(())
            })?;
        }
        emit_terminal(app, &link);
        return Ok(());
    }
    if dispatch && !budget_expired(remaining, monotonic.elapsed(), link.deadline_ms, now_ms()) {
        // This sole start call is justified by the durable claim just committed.
        // Neither timeout, dropped caller future nor any restart can repeat it.
        let value = host_image::invoke(
            host,
            "start",
            serde_json::to_value(&link.prepared)
                .map_err(|_| invalid("Invalid recorded image start"))?,
            &|| {
                control.check().is_err()
                    || budget_expired(remaining, monotonic.elapsed(), link.deadline_ms, now_ms())
            },
        );
        if let Ok(value) = value {
            link = observe(database, operation, value)?;
        }
    }
    if !dispatch {
        // Availability can improve after a persisted success/unavailable receipt.
        // Consult the provider before interpreting any retained receipt.
        let value = host_image::invoke(host, "status", json!({"operationId":operation}), &|| {
            control.check().is_err()
        });
        match value {
            Ok(value) => link = observe(database, operation, value)?,
            Err(AppError::Service { code, .. }) if code == "recovery_stopped" => {
                attention(database,operation,"Automatic recovery was stopped; retained operation requires explicit resolution")?;
                progress(app, database, operation);
                return Ok(());
            }
            Err(_) => {}
        }
    }
    let mut cancel_sent = false;
    let mut failures = 0usize;
    let mut expired_polls = 0usize;
    let mut settlement: Option<Instant> = None;
    loop {
        if control.check().is_err() {
            attention(
                database,
                operation,
                "Backend shutdown; provider outcome and image delivery require recovery",
            )?;
            progress(app, database, operation);
            return Ok(());
        }
        let expired = budget_expired(remaining, monotonic.elapsed(), link.deadline_ms, now_ms());
        if expired && settlement.is_none() {
            settlement = Some(Instant::now());
        }
        let settling_expired =
            || settlement.is_some_and(|start| start.elapsed() >= Duration::from_secs(5));
        let cancel = cancelled_at(&connection_at(database)?, operation)? || expired;
        if cancel && !cancel_sent {
            let value =
                host_image::invoke(host, "cancel", json!({"operationId":operation}), &|| {
                    control.check().is_err() || settling_expired()
                });
            if let Ok(value) = value {
                link = observe(database, operation, value)?;
                cancel_sent = true;
            }
        }
        if let Some(receipt) = link.receipt.clone() {
            match receipt.execution {
                Execution::Succeeded { .. } => match receipt.delivery {
                    Delivery::Available { .. } | Delivery::Acquired { .. } => {
                        let completed = handoff(host, database, &link, control)?;
                        emit_terminal(app, &completed);
                        return Ok(());
                    }
                    Delivery::Discarded {} => {
                        let done = finish(
                            database,
                            operation,
                            "discarded",
                            Some("Provider delivery was explicitly discarded".into()),
                        )?;
                        emit_terminal(app, &done);
                        return Ok(());
                    }
                    Delivery::Unavailable { .. } => {
                        attention(database,operation,"Provider generation succeeded; image delivery is unavailable and can be recovered without generating again")?;
                        progress(app, database, operation);
                        return Ok(());
                    }
                    _ => return Err(invalid("Successful image is missing a delivery state")),
                },
                Execution::Failed { error } => {
                    let done = finish(database, operation, "failed", Some(error.message))?;
                    emit_terminal(app, &done);
                    return Ok(());
                }
                Execution::Cancelled {} => {
                    let done = finish(
                        database,
                        operation,
                        "cancelled",
                        Some("Provider cancelled image generation".into()),
                    )?;
                    emit_terminal(app, &done);
                    return Ok(());
                }
                Execution::Unknown { .. } => {
                    attention(database,operation,"Provider outcome is unknown; inspect this operation instead of retrying generation")?;
                    progress(app, database, operation);
                    return Ok(());
                }
                _ => {}
            }
        }
        if expired {
            expired_polls += 1;
            if expired_polls > polling.settlement || settling_expired() {
                attention(
                    database,
                    operation,
                    "Image deadline expired; cancellation outcome still requires recovery",
                )?;
                progress(app, database, operation);
                return Ok(());
            }
        }
        let value = host_image::invoke(host, "status", json!({"operationId":operation}), &|| {
            control.check().is_err()
                || if expired {
                    settling_expired()
                } else {
                    budget_expired(remaining, monotonic.elapsed(), link.deadline_ms, now_ms())
                }
        });
        match value {
            Ok(value) => {
                link = observe(database, operation, value)?;
                failures = 0;
                progress(app, database, operation)
            }
            Err(AppError::Service { code, .. }) if code == "recovery_stopped" => {
                attention(database,operation,"Automatic recovery was stopped; retained operation requires explicit resolution")?;
                progress(app, database, operation);
                return Ok(());
            }
            Err(_) => {
                failures += 1;
                if failures >= polling.settlement {
                    attention(
                        database,
                        operation,
                        "Image status is unavailable; recovery will inspect the original operation",
                    )?;
                    progress(app, database, operation);
                    return Ok(());
                }
            }
        }
        if !polling.interval.is_zero() {
            std::thread::sleep(polling.interval);
        }
    }
}
struct WorkerLease(String);
impl Drop for WorkerLease {
    fn drop(&mut self) {
        if let Some(workers) = WORKERS.get() {
            workers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.0);
        }
    }
}
fn worker_active(database: &Path, operation: &str) -> bool {
    WORKERS.get().is_some_and(|workers| {
        workers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&format!("{}:{operation}", database.display()))
    })
}
fn own_worker(database: &Path, operation: &str) -> Option<WorkerLease> {
    let key = format!("{}:{operation}", database.display());
    let mut workers = WORKERS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    workers.insert(key.clone()).then_some(WorkerLease(key))
}
fn worker_owned(
    host: Arc<dyn ImageHost>,
    database: PathBuf,
    operation: String,
    fresh: bool,
    control: crate::plugin_job::JobControl,
    app: EventEmitter,
    lease: WorkerLease,
    _job: crate::plugin_job::JobLease,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let _lease = lease;
    if let Err(_error) = run_worker(
        host.as_ref(),
        &database,
        &operation,
        fresh,
        &control,
        &app,
        Polling::default(),
    ) {
        // Keep safe bounded error text. Arbitrary transport errors may contain
        // provider body/path data and never enter Trace provenance or events.
        let _ = attention(
            &database,
            &operation,
            "Image recovery is pending; generation will not be repeated",
        );
        progress(&app, &database, &operation);
    }
}
fn slots() -> Arc<tokio::sync::Semaphore> {
    SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(16)))
        .clone()
}
pub(crate) async fn start(
    app: EventEmitter,
    request: ImageRequest,
    job_id: u64,
    operation_id: String,
    deadline_ms:Option<u64>,
) -> Result<u64, AppError> {
    if !owner_ready() {
        return Err(invalid("Trace is not active"));
    }
    let database = database_path()?;
    let generated = config::config_dir()?.join("generated");
    start_with_deadline(
        Arc::new(NativeHost),
        database,
        generated,
        app,
        request,
        job_id,
        operation_id,
        true,
        deadline_ms.unwrap_or_else(||now_ms().saturating_add(600_000)).min(now_ms().saturating_add(600_000)),
    )
    .await
}
#[cfg(test)]
async fn start_with(host:Arc<dyn ImageHost>,database:PathBuf,generated:PathBuf,app:EventEmitter,request:ImageRequest,job_id:u64,operation_id:String,production:bool)->Result<u64,AppError> {
    start_with_deadline(host,database,generated,app,request,job_id,operation_id,production,now_ms().saturating_add(600_000)).await
}
async fn start_with_deadline(
    host: Arc<dyn ImageHost>,
    database: PathBuf,
    generated: PathBuf,
    app: EventEmitter,
    request: ImageRequest,
    job_id: u64,
    operation_id: String,
    production: bool,
    deadline_ms:u64,
) -> Result<u64, AppError> {
    let permit = tokio::time::timeout(remaining_budget(deadline_ms,now_ms()).min(Duration::from_secs(5)), slots().acquire_owned())
        .await
        .map_err(|_| invalid("Image workers are busy; try again after a job finishes"))?
        .map_err(|_| invalid("Image workers are unavailable"))?;
    tokio::task::spawn_blocking(move || {
        let control = crate::plugin_job::JobControl::new();
        let job = job_owner(control.clone());
        let acceptance = accept_with_deadline(
            host.as_ref(),
            &database,
            &generated,
            request,
            job_id,
            operation_id.clone(),
            &control,
            production,
            deadline_ms,
        )?;
        let accepted_job = acceptance.link.job_id;
        if (!terminal(&acceptance.link.phase) || acceptance.link.preparation_release_pending)
            && (acceptance.fresh || acceptance.link.phase != "accepted")
        {
            if let Some(lease) = own_worker(&database, &operation_id) {
                std::thread::Builder::new()
                    .name("trace-image-consumer".into())
                    .spawn(move || {
                        worker_owned(
                            host,
                            database,
                            operation_id,
                            acceptance.fresh,
                            control,
                            app,
                            lease,
                            job,
                            permit,
                        )
                    })?;
            }
        }
        Ok(accepted_job)
    })
    .await
    .map_err(|_| invalid("Image admission worker stopped; inspect the original operation"))?
}
pub(crate) fn resume(app: EventEmitter) -> Result<(), AppError> {
    let database = database_path()?;
    let links = links_at(&connection_at(&database)?)?;
    let recovering: Vec<_> = links
        .into_iter()
        .filter(|l| !terminal(&l.phase) || l.preparation_release_pending)
        .collect();
    if recovering.len() > MAX_LIVE {
        return Err(invalid(
            "Too many retained image operations; resolve existing recovery first",
        ));
    }
    for link in recovering {
        let Some(lease) = own_worker(&database, &link.operation_id) else {
            continue;
        };
        let database = database.clone();
        let app = app.clone();
        let control = crate::plugin_job::JobControl::new();
        let job = job_owner(control.clone());
        tokio::spawn(async move {
            let permit =
                match tokio::time::timeout(Duration::from_secs(5), slots().acquire_owned()).await {
                    Ok(Ok(permit)) => permit,
                    _ => {
                        let _ = tokio::task::spawn_blocking(move || {
                            let _ownership = (lease, job);
                            let _ = attention(
                                &database,
                                &link.operation_id,
                                "Image recovery worker is queued; restart or inspect to continue",
                            );
                            progress(&app, &database, &link.operation_id);
                        })
                        .await;
                        return;
                    }
                };
            let host: Arc<dyn ImageHost> = Arc::new(NativeHost);
            let _ = tokio::task::spawn_blocking(move || {
                worker_owned(
                    host,
                    database,
                    link.operation_id,
                    false,
                    control,
                    app,
                    lease,
                    job,
                    permit,
                )
            })
            .await;
        });
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    const PNG: &[u8] = include_bytes!("../../test_support/fixtures/source32.png");
    #[derive(Default)]
    struct Behavior {
        lost_start: bool,
        lost_acquired: bool,
        lost_ack: bool,
        unavailable: bool,
        unknown: bool,
        failed: bool,
        malformed: bool,
        read_substitution: bool,
        discarded: bool,
        lost_release: bool,
        running: bool,
        stop_recovery: bool,
    }
    #[derive(Default)]
    struct IoGate {
        state: Mutex<(usize, usize, usize, bool)>,
        changed: std::sync::Condvar,
    }
    impl IoGate {
        fn enter(&self) {
            let mut state = self.state.lock().unwrap();
            state.0 += 1;
            state.1 += 1;
            state.2 = state.2.max(state.1);
            self.changed.notify_all();
            while !state.3 {
                state = self.changed.wait(state).unwrap();
            }
            state.1 -= 1;
        }
        fn wait_for(&self, count: usize) {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut state = self.state.lock().unwrap();
            while state.0 < count {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(!remaining.is_zero(), "IO fixture did not enter");
                state = self.changed.wait_timeout(state, remaining).unwrap().0;
            }
        }
        fn release(&self) {
            let mut state = self.state.lock().unwrap();
            state.3 = true;
            self.changed.notify_all();
        }
        fn peak(&self) -> usize {
            self.state.lock().unwrap().2
        }
    }
    struct Fake {
        calls: Mutex<Vec<String>>,
        state: Mutex<Option<OperationStatus>>,
        states: Mutex<std::collections::HashMap<String, OperationStatus>>,
        behavior: Mutex<Behavior>,
        output: ArtifactDescriptor,
        path: PathBuf,
        database: PathBuf,
        proof: Mutex<Option<String>>,
        prepare_gate: Mutex<Option<Arc<std::sync::Barrier>>>,
        dimensions: (u32, u32),
        read_gate: Mutex<Option<Arc<IoGate>>>,
        prepared_recipe: Mutex<Option<EffectiveRecipe>>,
    }
    impl Fake {
        fn new(root: &Path, database: &Path) -> Self {
            let path = root.join("sealed.png");
            fs::write(&path, PNG).unwrap();
            Self {
                calls: Mutex::new(vec![]),
                state: Mutex::new(None),
                states: Mutex::new(std::collections::HashMap::new()),
                behavior: Mutex::new(Behavior::default()),
                output: ArtifactDescriptor {
                    handle: "sealed-output".into(),
                    sha256: hex::encode(Sha256::digest(PNG)),
                    byte_length: PNG.len() as u64,
                    media_type: "image/png".into(),
                },
                path,
                database: database.into(),
                proof: Mutex::new(None),
                prepare_gate: Mutex::new(None),
                dimensions: (32, 32),
                read_gate: Mutex::new(None),
                prepared_recipe: Mutex::new(None),
            }
        }
        fn count(&self, method: &str) -> usize {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|s| s.as_str() == method)
                .count()
        }
        fn recipe(p: &PrepareRequest) -> EffectiveRecipe {
            EffectiveRecipe {
                schema_version: 1,
                formatter_version: 1,
                connection_id: p.connection_id.clone(),
                connection_revision: p.expected_connection_revision.clone(),
                adapter: "openai-images".into(),
                endpoint_identity: "https://example.invalid/v1".into(),
                model: p.model.clone(),
                options: p.options.clone(),
                input_digests: p.inputs.iter().map(|d| d.sha256.clone()).collect(),
                input_roles: (1..=p.inputs.len()).map(|i| format!("image_{i}")).collect(),
                submitted_prompt: p.prompt.clone(),
                agent_task: None,
            }
        }
        fn restore(&self) {
            let mut state = self.state.lock().unwrap();
            let r = state.as_mut().unwrap();
            r.revision += 1;
            r.delivery = Delivery::Available {
                output: self.output.clone(),
            };
            self.states
                .lock()
                .unwrap()
                .insert(r.operation_id.clone(), r.clone());
        }
    }
    impl ImageHost for Fake {
        fn call(
            &self,
            method: &str,
            params: Value,
            _: &dyn Fn() -> bool,
        ) -> Result<Value, AppError> {
            let action = if method == "host.services.invoke" {
                params["method"].as_str().unwrap().to_string()
            } else {
                method.to_string()
            };
            self.calls.lock().unwrap().push(action.clone());
            let p = if method == "host.services.invoke" {
                &params["params"]
            } else {
                &params
            };
            match action.as_str() {
                "host.services.describe" => {
                    Ok(json!({"version":1,"available":true,"providerDigest":"b".repeat(64)}))
                }
                "describe" => Ok(json!({"version":1,"configurationRevision":1,"profiles":[]})),
                "host.artifacts.capture" => {
                    let values=p["inputs"].as_array().unwrap().iter().map(|i|json!({"sourcePath":i["path"],"artifact":ArtifactDescriptor{handle:"captured-input".into(),sha256:self.output.sha256.clone(),byte_length:self.output.byte_length,media_type:"image/png".into()},"width":self.dimensions.0,"height":self.dimensions.1})).collect::<Vec<_>>();
                    Ok(json!({"inputs":values}))
                }
                "prepare" => {
                    let gate = self.prepare_gate.lock().unwrap().clone();
                    if let Some(gate) = gate {
                        gate.wait();
                        gate.wait();
                    }
                    let request: PrepareRequest = serde_json::from_value(p.clone()).unwrap();
                    let recipe = self
                        .prepared_recipe
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or_else(|| Self::recipe(&request));
                    Ok(
                        json!({"preparationToken":"token-fixture","effectiveRecipeDigest":recipe.digest(),"effectiveRecipe":recipe}),
                    )
                }
                "start" => {
                    let request: StartRequest = serde_json::from_value(p.clone()).unwrap();
                    let link = read_link(&self.database, &request.operation_id)?.unwrap();
                    assert_eq!(link.phase, "forwarding");
                    assert_eq!(
                        link.prepared.effective_recipe_digest,
                        request.effective_recipe_digest
                    );
                    let behavior = self.behavior.lock().unwrap();
                    let error = te_image_generation_contract::SafeError {
                        code: "fixture".into(),
                        message: "Fixture provider outcome".into(),
                        correlation_id: None,
                    };
                    let execution = if behavior.unknown {
                        Execution::Unknown {
                            error: error.clone(),
                        }
                    } else if behavior.failed {
                        Execution::Failed { error }
                    } else if behavior.running {
                        Execution::Running {}
                    } else {
                        Execution::Succeeded {
                            metadata: te_image_generation_contract::ImageMetadata {
                                adapter: link.recipe.adapter.clone(),
                                endpoint_identity: link.recipe.endpoint_identity.clone(),
                                requested_model: link.recipe.model.clone(),
                                actual_model: link.recipe.model.clone(),
                                external_request_id: Some("fixture-remote".into()),
                                thread_id: None,
                                options: link.recipe.options.clone(),
                                remote_charge_uncertain: false,
                            },
                        }
                    };
                    let delivery = if behavior.unknown || behavior.failed || behavior.running {
                        Delivery::None {}
                    } else if behavior.discarded {
                        Delivery::Discarded {}
                    } else if behavior.unavailable {
                        Delivery::Unavailable {
                            reason: "Fixture temporarily lost output".into(),
                        }
                    } else {
                        Delivery::Available {
                            output: self.output.clone(),
                        }
                    };
                    let receipt = OperationStatus {
                        version: 1,
                        operation_id: request.operation_id,
                        request_fingerprint: request.effective_recipe_digest,
                        provider: te_image_generation_contract::ProviderIdentity {
                            package_id: host_image::PACKAGE.into(),
                            service_id: host_image::SERVICE.into(),
                            major: 1,
                        },
                        revision: 1,
                        diagnostics: None,
                        execution,
                        delivery,
                    };
                    self.states
                        .lock()
                        .unwrap()
                        .insert(receipt.operation_id.clone(), receipt.clone());
                    *self.state.lock().unwrap() = Some(receipt.clone());
                    if behavior.lost_start {
                        return Err(invalid("Fixture start reply lost"));
                    }
                    if behavior.malformed {
                        return Ok(json!({"version":1,"execution":{"state":"succeeded"}}));
                    }
                    Ok(serde_json::to_value(receipt).unwrap())
                }
                "status" | "cancel" => {
                    let behavior = self.behavior.lock().unwrap();
                    if action == "status" && behavior.stop_recovery {
                        return Err(AppError::Service {
                            code: "recovery_stopped".into(),
                            message: "Fixture recovery stopped".into(),
                        });
                    }
                    let mut states = self.states.lock().unwrap();
                    let receipt = states
                        .get_mut(p["operationId"].as_str().unwrap())
                        .ok_or_else(|| invalid("Fixture operation not found"))?;
                    if action == "cancel"
                        && matches!(receipt.execution, Execution::Accepted {} | Execution::Running {})
                    {
                        receipt.revision += 1;
                        receipt.execution = Execution::Cancelled {};
                        receipt.delivery = Delivery::None {};
                    }
                    let receipt = receipt.clone();
                    *self.state.lock().unwrap() = Some(receipt.clone());
                    Ok(serde_json::to_value(receipt).unwrap())
                }
                "host.artifacts.read" => {
                    let gate = self.read_gate.lock().unwrap().clone();
                    if let Some(gate) = gate {
                        gate.enter();
                    }
                    let d: ArtifactDescriptor =
                        serde_json::from_value(p["artifact"].clone()).unwrap();
                    assert_eq!(d, self.output);
                    let mut returned = d;
                    if self.behavior.lock().unwrap().read_substitution {
                        returned.sha256 = "f".repeat(64);
                    }
                    Ok(json!({"path":self.path,"artifact":returned}))
                }
                "host.artifacts.acquired" => {
                    let target = Path::new(p["evidencePath"].as_str().unwrap());
                    assert_eq!(fs::read(target).unwrap(), fs::read(&self.path).unwrap());
                    let proof = format!("proof-{}", p["operationId"].as_str().unwrap());
                    *self.proof.lock().unwrap() = Some(proof.clone());
                    let mut behavior = self.behavior.lock().unwrap();
                    if behavior.lost_acquired {
                        behavior.lost_acquired = false;
                        return Err(invalid("Fixture acquisition reply lost"));
                    }
                    Ok(json!({"transferReceipt":proof}))
                }
                "acknowledge" => {
                    let link =
                        read_link(&self.database, p["operationId"].as_str().unwrap())?.unwrap();
                    assert!(link.transfer_receipt.is_some());
                    assert_eq!(link.transfer_receipt, *self.proof.lock().unwrap());
                    assert_eq!(p["transferReceipt"], json!(link.transfer_receipt));
                    let mut state = self.state.lock().unwrap();
                    let receipt = state.as_mut().unwrap();
                    receipt.revision += 1;
                    receipt.delivery = Delivery::Acquired {
                        transfer_receipt: link.transfer_receipt.unwrap(),
                    };
                    self.states
                        .lock()
                        .unwrap()
                        .insert(receipt.operation_id.clone(), receipt.clone());
                    let mut behavior = self.behavior.lock().unwrap();
                    if behavior.lost_ack {
                        behavior.lost_ack = false;
                        return Err(invalid("Fixture acknowledgement reply lost"));
                    }
                    Ok(serde_json::to_value(receipt).unwrap())
                }
                "host.artifacts.release" => {
                    let mut b = self.behavior.lock().unwrap();
                    if b.lost_release {
                        b.lost_release = false;
                        return Err(invalid("Fixture preparation cleanup reply lost"));
                    }
                    Ok(json!({"released":true}))
                }
                _ => panic!("Unexpected fake host call {action}"),
            }
        }
    }
    fn request() -> ImageRequest {
        serde_json::from_value(json!({"connectionId":"fixture","expectedConnectionRevision":"recipe-1","model":"arbitrary-image-model","sourcePath":null,"prompt":"Draw a landscape","outputDir":"/Pictures","outputFilename":"ignored-user-hint.png","size":"1024x1024","quality":"auto","background":"auto"})).unwrap()
    }
    struct Fixture {
        _root: tempfile::TempDir,
        database: PathBuf,
        generated: PathBuf,
        host: Arc<Fake>,
        events: Arc<Mutex<Vec<(String, Value)>>>,
        app: EventEmitter,
    }
    impl Fixture {
        fn new() -> Self {
            let root = crate::test_support::tempdir().unwrap();
            let database = root.path().join("trace.sqlite");
            let generated = root.path().join("generated");
            connection_at(&database).unwrap();
            let host = Arc::new(Fake::new(root.path(), &database));
            let events = Arc::new(Mutex::new(vec![]));
            let sink = events.clone();
            let app = EventEmitter::isolated(move |name, value| {
                sink.lock().unwrap().push((name.into(), value));
                Ok(())
            });
            Self {
                _root: root,
                database,
                generated,
                host,
                events,
                app,
            }
        }
        fn accept(&self, op: &str) -> Link {
            accept_with(
                self.host.as_ref(),
                &self.database,
                &self.generated,
                request(),
                9,
                op.into(),
                &crate::plugin_job::JobControl::new(),
                false,
            )
            .unwrap()
            .link
        }
        fn run(&self, op: &str, fresh: bool) {
            if run_worker(
                self.host.as_ref(),
                &self.database,
                op,
                fresh,
                &crate::plugin_job::JobControl::new(),
                &self.app,
                Polling {
                    interval: Duration::ZERO,
                    settlement: 2,
                },
            )
            .is_err()
            {
                attention(&self.database, op, "Fixture recovery pending").unwrap();
            }
        }
        fn snapshot(&self, op: &str) -> Value {
            snapshot_at(&self.database, op).unwrap().unwrap()
        }
    }
    const OP: &str = "11111111111111111111111111111111";
    #[test]
    fn sealed_png_is_adopted_and_acquired_before_provider_acknowledgement() {
        let f = Fixture::new();
        let link = f.accept(OP);
        f.run(OP, true);
        let state = f.snapshot(OP);
        assert_eq!(state["status"], "succeeded");
        assert_eq!(state["recoveryState"], "succeeded");
        assert_eq!(fs::read(&link.target).unwrap(), PNG);
        let calls = f.host.calls.lock().unwrap();
        let acquired = calls
            .iter()
            .position(|c| c == "host.artifacts.acquired")
            .unwrap();
        let ack = calls.iter().position(|c| c == "acknowledge").unwrap();
        assert!(acquired < ack);
        drop(calls);
        assert_eq!(f.host.count("start"), 1);
        assert!(f
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(name, value)| name == "openai-image-complete"
                && value["outputPath"] == json!(link.target)));
        let count: i64 = connection_at(&f.database)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM artifacts WHERE generating_run=?1",
                [link.run_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    fn lost_start_reply_is_reconciled_without_another_paid_start() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().lost_start = true;
        f.accept(OP);
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "succeeded");
        assert_eq!(f.host.count("start"), 1);
        assert!(f.host.count("status") >= 1);
        f.run(OP, false);
        assert_eq!(f.host.count("start"), 1);
    }
    #[test]
    fn forwarding_survives_reopen_and_only_inspects_original_operation() {
        let f = Fixture::new();
        f.accept(OP);
        claim_dispatch(&f.database, OP, true).unwrap();
        drop(connection_at(&f.database).unwrap());
        f.run(OP, false);
        assert_eq!(f.host.count("start"), 0);
        assert_eq!(f.host.count("status"), 3);
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
        assert_eq!(f.snapshot(OP)["recoveryState"], "needs_attention");
    }
    #[test]
    fn provider_success_unavailable_restores_delivery_without_paid_replay() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().unavailable = true;
        let link = f.accept(OP);
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
        assert_eq!(f.snapshot(OP)["providerExecution"]["state"], "succeeded");
        assert!(!link.target.exists());
        assert!(!f
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(n, _)| n == "openai-image-error"));
        f.host.restore();
        f.run(OP, false);
        assert_eq!(f.snapshot(OP)["status"], "succeeded");
        assert_eq!(fs::read(link.target).unwrap(), PNG);
        assert_eq!(f.host.count("start"), 1);
    }
    #[test]
    fn lost_acquisition_reply_recovers_exact_publication_without_recopied_bytes() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().lost_acquired = true;
        let link = f.accept(OP);
        f.run(OP, true);
        let identity = crate::files::trace_file_identity(&link.target).unwrap();
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
        assert_eq!(f.host.count("acknowledge"), 0);
        f.run(OP, false);
        assert_eq!(f.snapshot(OP)["status"], "succeeded");
        assert_eq!(
            crate::files::trace_file_identity(&link.target).unwrap(),
            identity
        );
        assert_eq!(f.host.count("host.artifacts.read"), 1);
        assert_eq!(f.host.count("host.artifacts.acquired"), 2);
        assert_eq!(f.host.count("start"), 1);
    }
    #[test]
    fn lost_ack_reply_recovers_committed_provider_acquisition_without_copy_or_replay() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().lost_ack = true;
        f.accept(OP);
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
        f.run(OP, false);
        assert_eq!(f.snapshot(OP)["status"], "succeeded");
        assert_eq!(f.host.count("start"), 1);
        assert_eq!(f.host.count("host.artifacts.read"), 1);
        assert_eq!(f.host.count("host.artifacts.acquired"), 1);
        assert_eq!(f.host.count("acknowledge"), 1);
    }
    #[test]
    fn unknown_or_malformed_provider_outcome_is_never_retryable_failure() {
        for malformed in [false, true] {
            let f = Fixture::new();
            {
                let mut b = f.host.behavior.lock().unwrap();
                b.malformed = malformed;
                b.unknown = !malformed;
            }
            f.accept(OP);
            f.run(OP, true);
            assert_eq!(f.snapshot(OP)["status"], "uncertain");
            assert_eq!(f.host.count("start"), 1);
            assert!(!f
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|(n, _)| n == "openai-image-error"));
        }
    }
    #[test]
    fn authoritative_failure_is_terminal_and_emits_the_provider_error() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().failed = true;
        f.accept(OP);
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "failed");
        assert_eq!(f.snapshot(OP)["error"], "Fixture provider outcome");
        assert!(f
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(n, _)| n == "openai-image-error"));
    }
    #[test]
    fn local_cancel_before_forwarding_permits_no_remote_start() {
        let f = Fixture::new();
        f.accept(OP);
        cancel_at(&f.database, OP).unwrap();
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "cancelled");
        assert_eq!(f.host.count("start"), 0);
        assert_eq!(f.host.count("cancel"), 0);
        assert_eq!(f.host.count("host.artifacts.release"), 1);
    }
    #[test]
    fn preaccept_cancel_and_changed_same_id_request_perform_no_new_provider_work() {
        let f = Fixture::new();
        cancel_at(&f.database, OP).unwrap();
        assert!(accept_with(
            f.host.as_ref(),
            &f.database,
            &f.generated,
            request(),
            9,
            OP.into(),
            &crate::plugin_job::JobControl::new(),
            false
        )
        .is_err());
        assert_eq!(f.host.calls.lock().unwrap().len(), 0);
        let other = "22222222222222222222222222222222";
        f.accept(other);
        let calls = f.host.calls.lock().unwrap().len();
        let mut changed = request();
        changed.prompt = "Changed intent".into();
        assert!(accept_with(
            f.host.as_ref(),
            &f.database,
            &f.generated,
            changed,
            9,
            other.into(),
            &crate::plugin_job::JobControl::new(),
            false
        )
        .is_err());
        assert_eq!(f.host.calls.lock().unwrap().len(), calls);
    }
    #[test]
    fn wrong_sealed_descriptor_preserves_success_without_local_publication_or_ack() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().read_substitution = true;
        let link = f.accept(OP);
        f.run(OP, true);
        assert!(!link.target.exists());
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
        assert_eq!(f.snapshot(OP)["providerExecution"]["state"], "succeeded");
        assert_eq!(f.host.count("acknowledge"), 0);
    }
    #[test]
    fn missing_initialized_schema_and_future_marker_fail_closed() {
        let f = Fixture::new();
        f.accept(OP);
        let connection = Connection::open(&f.database).unwrap();
        connection
            .execute("DROP TABLE image_service_operations", [])
            .unwrap();
        assert!(connection_at(&f.database).is_err());
        let g = Fixture::new();
        Connection::open(&g.database)
            .unwrap()
            .execute("UPDATE image_service_schema SET version=2", [])
            .unwrap();
        assert!(connection_at(&g.database).is_err());
    }
    #[test]
    fn lost_local_completion_checkpoint_reuses_one_trace_artifact() {
        let f = Fixture::new();
        let link = f.accept(OP);
        f.run(OP, true);
        update(&f.database, OP, |_, l| {
            l.phase = "ack_pending".into();
            Ok(())
        })
        .unwrap();
        f.run(OP, false);
        assert_eq!(f.snapshot(OP)["status"], "succeeded");
        let count: i64 = connection_at(&f.database)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM artifacts WHERE generating_run=?1",
                [link.run_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(f.host.count("start"), 1);
    }
    #[test]
    fn retained_unpublished_anchor_recovers_the_original_inode_without_new_read() {
        let f = Fixture::new();
        let link = f.accept(OP);
        claim_dispatch(&f.database, OP, true).unwrap();
        let receipt = f
            .host
            .call(
                "host.services.invoke",
                json!({"method":"start","params":link.prepared}),
                &|| false,
            )
            .unwrap();
        let link = observe(&f.database, OP, receipt).unwrap();
        let mut stage = crate::files::publication::StagedEntry::prepare(
            link.target.parent().unwrap(),
            |payload| {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(payload)?;
                file.write_all(PNG)?;
                file.sync_all()?;
                Ok(())
            },
        )
        .unwrap();
        let anchor = stage.trace_anchor().unwrap();
        let original = crate::files::trace_file_identity(&anchor).unwrap();
        prepare_operation_output(
            &TraceRunHandle {
                database: f.database.clone(),
                id: link.run_id,
            },
            &link.target,
            &f.host.output.sha256,
            Some(&anchor),
        )
        .unwrap();
        stage.retain_trace_anchor();
        drop(stage);
        f.run(OP, false);
        assert_eq!(f.snapshot(OP)["status"], "succeeded");
        assert_eq!(
            crate::files::trace_file_identity(&link.target).unwrap(),
            original
        );
        assert_eq!(f.host.count("host.artifacts.read"), 0);
        assert_eq!(f.host.count("start"), 1);
    }
    #[test]
    fn racing_occupied_publication_is_never_replaced_or_attributed() {
        let f = Fixture::new();
        let link = f.accept(OP);
        fs::write(&link.target, b"unrelated user file").unwrap();
        f.run(OP, true);
        assert_eq!(fs::read(&link.target).unwrap(), b"unrelated user file");
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
        assert_eq!(f.host.count("host.artifacts.acquired"), 0);
        assert_eq!(f.host.count("acknowledge"), 0);
    }
    #[test]
    fn provider_metadata_is_durable_and_receipt_revisions_never_regress() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().unavailable = true;
        let link = f.accept(OP);
        f.run(OP, true);
        let original = read_link(&f.database, OP).unwrap().unwrap();
        let mut wrong = original.receipt.clone().unwrap();
        wrong.request_fingerprint = "f".repeat(64);
        assert!(observe(&f.database, OP, serde_json::to_value(wrong).unwrap()).is_err());
        let details: String = connection_at(&f.database)
            .unwrap()
            .query_row(
                "SELECT result_details FROM runs WHERE id=?1",
                [link.run_id],
                |r| r.get(0),
            )
            .unwrap();
        let details: Value = parse(&details).unwrap();
        assert_eq!(details["provider_execution"]["state"], "succeeded");
        assert_eq!(
            details["provider_execution"]["metadata"]["externalRequestId"],
            "fixture-remote"
        );
        f.host.restore();
        let newer = f.host.state.lock().unwrap().clone().unwrap();
        let current = observe(
            &f.database,
            OP,
            serde_json::to_value(newer.clone()).unwrap(),
        )
        .unwrap();
        let lower = observe(
            &f.database,
            OP,
            serde_json::to_value(original.receipt.unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(lower.receipt, Some(newer));
        assert_eq!(current.revision, lower.revision);
        let mut raw = serde_json::to_value(lower.receipt.unwrap()).unwrap();
        raw["execution"]["apiKey"] = "never-log-this".into();
        assert!(observe(&f.database, OP, raw).is_err());
    }
    #[test]
    fn ordered_capture_digests_and_dimensions_are_pinned_before_acceptance() {
        let f = Fixture::new();
        let mut r = request();
        r.source_path = Some(f.host.path.to_string_lossy().into());
        r.expected_source_digest = Some("f".repeat(64));
        assert!(accept_with(
            f.host.as_ref(),
            &f.database,
            &f.generated,
            r,
            9,
            OP.into(),
            &crate::plugin_job::JobControl::new(),
            false
        )
        .is_err());
        assert_eq!(f.host.count("prepare"), 0);
        assert_eq!(f.host.count("start"), 0);
        assert!(read_link(&f.database, OP).unwrap().is_none());
        let mut r = request();
        r.source_path = Some(f.host.path.to_string_lossy().into());
        r.expected_source_digest = Some(f.host.output.sha256.clone());
        let link = accept_with(
            f.host.as_ref(),
            &f.database,
            &f.generated,
            r,
            9,
            OP.into(),
            &crate::plugin_job::JobControl::new(),
            false,
        )
        .unwrap()
        .link;
        assert_eq!(link.captured[0].artifact.sha256, f.host.output.sha256);
        assert_eq!(
            link.recipe.input_digests,
            vec![f.host.output.sha256.clone()]
        );
    }
    #[test]
    fn cancel_and_forwarding_have_one_durable_winner() {
        for n in 0..12 {
            let f = Fixture::new();
            let op = format!("{n:032x}");
            f.accept(&op);
            let gate = Arc::new(std::sync::Barrier::new(2));
            let other = gate.clone();
            let db = f.database.clone();
            let id = op.clone();
            let canceller = std::thread::spawn(move || {
                other.wait();
                cancel_at(&db, &id).unwrap();
            });
            gate.wait();
            let (link, claimed) = claim_dispatch(&f.database, &op, true).unwrap();
            canceller.join().unwrap();
            assert_ne!(claimed, link.phase == "cancelled");
            assert_eq!(f.host.count("start"), 0);
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropping_the_reply_future_keeps_owned_admission_and_worker_alive() {
        let f = Fixture::new();
        let gate = Arc::new(std::sync::Barrier::new(2));
        *f.host.prepare_gate.lock().unwrap() = Some(gate.clone());
        let host: Arc<dyn ImageHost> = f.host.clone();
        let future = tokio::spawn(start_with(
            host,
            f.database.clone(),
            f.generated.clone(),
            f.app.clone(),
            request(),
            9,
            OP.into(),
            false,
        ));
        let entered = gate.clone();
        tokio::task::spawn_blocking(move || entered.wait())
            .await
            .unwrap();
        future.abort();
        assert!(future.await.unwrap_err().is_cancelled());
        tokio::task::spawn_blocking(move || gate.wait())
            .await
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if snapshot_at(&f.database, OP)
                .unwrap()
                .is_some_and(|s| s["status"] == "succeeded")
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Owned worker stopped after caller future drop"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(f.host.count("start"), 1);
        assert_eq!(f.host.count("acknowledge"), 1);
    }
    #[cfg(unix)]
    #[test]
    fn special_files_and_symlink_ancestors_are_rejected_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let fifo = f._root.path().join("input-fifo");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(regular(&fifo).is_err());
        let alias = f._root.path().join("alias");
        symlink(f._root.path(), &alias).unwrap();
        assert!(regular(&alias.join("sealed.png")).is_err());
    }
    #[test]
    fn explicit_provider_discard_is_truthful_without_a_local_artifact() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().discarded = true;
        let link = f.accept(OP);
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "discarded");
        assert!(!link.target.exists());
        assert_eq!(f.host.count("host.artifacts.read"), 0);
        assert_eq!(f.host.count("host.artifacts.acquired"), 0);
        assert_eq!(f.host.count("start"), 1);
        let count: i64 = connection_at(&f.database)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM artifacts WHERE generating_run=?1",
                [link.run_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
    #[test]
    fn invalid_png_and_large_sparse_output_remain_successful_provider_recovery_not_failed() {
        for sparse in [false, true] {
            let mut f = Fixture::new();
            if sparse {
                OpenOptions::new()
                    .write(true)
                    .open(&f.host.path)
                    .unwrap()
                    .set_len(MAX_OUTPUT + 1)
                    .unwrap();
            } else {
                let fake = Arc::get_mut(&mut f.host).unwrap();
                fs::write(&fake.path, b"not-a-png").unwrap();
                fake.output.byte_length = 9;
                fake.output.sha256 = hex::encode(Sha256::digest(b"not-a-png"));
            }
            let link = f.accept(OP);
            f.run(OP, true);
            assert_eq!(f.snapshot(OP)["status"], "uncertain");
            assert_eq!(f.snapshot(OP)["providerExecution"]["state"], "succeeded");
            assert!(!link.target.exists());
            assert_eq!(f.host.count("acknowledge"), 0);
            assert_eq!(f.host.count("start"), 1);
        }
    }
    #[test]
    fn immutable_unknown_provider_execution_cannot_be_relabelled_failure() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().unknown = true;
        f.accept(OP);
        f.run(OP, true);
        let mut receipt = read_link(&f.database, OP)
            .unwrap()
            .unwrap()
            .receipt
            .unwrap();
        receipt.revision += 1;
        receipt.execution = Execution::Failed {
            error: te_image_generation_contract::SafeError {
                code: "rewritten".into(),
                message: "Would permit a paid retry".into(),
                correlation_id: None,
            },
        };
        assert!(observe(&f.database, OP, serde_json::to_value(receipt).unwrap()).is_err());
        assert_eq!(f.snapshot(OP)["providerExecution"]["state"], "unknown");
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
    }
    #[test]
    fn local_cancel_cleanup_failure_is_retained_and_retried_without_dispatch() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().lost_release = true;
        f.accept(OP);
        cancel_at(&f.database, OP).unwrap();
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "cancelled");
        assert!(
            read_link(&f.database, OP)
                .unwrap()
                .unwrap()
                .preparation_release_pending
        );
        f.run(OP, false);
        assert!(
            !read_link(&f.database, OP)
                .unwrap()
                .unwrap()
                .preparation_release_pending
        );
        assert_eq!(f.host.count("host.artifacts.release"), 2);
        assert_eq!(f.host.count("start"), 0);
        assert_eq!(f.host.count("status"), 0);
    }
    #[test]
    fn initialized_missing_database_is_not_recreated_and_missing_core_table_is_not_healed() {
        let f = Fixture::new();
        f.accept(OP);
        assert_eq!(
            fs::read(f.database.with_file_name(".image-service-initialized")).unwrap(),
            b"TEIC1\n"
        );
        fs::remove_file(&f.database).unwrap();
        assert!(connection_at(&f.database).is_err());
        assert!(!f.database.exists());
        let g = Fixture::new();
        g.accept(OP);
        let c = Connection::open(&g.database).unwrap();
        c.execute("DROP TABLE image_jobs", []).unwrap();
        drop(c);
        assert!(connection_at(&g.database).is_err());
        let exists:bool=Connection::open(&g.database).unwrap().query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='image_jobs')",[],|r|r.get(0)).unwrap();
        assert!(!exists, "Missing initialized job ownership was healed");
        let h=Fixture::new();h.accept(OP);
        let c=Connection::open(&h.database).unwrap();
        c.execute_batch("DROP TABLE image_service_operations;DROP TABLE image_service_cancellations;DROP TABLE image_service_schema;PRAGMA application_id=0;").unwrap();drop(c);
        assert!(connection_at(&h.database).is_err());
        let count:i64=Connection::open(&h.database).unwrap().query_row("SELECT count(*) FROM sqlite_schema WHERE name='image_service_operations'",[],|r|r.get(0)).unwrap();assert_eq!(count,0);
    }
    #[test]
    fn host_deadline_includes_held_prepare_and_prevents_local_acceptance_or_paid_start() {
        let f=Fixture::new();let gate=Arc::new(std::sync::Barrier::new(2));*f.host.prepare_gate.lock().unwrap()=Some(gate.clone());
        let host=f.host.clone();let database=f.database.clone();let generated=f.generated.clone();
        let deadline=now_ms().saturating_add(5_000);
        let worker=std::thread::spawn(move||accept_with_deadline(host.as_ref(),&database,&generated,request(),9,OP.into(),&crate::plugin_job::JobControl::new(),false,deadline));
        gate.wait();while now_ms()<=deadline {std::thread::sleep(Duration::from_millis(5));}gate.wait();
        assert!(matches!(worker.join().unwrap(),Err(AppError::Service{ref code,..}) if code=="timed_out"));
        assert!(read_link(&f.database,OP).unwrap().is_none());assert_eq!(f.host.count("start"),0);assert_eq!(f.host.count("host.artifacts.release"),1);
    }
    #[test]
    fn admission_keeps_the_original_host_deadline_instead_of_renewing_after_prepare() {
        let f=Fixture::new();let deadline=now_ms().saturating_add(100_000);
        let accepted=accept_with_deadline(f.host.as_ref(),&f.database,&f.generated,request(),9,OP.into(),&crate::plugin_job::JobControl::new(),false,deadline).unwrap();
        assert_eq!(accepted.link.deadline_ms,deadline);assert_eq!(read_link(&f.database,OP).unwrap().unwrap().deadline_ms,deadline);assert_eq!(f.host.count("start"),0);
    }
    fn genuine_png_fixture(width: u32, height: u32) -> Fixture {
        let mut f = Fixture::new();
        let fake = Arc::get_mut(&mut f.host).unwrap();
        image::RgbImage::new(width, height)
            .save_with_format(&fake.path, image::ImageFormat::Png)
            .unwrap();
        let bytes = fs::read(&fake.path).unwrap();
        fake.output.sha256 = hex::encode(Sha256::digest(&bytes));
        fake.output.byte_length = bytes.len() as u64;
        fake.dimensions = (width, height);
        f
    }
    #[test]
    fn genuine_four_k_png_capture_and_sealed_handoff_use_the_shared_pixel_boundary() {
        let f = genuine_png_fixture(4096, 4096);
        let mut request = request();
        request.source_path = Some(f.host.path.to_string_lossy().into());
        request.expected_source_digest = Some(f.host.output.sha256.clone());
        let link = accept_with(
            f.host.as_ref(),
            &f.database,
            &f.generated,
            request,
            9,
            OP.into(),
            &crate::plugin_job::JobControl::new(),
            false,
        )
        .unwrap()
        .link;
        assert_eq!(
            (link.captured[0].width, link.captured[0].height),
            (4096, 4096)
        );
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "succeeded");
        assert_eq!(
            image::ImageReader::open(&link.target)
                .unwrap()
                .into_dimensions()
                .unwrap(),
            (4096, 4096)
        );
        assert_eq!(
            fs::read(&link.target).unwrap(),
            fs::read(&f.host.path).unwrap()
        );
        assert_eq!(f.host.count("start"), 1);
        assert_eq!(f.host.count("acknowledge"), 1);
    }
    #[test]
    fn genuine_png_one_row_over_pixel_cap_rejects_capture_before_dispatch_and_output_before_acquisition(
    ) {
        let f = genuine_png_fixture(4096, 4097);
        let mut request = request();
        request.source_path = Some(f.host.path.to_string_lossy().into());
        assert!(accept_with(
            f.host.as_ref(),
            &f.database,
            &f.generated,
            request,
            9,
            OP.into(),
            &crate::plugin_job::JobControl::new(),
            false
        )
        .is_err());
        assert_eq!(f.host.count("start"), 0);
        assert_eq!(f.host.count("prepare"), 0);
        assert!(read_link(&f.database, OP).unwrap().is_none());
        let link = f.accept(OP);
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
        assert_eq!(f.snapshot(OP)["providerExecution"]["state"], "succeeded");
        assert!(!link.target.exists());
        assert_eq!(f.host.count("host.artifacts.acquired"), 0);
        assert_eq!(f.host.count("acknowledge"), 0);
    }
    #[test]
    fn legal_wide_png_has_no_additional_edge_cap_beyond_the_shared_pixel_budget() {
        let f = genuine_png_fixture(16_384, 1024);
        let link = f.accept(OP);
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "succeeded");
        assert_eq!(
            image::ImageReader::open(&link.target)
                .unwrap()
                .into_dimensions()
                .unwrap(),
            (16_384, 1024)
        );
        assert_eq!(f.host.count("start"), 1);
    }
    #[test]
    fn malformed_journal_target_is_rejected_before_recovery_io_or_outside_publication() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().unavailable = true;
        f.accept(OP);
        f.run(OP, true);
        let outside = f._root.path().join("outside-managed-storage.png");
        let c = Connection::open(&f.database).unwrap();
        let raw: String = c
            .query_row(
                "SELECT body FROM image_service_operations WHERE operation_id=?1",
                [OP],
                |r| r.get(0),
            )
            .unwrap();
        let mut body: Value = serde_json::from_str(&raw).unwrap();
        body["target"] = json!(outside);
        c.execute(
            "UPDATE image_service_operations SET body=?2 WHERE operation_id=?1",
            params![OP, body.to_string()],
        )
        .unwrap();
        drop(c);
        f.host.restore();
        let calls = f.host.calls.lock().unwrap().len();
        assert!(run_worker(
            f.host.as_ref(),
            &f.database,
            OP,
            false,
            &crate::plugin_job::JobControl::new(),
            &f.app,
            Polling {
                interval: Duration::ZERO,
                settlement: 2
            }
        )
        .is_err());
        assert!(!outside.exists());
        assert_eq!(f.host.calls.lock().unwrap().len(), calls);
        assert!(protected_runs(&connection_at(&f.database).unwrap()).is_err());
        assert!(status_at_raw(&f.database, OP).is_err());
    }
    fn status_at_raw(database: &Path, operation: &str) -> Result<Option<Value>, AppError> {
        snapshot_at(database, operation)
    }
    #[test]
    fn malformed_body_cannot_transition_a_different_accepted_operation() {
        let f = Fixture::new();
        f.accept(OP);
        let other = "22222222222222222222222222222222";
        let original = f.accept(other);
        let c = Connection::open(&f.database).unwrap();
        let raw: String = c
            .query_row(
                "SELECT body FROM image_service_operations WHERE operation_id=?1",
                [other],
                |r| r.get(0),
            )
            .unwrap();
        c.execute(
            "UPDATE image_service_operations SET body=?2 WHERE operation_id=?1",
            params![OP, raw],
        )
        .unwrap();
        drop(c);
        assert!(claim_dispatch(&f.database, OP, true).is_err());
        assert_eq!(
            read_link(&f.database, other).unwrap().unwrap().phase,
            original.phase
        );
        assert_eq!(f.host.count("start"), 0);
    }
    #[test]
    fn missing_trace_acceptance_and_non_native_managed_namespace_fail_closed() {
        let f = Fixture::new();
        let link = f.accept(OP);
        let c = Connection::open(&f.database).unwrap();
        c.execute(
            "UPDATE image_jobs SET request_digest=?2 WHERE operation_id=?1",
            params![OP, "f".repeat(64)],
        )
        .unwrap();
        assert!(claim_dispatch(&f.database, OP, true).is_err());
        assert_eq!(f.host.count("start"), 0);
        for target in [
            f.generated.join("outside.png"),
            f.generated.join("generation-forged/nested/output.png"),
            f.generated.join("generation-ok/output.jpg"),
        ] {
            assert!(managed_target(&f.database, &target).is_err());
        }
        assert!(managed_target(&f.database, &link.target).is_ok());
    }
    #[test]
    fn remaining_generation_budget_never_renews_after_backwards_clock_or_restart() {
        let original = remaining_budget(601_000, 1_000);
        assert_eq!(original, Duration::from_secs(600));
        assert!(!budget_expired(
            original,
            Duration::from_secs(599),
            601_000,
            0
        ));
        assert!(budget_expired(
            original,
            Duration::from_secs(600),
            601_000,
            0
        ));
        let restart = remaining_budget(601_000, 590_000);
        assert_eq!(restart, Duration::from_secs(11));
        assert!(budget_expired(restart, Duration::from_secs(11), 601_000, 0));
        assert!(budget_expired(original, Duration::ZERO, 601_000, 601_000));
        assert_eq!(remaining_budget(u64::MAX, 0), Duration::from_secs(600));
        assert_eq!(remaining_budget(1_000, 2_000), Duration::ZERO);
    }
    #[test]
    fn expired_never_forwarded_generation_is_cancelled_without_remote_dispatch() {
        let f = Fixture::new();
        f.accept(OP);
        update(&f.database, OP, |_, l| {
            l.deadline_ms = now_ms().saturating_sub(1);
            Ok(())
        })
        .unwrap();
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "cancelled");
        assert_eq!(f.host.count("start"), 0);
        assert_eq!(f.host.count("status"), 0);
    }
    #[test]
    fn original_success_delivery_can_be_recovered_unpaid_after_generation_deadline() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().unavailable = true;
        f.accept(OP);
        f.run(OP, true);
        update(&f.database, OP, |_, l| {
            l.deadline_ms = now_ms().saturating_sub(1);
            Ok(())
        })
        .unwrap();
        f.host.restore();
        f.run(OP, false);
        assert_eq!(f.snapshot(OP)["status"], "succeeded");
        assert_eq!(f.host.count("start"), 1);
    }
    #[test]
    fn malformed_immutable_trace_recipe_is_rejected_before_provider_dispatch() {
        let f = Fixture::new();
        let link = f.accept(OP);
        let c = Connection::open(&f.database).unwrap();
        let raw: String = c
            .query_row(
                "SELECT parameters FROM runs WHERE id=?1",
                [link.run_id],
                |r| r.get(0),
            )
            .unwrap();
        let mut parameters: Value = parse(&raw).unwrap();
        parameters["effective_recipe"]["model"] = "forged-new-model".into();
        c.execute(
            "UPDATE runs SET parameters=?2 WHERE id=?1",
            params![link.run_id, parameters.to_string()],
        )
        .unwrap();
        assert!(claim_dispatch(&f.database, OP, true).is_err());
        assert!(validate_history_run(&connection_at(&f.database).unwrap(), link.run_id).is_err());
        assert_eq!(f.host.count("start"), 0);
    }
    #[test]
    fn legitimate_later_save_presentation_fields_do_not_change_the_prepared_recipe() {
        let f = Fixture::new();
        let link = f.accept(OP);
        let c = Connection::open(&f.database).unwrap();
        let raw: String = c
            .query_row(
                "SELECT parameters FROM runs WHERE id=?1",
                [link.run_id],
                |r| r.get(0),
            )
            .unwrap();
        let mut parameters: Value = parse(&raw).unwrap();
        parameters["output_storage"] = "saved".into();
        parameters["save_directory_hint"] = "/Pictures/new-location".into();
        c.execute(
            "UPDATE runs SET parameters=?2 WHERE id=?1",
            params![link.run_id, parameters.to_string()],
        )
        .unwrap();
        assert!(read_link(&f.database, OP).unwrap().is_some());
    }
    #[test]
    fn typed_failed_codex_explanation_is_preserved_and_successful_transcript_is_rejected() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().failed = true;
        let link = f.accept(OP);
        claim_dispatch(&f.database, OP, true).unwrap();
        let raw = f
            .host
            .call(
                "host.services.invoke",
                json!({"method":"start","params":link.prepared}),
                &|| false,
            )
            .unwrap();
        let mut receipt: OperationStatus = serde_json::from_value(raw).unwrap();
        receipt.diagnostics = Some(
            te_image_generation_contract::OperationDiagnostics::CodexImageTurn {
                thread_id: "01a11dad-5c1e-7f3a-9b2d-4e6f8a0c2d41".into(),
                turn_state: te_image_generation_contract::CodexTurnState::Failed,
                usage: Some(te_image_generation_contract::TokenUsage {
                    input_tokens: Some(3),
                    cached_input_tokens: None,
                    output_tokens: Some(4),
                }),
                explanation: Some(te_image_generation_contract::FailedExplanation {
                    kind: te_image_generation_contract::ExplanationKind::Error,
                    text: "A retained provider explanation".into(),
                    truncated: true,
                }),
            },
        );
        observe(&f.database, OP, serde_json::to_value(&receipt).unwrap()).unwrap();
        let raw: String = connection_at(&f.database)
            .unwrap()
            .query_row(
                "SELECT result_details FROM runs WHERE id=?1",
                [link.run_id],
                |r| r.get(0),
            )
            .unwrap();
        let details: Value = parse(&raw).unwrap();
        assert_eq!(
            details["codex_error"],
            json!({"text":"A retained provider explanation","truncated":true})
        );
        assert_eq!(details["usage"]["output_tokens"], 4);
        assert_eq!(details["thread_id"], "01a11dad-5c1e-7f3a-9b2d-4e6f8a0c2d41");
        let g = Fixture::new();
        let other = g.accept(OP);
        claim_dispatch(&g.database, OP, true).unwrap();
        let raw = g
            .host
            .call(
                "host.services.invoke",
                json!({"method":"start","params":other.prepared}),
                &|| false,
            )
            .unwrap();
        let mut success: OperationStatus = serde_json::from_value(raw).unwrap();
        success.diagnostics = receipt.diagnostics;
        assert!(observe(&g.database, OP, serde_json::to_value(success).unwrap()).is_err());
        assert!(read_link(&g.database, OP)
            .unwrap()
            .unwrap()
            .receipt
            .is_none());
    }
    #[test]
    fn legacy_history_without_service_ownership_remains_readable() {
        let f = Fixture::new();
        let run=begin_operation_at(&f.database,OperationStart{operation:"openai.image.generate".into(),parameters:json!({"provider":"openai","prompt":"Historical prompt","model":"old-arbitrary-model"}),inputs:vec![]}).unwrap();
        assert!(validate_history_run(&connection_at(&f.database).unwrap(), run).is_ok());
    }
    async fn wait_native_terminal(f: &Fixture, operations: &[String], state: &str) {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let all = operations.iter().all(|op| {
                snapshot_at(&f.database, op)
                    .unwrap()
                    .is_some_and(|v| v["status"] == state && v["workerActive"] == false)
            });
            if all {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "Owned native workers did not reach {state}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn eight_member_batch_accepts_while_provider_is_held_and_queued_cancel_never_starts() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().running = true;
        let mut operations = vec![];
        for index in 0..16 {
            let operation = format!("{:032x}", index + 0x100);
            let mut request = request();
            if index < 8 {
                request.batch = Some(jobs::ImageBatch {
                    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into(),
                    index: index as u32,
                    count: 8,
                });
            }
            let host: Arc<dyn ImageHost> = f.host.clone();
            assert_eq!(
                start_with(
                    host,
                    f.database.clone(),
                    f.generated.clone(),
                    f.app.clone(),
                    request,
                    index + 9,
                    operation.clone(),
                    false
                )
                .await
                .unwrap(),
                index + 9
            );
            operations.push(operation);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while f.host.count("start") < 16 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        for operation in &operations {
            assert_eq!(f.snapshot(operation)["status"], "running");
            assert_eq!(f.snapshot(operation)["workerActive"], true);
        }
        let queued = "ffffffffffffffffffffffffffffffff".to_owned();
        let host: Arc<dyn ImageHost> = f.host.clone();
        let pending = tokio::spawn(start_with(
            host,
            f.database.clone(),
            f.generated.clone(),
            f.app.clone(),
            request(),
            99,
            queued.clone(),
            false,
        ));
        cancel_at(&f.database, &queued).unwrap();
        for operation in &operations {
            cancel_at(&f.database, operation).unwrap();
        }
        assert!(pending.await.unwrap().is_err());
        assert!(read_link(&f.database, &queued).unwrap().is_none());
        wait_native_terminal(&f, &operations, "cancelled").await;
        assert_eq!(f.host.count("start"), 16);
        assert_eq!(f.host.count("prepare"), 16);
        f.run(&operations[0], false);
        assert_eq!(f.host.count("start"), 16);
    }
    #[test]
    fn eight_genuine_png_handoffs_have_at_most_four_concurrent_heavy_io_calls() {
        let gate = Arc::new(IoGate::default());
        let mut fixtures = vec![];
        for _ in 0..8 {
            let f = Fixture::new();
            *f.host.read_gate.lock().unwrap() = Some(gate.clone());
            let link = f.accept(OP);
            fixtures.push((f, link.target));
        }
        let barrier = Arc::new(std::sync::Barrier::new(9));
        let mut workers = vec![];
        for (f, target) in fixtures {
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                f.run(OP, true);
                assert_eq!(f.snapshot(OP)["status"], "succeeded");
                assert_eq!(fs::read(target).unwrap(), PNG);
                assert_eq!(f.host.count("start"), 1);
            }));
        }
        barrier.wait();
        gate.wait_for(4);
        assert_eq!(gate.peak(), 4);
        gate.release();
        for worker in workers {
            worker.join().unwrap();
        }
        assert!(gate.peak() <= 4);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn worker_active_remains_true_until_owned_byte_io_and_thread_finish() {
        let f = Fixture::new();
        let gate = Arc::new(IoGate::default());
        *f.host.read_gate.lock().unwrap() = Some(gate.clone());
        let host: Arc<dyn ImageHost> = f.host.clone();
        assert_eq!(
            start_with(
                host,
                f.database.clone(),
                f.generated.clone(),
                f.app.clone(),
                request(),
                9,
                OP.into(),
                false
            )
            .await
            .unwrap(),
            9
        );
        let entered = gate.clone();
        tokio::task::spawn_blocking(move || entered.wait_for(1))
            .await
            .unwrap();
        assert_eq!(f.snapshot(OP)["workerActive"], true);
        assert_eq!(f.snapshot(OP)["providerExecution"]["state"], "succeeded");
        gate.release();
        wait_native_terminal(&f, &[OP.into()], "succeeded").await;
        assert_eq!(f.snapshot(OP)["workerActive"], false);
    }
    #[test]
    fn stopped_recovery_retains_attention_without_paid_replay_or_failure() {
        let f = Fixture::new();
        f.accept(OP);
        claim_dispatch(&f.database, OP, true).unwrap();
        f.host.behavior.lock().unwrap().stop_recovery = true;
        f.run(OP, false);
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
        assert_eq!(f.snapshot(OP)["recoveryState"], "needs_attention");
        assert_eq!(f.host.count("status"), 1);
        assert_eq!(f.host.count("start"), 0);
        assert!(f.snapshot(OP)["error"]
            .as_str()
            .unwrap()
            .contains("stopped"));
    }
    #[test]
    fn editing_exact_unsaved_revision_inherits_its_permanent_folder_suggestion() {
        for matching in [true, false] {
            let f = Fixture::new();
            let digest = if matching {
                f.host.output.sha256.clone()
            } else {
                "f".repeat(64)
            };
            record_operation_at(&f.database,OperationRecord{operation:"openai.image.generate".into(),parameters:json!({"output_storage":"temporary","save_directory_hint":"/Pictures/original"}),inputs:vec![],output_path:f.host.path.to_string_lossy().into(),output_digest:digest}).unwrap();
            let mut request = request();
            request.source_path = Some(f.host.path.to_string_lossy().into());
            request.expected_source_digest = Some(f.host.output.sha256.clone());
            request.output_dir = "/Pictures/current-fallback".into();
            let link = accept_with(
                f.host.as_ref(),
                &f.database,
                &f.generated,
                request,
                9,
                OP.into(),
                &crate::plugin_job::JobControl::new(),
                false,
            )
            .unwrap()
            .link;
            let raw: String = connection_at(&f.database)
                .unwrap()
                .query_row(
                    "SELECT parameters FROM runs WHERE id=?1",
                    [link.run_id],
                    |r| r.get(0),
                )
                .unwrap();
            let parameters: Value = parse(&raw).unwrap();
            assert_eq!(
                parameters["save_directory_hint"],
                if matching {
                    "/Pictures/original"
                } else {
                    "/Pictures/current-fallback"
                }
            );
            assert_eq!(f.host.count("start"), 0);
        }
    }
    #[test]
    fn full_control_heavy_prompt_preserves_real_provider_http_and_codex_framing_across_handoff_and_reload(
    ) {
        let templates: Value = serde_json::from_str(include_str!(
            "../../test_support/fixtures/shared-image-recipe-templates.json"
        ))
        .unwrap();
        for adapter in ["openai-images", "codex-cli"] {
            let f = Fixture::new();
            let mut intent = request();
            intent.connection_id = if adapter == "codex-cli" {
                "cli"
            } else {
                "http"
            }
            .into();
            intent.model = (adapter == "openai-images").then(|| "fixture-image".into());
            intent.prompt = format!("{}鳥", "\u{1}".repeat(15_997));
            assert_eq!(intent.prompt.len(), 16_000);
            intent.source_path = Some(f.host.path.to_string_lossy().into());
            intent.expected_source_digest = Some(f.host.output.sha256.clone());
            let reference = f._root.path().join("reference.png");
            fs::write(&reference, PNG).unwrap();
            intent.reference_paths = vec![reference.to_string_lossy().into()];
            intent.expected_reference_digests = vec![f.host.output.sha256.clone()];
            let mut recipe: EffectiveRecipe =
                serde_json::from_value(templates[adapter].clone()).unwrap();
            let escaped = serde_json::to_string(&intent.prompt).unwrap();
            let escaped = &escaped[1..escaped.len() - 1];
            recipe.submitted_prompt = recipe.submitted_prompt.replace(
                "__CONTROL_HEAVY_VISUAL_REQUEST__",
                if adapter == "codex-cli" {
                    &intent.prompt
                } else {
                    escaped
                },
            );
            recipe.agent_task = recipe
                .agent_task
                .map(|task| task.replace("__CONTROL_HEAVY_VISUAL_REQUEST__", escaped));
            assert!(recipe.submitted_prompt.len() <= 100 * 1024);
            assert!(recipe
                .agent_task
                .as_ref()
                .is_none_or(|task| task.len() <= 100 * 1024));
            assert!(document(&recipe).unwrap().len() <= 256 * 1024);
            assert!(
                recipe.submitted_prompt.len() > 32_768
                    || recipe
                        .agent_task
                        .as_ref()
                        .is_some_and(|task| task.len() > 32_768)
            );
            *f.host.prepared_recipe.lock().unwrap() = Some(recipe.clone());
            let link = accept_with(
                f.host.as_ref(),
                &f.database,
                &f.generated,
                intent.clone(),
                9,
                OP.into(),
                &crate::plugin_job::JobControl::new(),
                false,
            )
            .unwrap()
            .link;
            assert_eq!(link.prepared.prompt, intent.prompt);
            assert_eq!(link.recipe, recipe);
            assert_eq!(link.captured.len(), 2);
            assert!(document(&link).unwrap().len() > 128 * 1024);
            f.run(OP, true);
            assert_eq!(f.snapshot(OP)["status"], "succeeded");
            assert_eq!(f.host.count("start"), 1);
            assert_eq!(fs::read(&link.target).unwrap(), PNG);
            drop(connection_at(&f.database).unwrap());
            let recovered = read_link(&f.database, OP).unwrap().unwrap();
            assert_eq!(recovered.request.prompt, intent.prompt);
            assert_eq!(recovered.recipe, recipe);
            let connection = connection_at(&f.database).unwrap();
            validate_history_run(&connection, link.run_id).unwrap();
            let parameters: String = connection
                .query_row(
                    "SELECT parameters FROM runs WHERE id=?1",
                    [link.run_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(parameters.len() > 128 * 1024);
            let parameters: Value = parse(&parameters).unwrap();
            assert_eq!(parameters["prompt"], json!(intent.prompt));
            assert_eq!(
                parameters["submitted_prompt"],
                json!(recipe.submitted_prompt)
            );
            assert_eq!(parameters["agent_task"], json!(recipe.agent_task));
            f.run(OP, false);
            assert_eq!(f.host.count("start"), 1);
            assert_eq!(f.host.count("host.artifacts.read"), 1);
        }
    }
    #[test]
    fn oversized_formatted_prompt_task_or_encoded_recipe_rejects_before_local_acceptance_or_paid_dispatch(
    ) {
        for variant in 0..3 {
            let f = Fixture::new();
            let mut recipe = Fake::recipe(&PrepareRequest {
                operation_id: OP.into(),
                connection_id: "fixture".into(),
                expected_connection_revision: "recipe-1".into(),
                model: Some("arbitrary-image-model".into()),
                prompt: "Draw a landscape".into(),
                inputs: vec![],
                options: request().options(),
            });
            match variant {
                0 => recipe.submitted_prompt = "x".repeat(100 * 1024 + 1),
                1 => recipe.agent_task = Some("x".repeat(100 * 1024 + 1)),
                _ => recipe.submitted_prompt = "\u{1}".repeat(100 * 1024),
            }
            *f.host.prepared_recipe.lock().unwrap() = Some(recipe);
            assert!(accept_with(
                f.host.as_ref(),
                &f.database,
                &f.generated,
                request(),
                9,
                OP.into(),
                &crate::plugin_job::JobControl::new(),
                false
            )
            .is_err());
            assert!(read_link(&f.database, OP).unwrap().is_none());
            assert_eq!(
                connection_at(&f.database)
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM image_jobs", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(f.host.count("start"), 0);
            assert_eq!(f.host.count("host.artifacts.release"), 1);
        }
    }

    #[test]
    fn accepted_never_forwarded_run_needs_attention_after_restart_with_zero_provider_starts() {
        let f = Fixture::new();
        let link = f.accept(OP);
        assert_eq!(link.phase, "accepted");
        // The process that committed acceptance died before it claimed
        // forwarding. Its successor only recovers (fresh=false) after reopening.
        drop(connection_at(&f.database).unwrap());
        f.run(OP, false);
        let state = f.snapshot(OP);
        assert_eq!(state["recoveryState"], "needs_attention");
        assert_eq!(state["status"], "uncertain");
        assert_eq!(state["providerExecution"], Value::Null);
        assert_eq!(f.host.count("start"), 0);
        assert!(!f.events.lock().unwrap().iter().any(|(name, _)| {
            name == "openai-image-error" || name == "openai-image-complete"
        }));
        // Another restart and a duplicate submission of the same operation
        // still never dispatch the paid request.
        f.run(OP, false);
        let again = accept_with(
            f.host.as_ref(),
            &f.database,
            &f.generated,
            request(),
            9,
            OP.into(),
            &crate::plugin_job::JobControl::new(),
            false,
        )
        .unwrap();
        assert!(!again.fresh);
        assert_eq!(again.link.run_id, link.run_id);
        assert_eq!(f.host.count("start"), 0);
        assert_eq!(f.host.count("prepare"), 1);
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
    }
    fn run_parameters(f: &Fixture, run: i64) -> Value {
        let raw: String = connection_at(&f.database)
            .unwrap()
            .query_row("SELECT parameters FROM runs WHERE id=?1", [run], |r| r.get(0))
            .unwrap();
        parse(&raw).unwrap()
    }
    fn retry_of(run: i64) -> ImageRequest {
        let mut retry = request();
        retry.retry_of = Some(run);
        retry
    }
    #[test]
    fn retry_of_an_explicit_failure_is_a_new_operation_with_durable_lineage() {
        let f = Fixture::new();
        f.host.behavior.lock().unwrap().failed = true;
        let failed = f.accept(OP);
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "failed");
        f.host.behavior.lock().unwrap().failed = false;
        let calls = f.host.calls.lock().unwrap().len();
        // The failed operation's identity cannot carry the retry.
        assert!(accept_with(
            f.host.as_ref(),
            &f.database,
            &f.generated,
            retry_of(failed.run_id),
            10,
            OP.into(),
            &crate::plugin_job::JobControl::new(),
            false,
        )
        .is_err());
        assert_eq!(f.host.calls.lock().unwrap().len(), calls);
        let retry_op = "33333333333333333333333333333333";
        let retry = accept_with(
            f.host.as_ref(),
            &f.database,
            &f.generated,
            retry_of(failed.run_id),
            10,
            retry_op.into(),
            &crate::plugin_job::JobControl::new(),
            false,
        )
        .unwrap();
        assert!(retry.fresh);
        assert_ne!(retry.link.run_id, failed.run_id);
        f.run(retry_op, true);
        assert_eq!(f.snapshot(retry_op)["status"], "succeeded");
        assert_eq!(f.host.count("start"), 2);
        let started = f.host.states.lock().unwrap();
        assert!(started.contains_key(OP) && started.contains_key(retry_op));
        drop(started);
        drop(connection_at(&f.database).unwrap());
        let lineage = run_parameters(&f, retry.link.run_id);
        assert_eq!(lineage["retry_of"], json!(failed.run_id));
        assert_eq!(lineage["operation_id"], retry_op);
        let original = run_parameters(&f, failed.run_id);
        assert_eq!(original["operation_id"], OP);
        assert!(original.get("retry_of").is_none());
        assert_eq!(f.snapshot(OP)["status"], "failed");
    }
    #[test]
    fn unknown_unavailable_cancelled_successful_or_foreign_runs_are_not_retry_sources() {
        let mut sources = vec![];
        for outcome in ["unknown", "unavailable", "succeeded", "cancelled", "running"] {
            let f = Fixture::new();
            {
                let mut b = f.host.behavior.lock().unwrap();
                b.unknown = outcome == "unknown";
                b.unavailable = outcome == "unavailable";
            }
            let link = f.accept(OP);
            if outcome == "cancelled" {
                cancel_at(&f.database, OP).unwrap();
            }
            if outcome == "running" {
                claim_dispatch(&f.database, OP, true).unwrap();
            } else {
                f.run(OP, true);
            }
            sources.push((outcome, f, link.run_id));
        }
        let f = Fixture::new();
        let crop = begin_operation_at(
            &f.database,
            OperationStart {
                operation: "image.crop".into(),
                parameters: json!({}),
                inputs: vec![],
            },
        )
        .unwrap();
        fail_run_at(&f.database, crop, "crop_failed").unwrap();
        sources.push(("non-image failure", f, crop));
        let f = Fixture::new();
        sources.push(("missing", f, 4242));
        let f = Fixture::new();
        let forged = begin_operation_at(
            &f.database,
            OperationStart {
                operation: "openai.image.generate".into(),
                parameters: json!({"prompt":"Legacy"}),
                inputs: vec![],
            },
        )
        .unwrap();
        connection_at(&f.database).unwrap().execute("UPDATE runs SET status='failed',result_details=?2 WHERE id=?1",params![forged,json!({"execution":{"state":"unknown"}}).to_string()]).unwrap();
        sources.push(("failed status with unknown execution", f, forged));
        for (outcome, f, run) in sources {
            let calls = f.host.calls.lock().unwrap().len();
            let jobs: i64 = connection_at(&f.database)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM image_jobs", [], |r| r.get(0))
                .unwrap();
            let retry_op = "44444444444444444444444444444444";
            assert!(
                accept_with(
                    f.host.as_ref(),
                    &f.database,
                    &f.generated,
                    retry_of(run),
                    11,
                    retry_op.into(),
                    &crate::plugin_job::JobControl::new(),
                    false,
                )
                .is_err(),
                "{outcome} run was accepted as a Retry source"
            );
            assert_eq!(f.host.calls.lock().unwrap().len(), calls, "{outcome}");
            assert!(read_link(&f.database, retry_op).unwrap().is_none());
            let after: i64 = connection_at(&f.database)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM image_jobs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(after, jobs, "{outcome}");
        }
    }
    #[test]
    fn legacy_failed_image_run_without_execution_evidence_remains_retryable() {
        let f = Fixture::new();
        let legacy = begin_operation_at(
            &f.database,
            OperationStart {
                operation: "openai.image.generate".into(),
                parameters: json!({"provider":"openai","prompt":"Legacy"}),
                inputs: vec![],
            },
        )
        .unwrap();
        fail_run_at(&f.database, legacy, "provider_error").unwrap();
        let retry = accept_with(
            f.host.as_ref(),
            &f.database,
            &f.generated,
            retry_of(legacy),
            12,
            OP.into(),
            &crate::plugin_job::JobControl::new(),
            false,
        )
        .unwrap();
        assert_eq!(run_parameters(&f, retry.link.run_id)["retry_of"], json!(legacy));
    }
    /// A directory link: a symlink on Unix, a junction on Windows (which needs
    /// no privilege, unlike a Windows symlink).
    fn link_directory(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .status()
                .unwrap();
            assert!(status.success(), "mklink /J failed");
            assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
        }
    }
    fn unlink_directory(link: &Path) {
        #[cfg(unix)]
        fs::remove_file(link).unwrap();
        // Removing a junction removes only the reparse point, not its target.
        #[cfg(windows)]
        fs::remove_dir(link).unwrap();
    }
    #[cfg(any(unix, windows))]
    #[test]
    fn linked_evidence_directory_is_refused_while_its_real_path_reads() {
        let f = Fixture::new();
        let real = f._root.path().join("evidence");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("sealed.png"), PNG).unwrap();
        let alias = f._root.path().join("evidence-link");
        link_directory(&real, &alias);
        assert!(regular(&real.join("sealed.png")).is_ok());
        assert!(regular(&alias.join("sealed.png")).is_err());
        assert!(sync_ancestors(&alias).is_err());
    }
    #[cfg(any(unix, windows))]
    #[test]
    fn linked_publication_directory_is_never_published_through_and_recovers_after_restoration() {
        let f = Fixture::new();
        let link = f.accept(OP);
        let directory = link.target.parent().unwrap().to_path_buf();
        let moved = directory.with_file_name("substituted-real-directory");
        fs::rename(&directory, &moved).unwrap();
        link_directory(&moved, &directory);
        f.run(OP, true);
        assert_eq!(f.snapshot(OP)["status"], "uncertain");
        assert_eq!(f.snapshot(OP)["providerExecution"]["state"], "succeeded");
        assert_eq!(fs::read_dir(&moved).unwrap().count(), 0);
        assert_eq!(f.host.count("host.artifacts.acquired"), 0);
        assert_eq!(f.host.count("acknowledge"), 0);
        unlink_directory(&directory);
        fs::rename(&moved, &directory).unwrap();
        f.run(OP, false);
        assert_eq!(f.snapshot(OP)["status"], "succeeded");
        assert_eq!(fs::read(&link.target).unwrap(), PNG);
        assert_eq!(f.host.count("start"), 1);
    }

    #[test]
    fn prepared_recipe_from_another_formatter_or_profile_revision_is_refused_before_acceptance() {
        for variant in ["formatter", "schema", "profile"] {
            let f = Fixture::new();
            let mut recipe = Fake::recipe(&PrepareRequest {
                operation_id: OP.into(),
                connection_id: "fixture".into(),
                expected_connection_revision: "recipe-1".into(),
                model: Some("arbitrary-image-model".into()),
                prompt: "Draw a landscape".into(),
                inputs: vec![],
                options: request().options(),
            });
            match variant {
                "formatter" => recipe.formatter_version = 2,
                "schema" => recipe.schema_version = 2,
                _ => recipe.connection_revision = "recipe-2".into(),
            }
            *f.host.prepared_recipe.lock().unwrap() = Some(recipe);
            assert!(
                accept_with(
                    f.host.as_ref(),
                    &f.database,
                    &f.generated,
                    request(),
                    9,
                    OP.into(),
                    &crate::plugin_job::JobControl::new(),
                    false,
                )
                .is_err(),
                "{variant}"
            );
            assert!(read_link(&f.database, OP).unwrap().is_none(), "{variant}");
            assert_eq!(f.host.count("start"), 0, "{variant}");
            assert_eq!(f.host.count("host.artifacts.release"), 1, "{variant}");
        }
    }
}
