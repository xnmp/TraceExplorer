//! Shared scaffolding for plugin background jobs (#278).
//!
//! Extracted from duplicated skeletons in nano_banana.rs and upscale.rs:
//! job-id allocation, output-target validation, the timeout wrapper, and
//! the `{prefix}-complete` / `{prefix}-error` event emission the frontend
//! plugins listen for. A third AI plugin should need none of this copied.

use crate::error::AppError;
use crate::events::EventEmitter;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);
static JOBS: std::sync::OnceLock<Mutex<std::collections::HashMap<u64, JobControl>>> =
    std::sync::OnceLock::new();
pub(crate) struct JobLease(u64);
pub(crate) fn own_job(id: u64, control: JobControl) -> JobLease {
    JOBS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(id, control);
    JobLease(id)
}
impl Drop for JobLease {
    fn drop(&mut self) {
        if let Some(jobs) = JOBS.get() {
            jobs.lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.0);
        }
    }
}
pub fn shutdown_jobs() {
    if let Some(jobs) = JOBS.get() {
        for control in jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
        {
            control.cancel();
        }
    }
}
pub(crate) fn has_live_jobs() -> bool {
    JOBS.get().is_some_and(|jobs| !jobs.lock().unwrap_or_else(|error| error.into_inner()).is_empty())
}

/// Generous upper bound for a single plugin job; external tools/APIs can be
/// slow but must never run forever.
pub const JOB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const CANCEL_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Native acceptance shortens the timeout through the environment. Builds
/// without the `e2e-hooks` feature never read the variable at all.
#[cfg(feature = "e2e-hooks")]
fn job_timeout() -> std::time::Duration {
    job_timeout_with_override(
        std::env::var("TAURI_EXPLORER_E2E_PLUGIN_JOB_TIMEOUT_MS")
            .ok()
            .as_deref(),
    )
}

#[cfg(not(feature = "e2e-hooks"))]
fn job_timeout() -> std::time::Duration {
    JOB_TIMEOUT
}

#[cfg(feature = "e2e-hooks")]
fn job_timeout_with_override(override_ms: Option<&str>) -> std::time::Duration {
    override_ms
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map_or(JOB_TIMEOUT, std::time::Duration::from_millis)
}

#[derive(Clone)]
pub struct JobControl {
    state: Arc<Mutex<JobState>>,
    cancelled: Arc<tokio::sync::Notify>,
}

enum JobState {
    Active,
    Cancelled,
    Committed,
}

impl JobControl {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(JobState::Active)),
            cancelled: Arc::new(tokio::sync::Notify::new()),
        }
    }

    pub fn cancel(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*state, JobState::Active) {
            *state = JobState::Cancelled;
            self.cancelled.notify_waiters();
            true
        } else {
            false
        }
    }

    pub(crate) async fn cancelled(&self) {
        loop {
            let notification = self.cancelled.notified();
            tokio::pin!(notification);
            notification.as_mut().enable();
            if self.check().is_err() {
                return;
            }
            notification.await;
        }
    }

    pub(crate) fn has_published(&self) -> bool {
        matches!(
            *self.state.lock().unwrap_or_else(|e| e.into_inner()),
            JobState::Committed
        )
    }

    pub fn check(&self) -> Result<(), AppError> {
        if matches!(
            *self.state.lock().unwrap_or_else(|e| e.into_inner()),
            JobState::Cancelled
        ) {
            Err(AppError::Other("Plugin job cancelled".into()))
        } else {
            Ok(())
        }
    }

    /// Publication and cancellation share one decision point. Once a file is
    /// published, timeout cancellation cannot describe it as an unpublished job.
    pub(crate) fn publish<T>(
        &self,
        publish: impl FnOnce() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*state, JobState::Cancelled) {
            return Err(AppError::Other("Plugin job cancelled".into()));
        }
        let result = publish();
        if result.is_ok() {
            *state = JobState::Committed;
        }
        result
    }
}

/// Allocate a process-unique job id.
pub fn next_job_id() -> u64 {
    NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed)
}

/// A bare filename that cannot escape its directory.
pub fn is_valid_output_filename(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != ".."
}

/// Validate the job's write target: `output_dir` must be an existing
/// directory and `output_filename` a bare, traversal-free name. Returns the
/// canonical output path. Resolving the directory once keeps a later symlink
/// retarget from redirecting either staging or publication.
pub fn validate_output_target(
    output_dir: &str,
    output_filename: &str,
) -> Result<PathBuf, AppError> {
    let output = PathBuf::from(output_dir);
    if !output.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Output directory does not exist: {}",
            output_dir
        )));
    }
    // The output filename must stay inside output_dir — reject separators
    // and traversal outright rather than trusting the caller.
    if !is_valid_output_filename(output_filename) {
        return Err(AppError::InvalidPath(format!(
            "Invalid output filename: {}",
            output_filename
        )));
    }
    let output = std::fs::canonicalize(&output).map_err(|error| {
        AppError::InvalidPath(format!(
            "Failed to resolve output directory {output_dir}: {error}"
        ))
    })?;
    Ok(output.join(output_filename))
}

