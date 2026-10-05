//! Common image producer contract: immutable input, durable attempt, exact
//! staged evidence before no-replace publication, and durable terminal status.
use crate::{error::AppError, plugin_job, trace};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 200 * 1024 * 1024;
fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}
pub(crate) struct GeneratedImage {
    pub bytes: Vec<u8>,
    pub details: Value,
}

pub(crate) struct CapturedImage {
    pub snapshot: PathBuf,
    pub input: trace::OperationInput,
    _owner: tempfile::TempDir,
}
impl CapturedImage {
    pub fn snapshot_path(&self) -> &Path {
        &self.snapshot
    }
    pub fn read(source: &Path) -> Result<Self, AppError> {
        if !source.is_absolute() {
            return Err(invalid("Image input must be an absolute path"));
        }
        let physical = dunce::canonicalize(source)?;
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let mut file = options.open(&physical)?;
        if !file.metadata()?.is_file() {
            return Err(invalid("Image input must be a regular file"));
        }
        let bytes = bounded_bytes(&mut file)?;
        let digest = hex::encode(Sha256::digest(&bytes));
        let owner = tempfile::Builder::new()
            .prefix("explorer-image-input-")
            .tempdir()?;
        let extension = physical
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("png");
        if !extension.bytes().all(|byte| byte.is_ascii_alphanumeric()) || extension.len() > 10 {
            return Err(invalid("Invalid image extension"));
        }
        let snapshot = owner.path().join(format!("source.{extension}"));
        std::fs::write(&snapshot, bytes)?;
        Ok(Self {
            snapshot,
            input: trace::OperationInput {
                path: physical.to_string_lossy().into_owned(),
                digest,
            },
            _owner: owner,
        })
    }
}
pub(crate) fn bounded_bytes(file: &mut std::fs::File) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(invalid("Image exceeds the 200 MiB limit"));
    }
    Ok(bytes)
}
/// A worker/future drop is also a terminal attempt; success and uncertainty
/// already settled by the publisher are preserved by Trace's status guard.
pub(crate) struct Attempt {
    pub run: trace::TraceRunHandle,
    control: plugin_job::JobControl,
    app: Option<tauri::AppHandle>,
    armed: bool,
}
fn settle_attempt(
    run: &trace::TraceRunHandle,
    control: &plugin_job::JobControl,
    app: Option<&tauri::AppHandle>,
) {
    let result = if control.has_published() {
        trace::mark_operation_uncertain(run, "image_completion_pending")
    } else if control.check().is_err() {
        trace::cancel_operation(run)
    } else {
        trace::fail_operation(run, "image_worker_failed")
    };
    if let Err(error) = result {
        log::warn!("Image attempt settlement pending: {error}");
    }
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit("trace:changed", ());
    }
}
impl Attempt {
    pub fn new(run: trace::TraceRunHandle, control: plugin_job::JobControl) -> Self {
        Self {
            run,
            control,
            app: None,
            armed: true,
        }
    }
    pub fn with_app(mut self, app: tauri::AppHandle) -> Self {
        self.app = Some(app);
        self
    }
    /// Call on a blocking worker before reporting a terminal result.
    pub fn settle(mut self) {
        self.armed = false;
        settle_attempt(&self.run, &self.control, self.app.as_ref());
    }
}
impl Drop for Attempt {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let run = self.run.clone();
        let control = self.control.clone();
        let app = self.app.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || settle_attempt(&run, &control, app.as_ref()));
        } else {
            settle_attempt(&run, &control, app.as_ref());
        }
    }
}

pub(crate) fn execute_recorded(
    run: &trace::TraceRunHandle,
    target: &Path,
    control: &plugin_job::JobControl,
    generate: impl FnOnce() -> Result<GeneratedImage, AppError>,
) -> Result<plugin_job::JobOutput, AppError> {
    execute_with_completion(run, target, control, generate, trace::complete_operation)
}

pub(crate) fn execute_with_completion(
    run: &trace::TraceRunHandle,
    target: &Path,
    control: &plugin_job::JobControl,
    generate: impl FnOnce() -> Result<GeneratedImage, AppError>,
    complete: impl FnOnce(&trace::TraceRunHandle, &str) -> Result<(), AppError>,
) -> Result<plugin_job::JobOutput, AppError> {
    let mut published = false;
    let result = (|| {
        control.check()?;
        match std::fs::symlink_metadata(target) {
            Ok(_) => {
                return Err(invalid(
                    "Output filename is already occupied; choose another name",
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let image = generate()?;
        control.check()?;
        trace::record_operation_details(run, &image.details)?;
        let digest = hex::encode(Sha256::digest(&image.bytes));
        let mut stage = crate::files::publication::StagedEntry::prepare(
            target
                .parent()
                .ok_or_else(|| invalid("Output has no parent"))?,
            |path| {
                let mut file = std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(path)?;
                file.write_all(&image.bytes)?;
                file.sync_all()?;
                Ok(())
            },
        )?;
        let anchor = stage.trace_anchor()?;
        trace::prepare_operation_output(run, target, &digest, Some(&anchor))?;
        stage.retain_trace_anchor();
        control.publish(|| stage.publish(target))?;
        published = true;
        let path = target.to_string_lossy().into_owned();
        let warning = match complete(run, &path) {
            Ok(()) => None,
            Err(error) => {
                log::warn!("Image output published but Trace completion remains pending: {error}");
                if let Err(error) = trace::mark_operation_uncertain(run, "trace_completion_pending")
                {
                    log::warn!("Trace could not mark pending completion: {error}");
                }
                Some(
                    "Image saved; Trace completion is pending and will be recovered on restart."
                        .into(),
                )
            }
        };
        Ok(plugin_job::JobOutput { path, warning })
    })();
    if result.is_err() && !published {
        let settled = if control.check().is_err() {
            trace::cancel_operation(run)
        } else {
            trace::fail_operation(run, "image_operation_failed")
        };
        if let Err(error) = settled {
            log::warn!("Image Trace run could not be finalized: {error}");
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    const PNG: &[u8] = include_bytes!("../icons/32x32.png");
    #[test]
    fn captured_provider_input_is_immutable_when_the_original_changes() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.png");
        std::fs::write(&source, PNG).unwrap();
        let captured = CapturedImage::read(&source).unwrap();
        std::fs::write(&source, b"later edit").unwrap();
        assert_eq!(std::fs::read(captured.snapshot_path()).unwrap(), PNG);
        assert_eq!(captured.input.digest, hex::encode(Sha256::digest(PNG)));
    }
    #[test]
    fn dropping_an_accepted_worker_records_failure_or_cancellation() {
        for cancel in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join("source.png");
            std::fs::write(&source, PNG).unwrap();
            let db = root.path().join("trace.sqlite");
            let captured = CapturedImage::read(&source).unwrap();
            let run = trace::begin_operation_for_test(
                &db,
                trace::OperationStart {
                    operation: "image.test".into(),
                    parameters: Value::Null,
                    inputs: vec![captured.input],
                },
            )
            .unwrap();
            let control = plugin_job::JobControl::new();
            let attempt = Attempt::new(run, control.clone());
            if cancel {
                control.cancel();
            }
            drop(attempt);
            let graph =
                serde_json::to_value(trace::graph_for_path_at(&db, &source).unwrap().unwrap())
                    .unwrap();
            assert_eq!(
                graph["runs"][0]["status"],
                if cancel { "cancelled" } else { "failed" }
            );
            assert_eq!(graph["artifacts"].as_array().unwrap().len(), 1);
        }
    }
}