/// Publish a fully-written staging file only while this job still owns output.
/// The staging file is removed on cancellation or rename failure.
pub struct StagedOutput(tempfile::NamedTempFile);

impl StagedOutput {
    pub fn new(final_output: &std::path::Path) -> Result<Self, AppError> {
        let parent = final_output
            .parent()
            .ok_or_else(|| AppError::InvalidPath("Output has no parent".into()))?;
        tempfile::Builder::new()
            .prefix(".plugin-output-")
            .tempfile_in(parent)
            .map(Self)
            .map_err(|error| AppError::Other(format!("Failed to create staging output: {error}")))
    }

    pub fn file_mut(&mut self) -> &mut std::fs::File {
        self.0.as_file_mut()
    }
    pub(crate) fn commit_traced(
        mut self,
        run: &crate::trace::TraceRunHandle,
        target: &std::path::Path,
        control: &JobControl,
    ) -> Result<JobOutput, AppError> {
        use std::io::{Seek, SeekFrom};
        self.0.as_file_mut().sync_all()?;
        self.0.as_file_mut().seek(SeekFrom::Start(0))?;
        crate::image_operation::execute_recorded(run, target, control, || {
            let bytes = crate::image_operation::bounded_bytes(self.0.as_file_mut())?;
            Ok(crate::image_operation::GeneratedImage {
                bytes,
                details: serde_json::Value::Null,
            })
        })
    }

    #[cfg(test)]
    pub fn commit(
        self,
        final_output: &std::path::Path,
        control: &JobControl,
    ) -> Result<(), AppError> {
        control.publish(|| {
            self.0.persist(final_output).map(|_| ()).map_err(|error| {
                AppError::Other(format!("Failed to publish plugin output: {}", error.error))
            })
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginJobCompleteEvent {
    #[serde(rename = "jobId")]
    pub job_id: u64,
    #[serde(rename = "outputPath")]
    pub output_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

pub(crate) struct JobOutput {
    pub path: String,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginJobErrorEvent {
    #[serde(rename = "jobId")]
    pub job_id: u64,
    pub error: String,
}

/// Await `job` under [`JOB_TIMEOUT`], then emit `{prefix}-complete` with the
/// output path or `{prefix}-error` with the failure message.
pub(crate) async fn run_and_emit_detailed(
    app: &EventEmitter,
    event_prefix: &str,
    job_id: u64,
    control: JobControl,
    job: impl std::future::Future<Output = Result<JobOutput, AppError>>,
) {
    let result = run_with_timeout(event_prefix, control, job_timeout(), job).await;
    let _ = app.emit("trace:changed", ());
    emit_result(app, event_prefix, job_id, result);
}

async fn run_with_timeout<T>(
    event_prefix: &str,
    control: JobControl,
    timeout: std::time::Duration,
    job: impl std::future::Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    tokio::pin!(job);
    match tokio::time::timeout(timeout, &mut job).await {
        Ok(result) => result,
        Err(_) => {
            let cancelled = control.cancel();
            // `spawn_blocking` work cannot be aborted once running. Signal its
            // cooperative owner and briefly drain it before publishing the
            // terminal timeout event. Any worker still alive after this bound
            // cannot publish because final output commit checks `control`.
            match tokio::time::timeout(CANCEL_DRAIN_TIMEOUT, &mut job).await {
                Ok(result) if !cancelled => result,
                _ => Err(AppError::Other(format!("{} job timed out", event_prefix))),
            }
        }
    }
}

fn emit_result(
    app: &EventEmitter,
    event_prefix: &str,
    job_id: u64,
    result: Result<JobOutput, AppError>,
) {
    match result {
        Ok(output) => {
            let _ = app.emit(
                &format!("{}-complete", event_prefix),
                PluginJobCompleteEvent {
                    job_id,
                    output_path: output.path,
                    warning: output.warning,
                },
            );
        }
        Err(e) => {
            let _ = app.emit(
                &format!("{}-error", event_prefix),
                PluginJobErrorEvent {
                    job_id,
                    error: e.to_string(),
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "e2e-hooks")]
    #[test]
    fn hook_builds_honour_a_positive_timeout_override() {
        assert_eq!(
            job_timeout_with_override(Some("100")),
            std::time::Duration::from_millis(100)
        );
    }

    #[cfg(not(feature = "e2e-hooks"))]
    #[test]
    fn builds_without_hooks_ignore_the_timeout_override() {
        // The variable is never read (it is absent from release binaries), so
        // the production timeout is fixed even when the override is set. No
        // other code in a build without the feature reads this variable, so
        // setting it cannot race a concurrently running test.
        const OVERRIDE: &str = "TAURI_EXPLORER_E2E_PLUGIN_JOB_TIMEOUT_MS";
        std::env::set_var(OVERRIDE, "100");
        let timeout = job_timeout();
        std::env::remove_var(OVERRIDE);
        assert_eq!(timeout, JOB_TIMEOUT);
        assert_ne!(timeout, std::time::Duration::from_millis(100));
    }

    #[cfg(feature = "e2e-hooks")]
    #[test]
    fn malformed_or_zero_e2e_timeout_overrides_keep_the_default() {
        for value in [
            None,
            Some(""),
            Some("0"),
            Some("-5"),
            Some("ten"),
            Some("99999999999999999999999"),
        ] {
            assert_eq!(job_timeout_with_override(value), JOB_TIMEOUT, "{value:?}");
        }
    }

    #[test]
    fn cancellation_of_a_held_staging_file_removes_it_without_publication() {
        let dir = crate::test_support::tempdir().unwrap();
        let final_output = dir.path().join("result.png");
        let control = JobControl::new();
        let mut staging = StagedOutput::new(&final_output).unwrap();
        std::io::Write::write_all(staging.file_mut(), b"complete bytes").unwrap();

        assert!(
            !final_output.exists(),
            "staging became visible before commit"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        assert!(control.cancel());
        assert!(staging.commit(&final_output, &control).is_err());
        assert!(!final_output.exists(), "cancelled staging was published");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn cancellation_and_publication_have_one_serialized_winner() {
        for attempt in 0..64 {
            let dir = crate::test_support::tempdir().unwrap();
            let final_output = dir.path().join("result.png");
            let control = JobControl::new();
            let publish_control = control.clone();
            let publish_output = final_output.clone();
            let gate = Arc::new(std::sync::Barrier::new(2));
            let publish_gate = Arc::clone(&gate);
            let publisher = std::thread::spawn(move || {
                let mut staging = StagedOutput::new(&publish_output).unwrap();
                std::io::Write::write_all(staging.file_mut(), b"owned").unwrap();
                publish_gate.wait();
                staging.commit(&publish_output, &publish_control)
            });

            gate.wait();
            let cancelled = control.cancel();
            let published = publisher.join().unwrap().is_ok();
            assert_ne!(
                cancelled, published,
                "attempt {attempt} had no unique winner"
            );
            assert_eq!(final_output.exists(), published);
            assert_eq!(
                std::fs::read_dir(dir.path()).unwrap().count(),
                usize::from(published)
            );
        }
    }

    #[test]
    fn output_filename_cannot_traverse() {
        assert!(is_valid_output_filename("edited.png"));
        assert!(!is_valid_output_filename(""));
        assert!(!is_valid_output_filename("../escape.png"));
        assert!(!is_valid_output_filename("a/b.png"));
        assert!(!is_valid_output_filename("a\\b.png"));
        assert!(!is_valid_output_filename("."));
        assert!(!is_valid_output_filename(".."));
    }

    #[test]
    fn job_ids_are_unique_and_increasing() {
        let a = next_job_id();
        let b = next_job_id();
        assert!(b > a);
    }

    #[test]
    fn validate_output_target_joins_valid_names() {
        let dir = std::env::temp_dir();
        let joined = validate_output_target(dir.to_str().unwrap(), "out.png").unwrap();
        assert_eq!(joined, std::fs::canonicalize(&dir).unwrap().join("out.png"));
        assert!(validate_output_target(dir.to_str().unwrap(), "../x.png").is_err());
        assert!(validate_output_target("/definitely/not/a/dir", "x.png").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolved_output_target_is_stable_when_directory_symlink_is_retargeted() {
        use std::os::unix::fs::symlink;

        let root = crate::test_support::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let alias = root.path().join("output");
        symlink(&first, &alias).unwrap();

        let target = validate_output_target(alias.to_str().unwrap(), "result.png").unwrap();
        std::fs::remove_file(&alias).unwrap();
        symlink(&second, &alias).unwrap();

        let control = JobControl::new();
        let mut staging = StagedOutput::new(&target).unwrap();
        std::io::Write::write_all(staging.file_mut(), b"owned").unwrap();
        staging.commit(&target, &control).unwrap();

        assert_eq!(std::fs::read(first.join("result.png")).unwrap(), b"owned");
        assert!(!second.join("result.png").exists());
    }

    #[test]
    fn timeout_revokes_late_blocking_output_before_reporting_failure() {
        let dir = crate::test_support::tempdir().unwrap();
        let final_output = dir.path().join("result.png");
        let control = JobControl::new();
        let worker_control = control.clone();
        let worker_final = final_output.clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        let result = runtime.block_on(run_with_timeout(
            "test",
            control,
            std::time::Duration::from_millis(10),
            async move {
                tokio::task::spawn_blocking(move || {
                    let mut staging = StagedOutput::new(&worker_final)?;
                    std::io::Write::write_all(staging.file_mut(), b"late").unwrap();
                    // Finish only after the timeout has cancelled the job. A fixed
                    // sleep raced the timer on loaded runners: when the runtime
                    // polled late, the finished job won and the test saw Ok.
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                    while worker_control.check().is_ok() && std::time::Instant::now() < deadline {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    staging.commit(&worker_final, &worker_control)?;
                    Ok(worker_final.to_string_lossy().into_owned())
                })
                .await
                .unwrap()
            },
        ));

        assert!(result.unwrap_err().to_string().contains("timed out"));
        assert!(
            !final_output.exists(),
            "timed-out worker published final output"
        );
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "timed-out worker left staging output"
        );
    }
}
