//! Control-plane orchestration. No journal/configuration guard spans host/provider IO.
use crate::{
    adapters,
    domain::{self, Configuration, Credential, Profile},
    error::{error, invalid, storage, Result},
    host::Host,
    journal::{epoch_millis, Journal},
    profiles::{directory_sync, nonce, DirectorySync, Profiles},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use te_image_generation_contract::*;
struct Prepared {
    caller: Caller,
    recipe: EffectiveRecipe,
    semantic: String,
    expires: Instant,
}
struct Work {
    caller: Caller,
    request: StartRequest,
    profile: Profile,
    recipe: EffectiveRecipe,
    key: Option<String>,
    paths: Vec<PathBuf>,
    cancel: Arc<AtomicBool>,
    deadline: i64,
    _deadline_done: tokio::sync::oneshot::Sender<()>,
}
struct AdmissionIo {
    service: Arc<Service>,
    identity: (String, String),
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Drop for AdmissionIo {
    fn drop(&mut self) {
        drop(self.permit.take());
        let mut leases = self
            .service
            .admission_io
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(count) = leases.get_mut(&self.identity) {
            *count -= 1;
            if *count == 0 {
                leases.remove(&self.identity);
            }
        }
    }
}
type OperationKey = (String, String);
/// A proven success whose output this process is still staging and sealing.
/// Holds the last receipt consumers could have observed until the terminal
/// receipt is committed (plan §8.3 step 8), then forgets it on any exit path.
struct Unannounced {
    service: Arc<Service>,
    identity: OperationKey,
}
impl Drop for Unannounced {
    fn drop(&mut self) {
        self.service
            .unannounced
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.identity);
    }
}
/// Classified read-back of a durable output descriptor. Only a verified host
/// answer may change durable delivery; anything else is reported, not stored.
enum Readback {
    Intact,
    Lost(&'static str),
    Transient,
}
fn readback(result: &Result<Value>, expected: &ArtifactDescriptor) -> Readback {
    match result {
        Ok(value) => {
            if serde_json::from_value::<ArtifactDescriptor>(value["artifact"].clone())
                .is_ok_and(|returned| &returned == expected)
            {
                Readback::Intact
            } else {
                Readback::Transient
            }
        }
        Err(failure) => match failure.code.as_str() {
            "not_found" | "missing" => Readback::Lost("missing"),
            "corrupt" | "input_changed" => Readback::Lost("corrupt"),
            _ => Readback::Transient,
        },
    }
}
/// Production policy is fixed; tests inject shorter budgets/durability failures.
pub struct ServicePolicy {
    pub operation_budget: Duration,
    pub sync_profile_directory: DirectorySync,
    pub before_deadline_cancel: Arc<dyn Fn() + Send + Sync>,
}
impl Default for ServicePolicy {
    fn default() -> Self {
        Self {
            operation_budget: Duration::from_secs(900),
            sync_profile_directory: directory_sync(),
            before_deadline_cancel: Arc::new(|| {}),
        }
    }
}
pub struct Service {
    pub profiles: Profiles,
    pub journal: Journal,
    host: Arc<dyn Host>,
    preparations: Mutex<HashMap<String, Prepared>>,
    controls: Mutex<HashMap<(String, String), Arc<AtomicBool>>>,
    admission_io: Mutex<HashMap<(String, String), usize>>,
    unannounced: Mutex<HashMap<OperationKey, OperationStatus>>,
    admissions: Arc<tokio::sync::Semaphore>,
    workers: Arc<tokio::sync::Semaphore>,
    ready: AtomicBool,
    directory: PathBuf,
    owner: Mutex<Option<std::fs::File>>,
    operation_budget: Duration,
    before_deadline_cancel: Arc<dyn Fn() + Send + Sync>,
}
impl Service {
    pub fn new(directory: &Path, host: Arc<dyn Host>) -> Result<Arc<Self>> {
        Self::with_policy(directory, host, ServicePolicy::default())
    }
    pub fn with_policy(
        directory: &Path,
        host: Arc<dyn Host>,
        policy: ServicePolicy,
    ) -> Result<Arc<Self>> {
        if !directory.is_absolute() {
            return Err(invalid("Image service data directory must be absolute"));
        }
        match std::fs::symlink_metadata(directory) {
            Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
                return Err(invalid("Image service state must be a private directory"));
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(storage(e)),
            _ => {}
        }
        let service = Arc::new(Self {
            profiles: Profiles::with_directory_sync(directory, policy.sync_profile_directory),
            journal: Journal::open(directory)?,
            host,
            preparations: Mutex::new(HashMap::new()),
            controls: Mutex::new(HashMap::new()),
            admission_io: Mutex::new(HashMap::new()),
            unannounced: Mutex::new(HashMap::new()),
            admissions: Arc::new(tokio::sync::Semaphore::new(36)),
            workers: Arc::new(tokio::sync::Semaphore::new(4)),
            ready: AtomicBool::new(false),
            directory: directory.into(),
            owner: Mutex::new(None),
            operation_budget: policy.operation_budget,
            before_deadline_cancel: policy.before_deadline_cancel,
        });
        // Profile failures gate new preparation/settings, while durable receipts remain readable.
        let _ = service.profiles.preflight_read();
        Ok(service)
    }
    pub fn validate_preflight(&self) -> Result<()> {
        self.profiles.preflight_read().map(|_| ())
    }
    pub async fn wait_idle(&self) {
        let _all = self.admissions.clone().acquire_many_owned(36).await;
    }
    pub fn activate(self: &Arc<Self>) -> Result<()> {
        if self.ready() {
            return Ok(());
        }
        use fs2::FileExt;
        let mut owner = self.owner.lock().map_err(storage)?;
        if self.ready() {
            return Ok(());
        }
        // A quiesced instance already owns activated storage. Resume locally without
        // reinterpreting live receipts as crash recovery or scheduling any work.
        if owner.is_some() {
            self.ready.store(true, Ordering::Release);
            return Ok(());
        }
        std::fs::create_dir_all(&self.directory).map_err(storage)?;
        let meta = std::fs::symlink_metadata(&self.directory).map_err(storage)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(invalid("Image service state must be a private directory"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.directory, std::fs::Permissions::from_mode(0o700))
                .map_err(storage)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let lease = options
            .open(self.directory.join("operations.owner.lock"))
            .map_err(storage)?;
        lease.try_lock_exclusive().map_err(|_| {
            error(
                "busy",
                "Another Image Generation backend owns this state directory",
            )
        })?;
        self.journal.activate()?;
        let recovered = self.journal.recover()?;
        *owner = Some(lease);
        drop(owner);
        self.ready.store(true, Ordering::Release);
        let host = self.host.clone();
        tokio::task::spawn_blocking(move || {
            for (caller, status, test) in recovered {
                let _ = host.event(
                    "image-generation:operation-changed",
                    json!({"consumerPackageId":caller,"status":status}),
                );
                if test {
                    let _ = host.call(
                        "host.services.test.update",
                        json!({"operationId":status.operation_id,"status":status}),
                        &AtomicBool::new(false),
                    );
                }
            }
        });
        Ok(())
    }
    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }
    pub fn quiesce(&self) -> Result<Value> {
        self.quiesce_with_handlers(|| true)
    }
    /// Closing the readiness gate precedes the handler-idle check, so a newly
    /// admitted stdio frame can only observe unavailable, never mutate storage.
    pub fn quiesce_with_handlers(&self, handlers_idle: impl FnOnce() -> bool) -> Result<Value> {
        let _owner = self.owner.lock().map_err(storage)?;
        let controls = self.controls.lock().map_err(storage)?;
        let was_ready = self.ready.swap(false, Ordering::AcqRel);
        if !controls.is_empty()
            || !self.admission_io.lock().map_err(storage)?.is_empty()
            || self.admissions.available_permits() != 36
            || !handlers_idle()
        {
            self.ready.store(was_ready, Ordering::Release);
            return Err(error(
                "busy",
                "Image work must finish before snapshotting provider state",
            ));
        }
        if let Err(failure) = self.journal.checkpoint() {
            self.ready.store(was_ready, Ordering::Release);
            return Err(failure);
        }
        Ok(json!({"ready":false,"idle":true,"checkpoint":true}))
    }
    pub fn shutdown(&self) {
        for cancel in self
            .controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            cancel.store(true, Ordering::Release)
        }
        self.ready.store(false, Ordering::Release);
    }
    fn profile(&self, id: &str) -> Result<Profile> {
        self.profiles
            .read()?
            .profiles
            .into_iter()
            .find(|p| p.id() == id)
            .ok_or_else(|| invalid("Image connection no longer exists"))
    }
    fn credential(&self, profile: &Profile) -> Result<Option<String>> {
        let key = match profile.credential() {
            Credential::None | Credential::CliSavedLogin => return Ok(None),
            Credential::Environment { name } => std::env::var(name).map_err(|_| {
                error(
                    "unavailable",
                    "Image credential environment variable is absent",
                )
            })?,
            Credential::Secret { id } => self.host.call(
                "host.credentials.get",
                json!({"profileId":profile.id(),"id":id}),
                &AtomicBool::new(false),
            )?["key"]
                .as_str()
                .ok_or_else(|| error("unavailable", "Saved image credential is unavailable"))?
                .to_owned(),
        };
        if key.trim().is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
            return Err(error("unavailable", "Image credential is empty or invalid"));
        }
        Ok(Some(key))
    }
    pub fn sanitized(&self, configuration: Configuration) -> Result<Value> {
        let mut value = serde_json::to_value(&configuration).map_err(storage)?;
        for (profile, item) in configuration
            .profiles
            .iter()
            .zip(value["profiles"].as_array_mut().unwrap())
        {
            item["hasCredential"] = json!(match profile.credential() {
                Credential::None => false,
                Credential::CliSavedLogin => false,
                Credential::Environment { name } =>
                    std::env::var(name).is_ok_and(|s| !s.is_empty()),
                Credential::Secret { .. } => true,
            });
        }
        Ok(value)
    }
    pub fn describe(&self) -> Result<Value> {
        let configuration = self.profiles.read()?;
        let mut profiles = self.sanitized(configuration.clone())?["profiles"].take();
        for profile in profiles.as_array_mut().unwrap() {
            profile["capabilities"] = domain::capabilities(profile["transport"] == "codex-cli");
        }
        Ok(
            json!({"version":1,"configurationRevision":configuration.document_revision,"defaultConnectionId":configuration.default_connection_id,"profiles":profiles}),
        )
    }
    pub fn prepare(&self, caller: Caller, request: PrepareRequest) -> Result<Preparation> {
        domain::validate_prepare(&request)?;
        let profile = self.profile(&request.connection_id)?;
        let recipe = domain::recipe(&profile, &request)?;
        let preparation_token = nonce()?;
        let digest = recipe.digest();
        let mut tokens = self.preparations.lock().map_err(storage)?;
        tokens.retain(|_, p| p.expires > Instant::now());
        if tokens.len() >= 128 {
            return Err(error("busy", "Image preparation capacity reached"));
        }
        let semantic = domain::semantic(&StartRequest {
            operation_id: request.operation_id,
            connection_id: request.connection_id,
            expected_connection_revision: request.expected_connection_revision,
            preparation_token: preparation_token.clone(),
            effective_recipe_digest: digest.clone(),
            model: request.model,
            prompt: request.prompt,
            inputs: request.inputs,
            options: request.options,
        });
        tokens.insert(
            preparation_token.clone(),
            Prepared {
                caller,
                recipe: recipe.clone(),
                semantic,
                expires: Instant::now() + Duration::from_secs(300),
            },
        );
        Ok(Preparation {
            preparation_token,
            effective_recipe: recipe,
            effective_recipe_digest: digest,
        })
    }
    pub fn start(
        self: &Arc<Self>,
        caller: Caller,
        request: StartRequest,
        test: bool,
    ) -> Result<OperationStatus> {
        let semantic = domain::semantic(&request);
        if let Some(status) = self.visible(&caller.package_id, &request.operation_id, || {
            self.journal
                .get(&caller.package_id, &request.operation_id, Some(&semantic))
        })? {
            return Ok(status);
        }
        domain::validate_prepare(&request.prepared())?;
        if !valid_digest(&request.effective_recipe_digest) {
            return Err(invalid("Invalid prepared image recipe digest"));
        }
        match self.start_prepared(caller.clone(), request.clone(), test, semantic.clone()) {
            Ok(status) => Ok(status),
            Err(failure) if failure.code == "operation_conflict" => Err(failure),
            Err(failure) => self
                .visible(&caller.package_id, &request.operation_id, || {
                    self.journal
                        .reject(
                            &caller,
                            &request.operation_id,
                            &semantic,
                            &request.effective_recipe_digest,
                            failure,
                            test,
                        )
                        .map(Some)
                })?
                .ok_or_else(|| invalid("Image receipt disappeared")),
        }
    }
    fn start_prepared(
        self: &Arc<Self>,
        caller: Caller,
        request: StartRequest,
        test: bool,
        semantic: String,
    ) -> Result<OperationStatus> {
        let recipe = {
            let tokens = self.preparations.lock().map_err(storage)?;
            let prepared = tokens
                .get(&request.preparation_token)
                .ok_or_else(|| error("preparation_expired", "Prepare this image request again"))?;
            if prepared.expires <= Instant::now()
                || prepared.caller != caller
                || prepared.semantic != semantic
                || prepared.recipe.digest() != request.effective_recipe_digest
            {
                return Err(error(
                    "preparation_expired",
                    "Prepared image request expired or changed",
                ));
            }
            prepared.recipe.clone()
        };
        let profile = self.profile(&request.connection_id)?;
        if profile.revision() != request.expected_connection_revision {
            return Err(error(
                "configuration_changed",
                "Image connection changed; prepare again",
            ));
        }
        let mut admission_io = {
            let _controls = self.controls.lock().map_err(storage)?;
            if !self.ready() {
                return Err(error("unavailable", "Image service is quiesced"));
            }
            let permit = self
                .admissions
                .clone()
                .try_acquire_owned()
                .map_err(|_| error("busy", "Image execution queue is full"))?;
            let identity = (caller.package_id.clone(), request.operation_id.clone());
            *self
                .admission_io
                .lock()
                .map_err(storage)?
                .entry(identity.clone())
                .or_insert(0) += 1;
            AdmissionIo {
                service: self.clone(),
                identity,
                permit: Some(permit),
            }
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let mut paths = vec![];
        for artifact in &request.inputs {
            let read=self.host.call("host.artifacts.read",json!({"consumerPackageId":caller.package_id,"operationId":request.operation_id,"artifact":artifact}),&cancel)?;
            let returned: ArtifactDescriptor = serde_json::from_value(read["artifact"].clone())
                .map_err(|_| invalid("Host returned an invalid input grant"))?;
            if &returned != artifact {
                return Err(error(
                    "input_changed",
                    "Host input grant does not match the prepared descriptor",
                ));
            }
            paths.push(PathBuf::from(
                read["path"]
                    .as_str()
                    .ok_or_else(|| invalid("Host returned no captured input path"))?,
            ));
        }
        let key = self.credential(&profile)?;
        let (status, accepted) = self.profiles.admit(&profile, || {
            self.journal.accept_with_budget(
                &caller,
                &request.operation_id,
                &semantic,
                &recipe,
                test,
                self.operation_budget,
            )
        })?;
        if !accepted {
            // A concurrent duplicate won admission; report its external view.
            return self
                .visible(&caller.package_id, &request.operation_id, || {
                    self.journal
                        .get(&caller.package_id, &request.operation_id, Some(&semantic))
                })?
                .ok_or_else(|| invalid("Image receipt disappeared"));
        }
        if status.execution != (Execution::Accepted {}) {
            return Ok(status);
        }
        let deadline = self
            .journal
            .deadline(&caller.package_id, &request.operation_id)?;
        self.controls.lock().map_err(storage)?.insert(
            (caller.package_id.clone(), request.operation_id.clone()),
            cancel.clone(),
        );
        let admission = admission_io.permit.take().expect("owned admission lease");
        let (deadline_done, deadline_wait) = tokio::sync::oneshot::channel();
        self.watch_deadline(
            &caller.package_id,
            &request.operation_id,
            deadline,
            cancel.clone(),
            deadline_wait,
        );
        self.preparations
            .lock()
            .map_err(storage)?
            .remove(&request.preparation_token);
        if test {
            let begin=self.host.call("host.services.test.begin",json!({"operationId":request.operation_id,"effectiveRecipeDigest":request.effective_recipe_digest,"inputs":[]}),&cancel).and_then(|value|if value["accepted"]==true{Ok(())}else{Err(error("host_unavailable","Host did not accept the explicit image test"))});
            if let Err(failure) = begin {
                let failed =
                    self.journal
                        .fail_accepted(&caller.package_id, &request.operation_id, failure);
                let service = self.clone();
                let identity = (caller.package_id.clone(), request.operation_id.clone());
                let update = failed.as_ref().ok().cloned();
                tokio::spawn(async move {
                    if let Some(update) = update {
                        let host = service.host.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            let _ = host.call(
                                "host.services.test.update",
                                json!({"operationId":update.operation_id,"status":update}),
                                &AtomicBool::new(false),
                            );
                        })
                        .await;
                    }
                    drop(deadline_done);
                    let mut controls = service.controls.lock().unwrap_or_else(|e| e.into_inner());
                    drop(admission);
                    controls.remove(&identity);
                });
                return failed;
            }
        }
        let service = self.clone();
        tokio::spawn(async move {
            let slot = service.workers.clone().acquire_owned().await;
            let identity = (caller.package_id.clone(), request.operation_id.clone());
            let work = Work {
                caller,
                request,
                profile,
                recipe,
                key,
                paths,
                cancel,
                deadline,
                _deadline_done: deadline_done,
            };
            service.execute(work).await;
            // Receipt terminality can precede metadata IO completion. Host
            // recovery controls report idle only after actual IO and leases end.
            drop(slot);
            let mut controls = service.controls.lock().unwrap_or_else(|e| e.into_inner());
            drop(admission);
            controls.remove(&identity);
        });
        Ok(status)
    }
    fn watch_deadline(
        self: &Arc<Self>,
        caller: &str,
        operation: &str,
        deadline: i64,
        cancel: Arc<AtomicBool>,
        done: tokio::sync::oneshot::Receiver<()>,
    ) {
        let remaining = domain::remaining_budget(
            deadline,
            epoch_millis().unwrap_or(deadline),
            self.operation_budget,
        );
        let service = Arc::downgrade(self);
        let caller = caller.to_owned();
        let operation = operation.to_owned();
        tokio::spawn(async move {
            tokio::select! {
                _ = done => return,
                _ = tokio::time::sleep(remaining) => {},
            }
            if let Some(service) = service.upgrade() {
                // Register timer IO under the same admission/ownership gate.
                // A timer that already outlived its original Work does nothing;
                // one that won retains its own lease until actual DB IO ends.
                let lease = {
                    let Ok(controls) = service.controls.lock() else {
                        return;
                    };
                    let identity = (caller.clone(), operation.clone());
                    if !controls
                        .get(&identity)
                        .is_some_and(|flag| Arc::ptr_eq(flag, &cancel))
                    {
                        return;
                    }
                    let Ok(mut admissions) = service.admission_io.lock() else {
                        return;
                    };
                    *admissions.entry(identity.clone()).or_insert(0) += 1;
                    AdmissionIo {
                        service: service.clone(),
                        identity,
                        permit: None,
                    }
                };
                // Never drop a live blocking worker: cancellation requests a
                // durable stop and actual IO retains its worker/admission lease.
                let _ = tokio::task::spawn_blocking(move || {
                    let _lease = lease;
                    (service.before_deadline_cancel)();
                    let _ = service.journal.cancel(&caller, &operation);
                    cancel.store(true, Ordering::Release);
                })
                .await;
            }
        });
    }
    async fn execute(self: &Arc<Self>, work: Work) {
        let caller = work.caller.package_id.clone();
        let operation = work.request.operation_id.clone();
        let result = self.execute_inner(work).await;
        let status = match result {
            Ok(status) => Some(status),
            Err(failure) => self
                .journal
                .finish(
                    &caller,
                    &operation,
                    Execution::Unknown { error: failure },
                    Delivery::None {},
                    None,
                )
                .ok(),
        };
        if let Some(status) = status {
            let _ = self.host.event(
                "image-generation:operation-changed",
                json!({"consumerPackageId":caller,"status":status}),
            );
            if self.journal.is_test(&caller, &operation).unwrap_or(false) {
                let host = self.host.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    host.call(
                        "host.services.test.update",
                        json!({"operationId":operation,"status":status}),
                        &AtomicBool::new(false),
                    )
                })
                .await;
            }
        }
    }
    async fn execute_inner(self: &Arc<Self>, work: Work) -> Result<OperationStatus> {
        if !self
            .journal
            .claim(&work.caller.package_id, &work.request.operation_id)?
        {
            return self
                .journal
                .get(&work.caller.package_id, &work.request.operation_id, None)?
                .ok_or_else(|| invalid("Image receipt disappeared"));
        }
        let mut inputs = vec![];
        for (path, descriptor) in work.paths.iter().zip(&work.request.inputs) {
            match adapters::read_input(path, descriptor) {
                Ok(input) => inputs.push(input),
                Err(failure) => {
                    return self.journal.finish(
                        &work.caller.package_id,
                        &work.request.operation_id,
                        Execution::Failed { error: failure },
                        Delivery::None {},
                        None,
                    )
                }
            }
        }
        if epoch_millis()? >= work.deadline {
            let _ = self
                .journal
                .cancel(&work.caller.package_id, &work.request.operation_id);
            work.cancel.store(true, Ordering::Release);
        }
        if work.cancel.load(Ordering::Acquire) {
            return self.journal.finish(
                &work.caller.package_id,
                &work.request.operation_id,
                Execution::Cancelled {},
                Delivery::None {},
                None,
            );
        }
        let service = self.clone();
        let evidence_caller = work.caller.package_id.clone();
        let evidence_operation = work.request.operation_id.clone();
        let evidence: adapters::EvidenceSink = Arc::new(move |event| match event {
            adapters::Evidence::Turn(receipt) => {
                service
                    .journal
                    .turn_checkpoint(&evidence_caller, &evidence_operation, receipt)
            }
            adapters::Evidence::Failure { receipt, error } => {
                service
                    .journal
                    .turn_failure(&evidence_caller, &evidence_operation, receipt, error)
            }
        });
        let output = match adapters::generate(
            work.profile,
            work.recipe,
            inputs,
            work.key,
            self.host.clone(),
            work.cancel.clone(),
            evidence,
        )
        .await
        {
            Ok(output) => output,
            Err(failure) => {
                let uncertain = matches!(
                    failure.code.as_str(),
                    "cancelled_after_dispatch"
                        | "remote_outcome_unknown"
                        | "host_unavailable"
                        | "interrupted"
                        | "invalid_response"
                        | "storage_unavailable"
                );
                return self.journal.finish(
                    &work.caller.package_id,
                    &work.request.operation_id,
                    if uncertain {
                        Execution::Unknown { error: failure }
                    } else if failure.code == "cancelled" {
                        Execution::Cancelled {}
                    } else {
                        Execution::Failed { error: failure }
                    },
                    Delivery::None {},
                    None,
                );
            }
        };
        let sha = hex::encode(Sha256::digest(&output.bytes));
        // Readers keep seeing this running receipt until the seal outcome is
        // committed below; the guard outlives that final write on every path.
        let running = self
            .journal
            .get(&work.caller.package_id, &work.request.operation_id, None)?
            .ok_or_else(|| invalid("Image receipt disappeared"))?;
        let _unannounced =
            self.hold_unannounced(&work.caller.package_id, &work.request.operation_id, running)?;
        // Commit proven execution before stage allocation: stage/lifecycle IO
        // can fail or outlive generation's deadline without erasing paid success.
        // A crash from here on recovers this proof, never a second generation.
        self.journal.record_success(
            &work.caller.package_id,
            &work.request.operation_id,
            output.metadata.clone(),
            &sha,
        )?;
        let host = self.host.clone();
        let caller = work.caller.package_id.clone();
        let operation = work.request.operation_id.clone();
        let byte_length = output.bytes.len() as u64;
        let bytes = output.bytes;
        let expected_sha = sha.clone();
        let metadata = output.metadata.clone();
        let service = self.clone();
        let seal = tokio::task::spawn_blocking(move || {
            let stage = host.call(
                "host.artifacts.stage",
                json!({"consumerPackageId":caller,"operationId":operation}),
                &AtomicBool::new(false),
            )?;
            let handle = stage["handle"].as_str()
                .filter(|handle| !handle.is_empty())
                .ok_or_else(|| invalid("Host returned no output stage handle"))?;
            let path = PathBuf::from(stage["path"].as_str()
                .ok_or_else(|| invalid("Host returned no output stage"))?);
            let candidate = ArtifactDescriptor {handle: handle.into(), sha256: expected_sha.clone(), byte_length, media_type: "image/png".into()};
            // Persist proven execution and exact recovery identity before the
            // first sealing call. A lost reply cannot erase owned paid bytes.
            service.journal.seal_candidate(&caller, &operation, metadata, &candidate)?;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let mut file = options.open(path).map_err(storage)?;
            if !file.metadata().map_err(storage)?.is_file() {
                return Err(invalid("Host output stage must be a regular file"));
            }
            use std::io::Write;
            file.write_all(&bytes).map_err(storage)?;
            file.sync_all().map_err(storage)?;
            let value = host.call(
                "host.artifacts.seal",
                json!({"consumerPackageId":caller,"operationId":operation,"handle":handle,"mediaType":"image/png"}),
                &AtomicBool::new(false),
            )?;
            let descriptor: ArtifactDescriptor = serde_json::from_value(value)
                .map_err(|_| invalid("Host returned an invalid sealed image descriptor"))?;
            if descriptor.handle != handle || descriptor.sha256 != expected_sha
                || descriptor.byte_length != byte_length || descriptor.media_type != "image/png" {
                return Err(invalid("Host sealed image descriptor does not match the output"));
            }
            Ok(descriptor)
        }).await.unwrap_or_else(|_| Err(error("storage_unavailable", "Output sealing worker interrupted")));
        match seal {
            Ok(descriptor) => self.journal.delivery_restored(
                &work.caller.package_id,
                &work.request.operation_id,
                descriptor,
            ),
            Err(_) => self.journal.finish(
                &work.caller.package_id,
                &work.request.operation_id,
                Execution::Succeeded {
                    metadata: output.metadata,
                },
                Delivery::Unavailable {
                    reason: "storage_unavailable".into(),
                },
                Some(&sha),
            ),
        }
    }
    /// Register a proven success as unannounced before its proof is committed.
    fn hold_unannounced(
        self: &Arc<Self>,
        caller: &str,
        operation: &str,
        visible: OperationStatus,
    ) -> Result<Unannounced> {
        let identity: OperationKey = (caller.into(), operation.into());
        self.unannounced
            .lock()
            .map_err(storage)?
            .insert(identity.clone(), visible);
        Ok(Unannounced {
            service: self.clone(),
            identity,
        })
    }
    /// The externally visible receipt and whether it masks an unannounced
    /// success. The registry lock spans the durable read, so a reader observes
    /// either the pre-success receipt or the committed seal outcome, never the
    /// interim proof, and never a terminal receipt followed by a running one.
    fn observe(
        &self,
        caller: &str,
        operation: &str,
        read: impl FnOnce() -> Result<Option<OperationStatus>>,
    ) -> Result<Option<(OperationStatus, bool)>> {
        let unannounced = self.unannounced.lock().map_err(storage)?;
        let durable = read()?;
        Ok(durable.map(|durable| {
            match unannounced.get(&(caller.to_owned(), operation.to_owned())) {
                Some(visible) => (visible.clone(), true),
                None => (durable, false),
            }
        }))
    }
    fn visible(
        &self,
        caller: &str,
        operation: &str,
        read: impl FnOnce() -> Result<Option<OperationStatus>>,
    ) -> Result<Option<OperationStatus>> {
        Ok(self
            .observe(caller, operation, read)?
            .map(|(status, _)| status))
    }
    pub fn status(&self, caller: &str, operation: &str) -> Result<OperationStatus> {
        let (mut status, unannounced) = self
            .observe(caller, operation, || {
                self.journal.get(caller, operation, None)
            })?
            .ok_or_else(|| error("not_found", "Unknown image operation"))?;
        if !valid_operation_id(operation) {
            return Err(invalid("Invalid operation ID"));
        }
        // Candidate bytes may still be written/sealed by this original worker.
        // Recovery is local and unpaid, but must not race that owned byte IO.
        if unannounced
            || matches!(status.delivery, Delivery::Unavailable { .. })
                && self.operation_has_io(caller, operation)?
        {
            return Ok(status);
        }
        let descriptor = match &status.delivery {
            Delivery::Available { output } => Some(output.clone()),
            Delivery::Unavailable { .. } => self.journal.output_descriptor(caller, operation)?,
            _ => None,
        };
        let Some(output) = descriptor else {
            return Ok(status);
        };
        let read = self.host.call(
            "host.artifacts.read",
            json!({"consumerPackageId":caller,"operationId":operation,"artifact":output}),
            &AtomicBool::new(false),
        );
        match readback(&read, &output) {
            Readback::Intact => {
                if matches!(status.delivery, Delivery::Unavailable { .. }) {
                    status = self.journal.delivery_restored(caller, operation, output)?;
                }
            }
            // Status stays read-only for transient host conditions: durable
            // unavailability is already honest, durable availability is kept
            // and the caller is told to ask again.
            Readback::Transient => {
                if matches!(status.delivery, Delivery::Available { .. }) {
                    return Err(error(
                        "storage_unavailable",
                        "Sealed image output is temporarily unreadable; its delivery state is unchanged",
                    ));
                }
            }
            Readback::Lost(reason) => {
                // Only the original owned stage is retried. Native seal is
                // idempotent and checks proof, pins and bytes; never generate.
                let restored = self.host.call(
                    "host.artifacts.seal",
                    json!({"consumerPackageId":caller,"operationId":operation,"handle":output.handle,"mediaType":"image/png"}),
                    &AtomicBool::new(false),
                ).and_then(|value| serde_json::from_value::<ArtifactDescriptor>(value).map_err(|_| invalid("Invalid recovered image descriptor")))
                .ok().filter(|returned| returned == &output);
                status = match restored {
                    Some(restored) => self
                        .journal
                        .delivery_restored(caller, operation, restored)?,
                    None => self.journal.delivery_missing(caller, operation, reason)?,
                };
            }
        }
        Ok(status)
    }
    pub fn cancel(&self, caller: &str, operation: &str) -> Result<OperationStatus> {
        if !valid_operation_id(operation) {
            return Err(invalid("Invalid operation ID"));
        }
        if let Some(cancel) = self
            .controls
            .lock()
            .map_err(storage)?
            .get(&(caller.into(), operation.into()))
        {
            cancel.store(true, Ordering::Release)
        }
        // The request is still recorded durably; an unannounced success keeps
        // reading as running and its committed proof cannot be erased.
        self.visible(caller, operation, || {
            self.journal.cancel(caller, operation).map(Some)
        })?
        .ok_or_else(|| error("not_found", "Unknown image operation"))
    }
    /// Consumers can only acknowledge an announced success; the registry lock
    /// excludes a concurrent proof commit for the same operation.
    pub fn acknowledge(
        &self,
        caller: &str,
        operation: &str,
        sha: &str,
        disposition: &str,
        receipt: Option<&str>,
    ) -> Result<OperationStatus> {
        let unannounced = self.unannounced.lock().map_err(storage)?;
        if unannounced.contains_key(&(caller.to_owned(), operation.to_owned())) {
            return Err(error(
                "invalid_request",
                "Only a successful result can be acknowledged",
            ));
        }
        self.journal
            .acknowledge(caller, operation, sha, disposition, receipt)
    }
    pub fn operation_idle(&self, caller: &str, operation: &str) -> Result<bool> {
        if !self.ready() {
            return Err(error(
                "unavailable",
                "Image service activation is not ready",
            ));
        }
        if !domain::id(caller) || !valid_operation_id(operation) {
            return Err(invalid("Invalid operation owner or ID"));
        }
        Ok(!self.operation_has_io(caller, operation)?)
    }
    fn operation_has_io(&self, caller: &str, operation: &str) -> Result<bool> {
        let identity = (caller.into(), operation.into());
        let controls = self.controls.lock().map_err(storage)?;
        Ok(controls.contains_key(&identity)
            || self
                .admission_io
                .lock()
                .map_err(storage)?
                .contains_key(&identity))
    }
    /// Native-host-only user discard uses the original durable output digest,
    /// including successful results whose original seal reply was unavailable.
    pub fn discard_operation(&self, caller: &str, operation: &str) -> Result<OperationStatus> {
        if !self.ready() {
            return Err(error(
                "unavailable",
                "Image service activation is not ready",
            ));
        }
        if !domain::id(caller) || !valid_operation_id(operation) {
            return Err(invalid("Invalid operation owner or ID"));
        }
        let before = self
            .visible(caller, operation, || {
                self.journal.get(caller, operation, None)
            })?
            .ok_or_else(|| error("not_found", "Unknown image operation"))?;
        if !matches!(before.execution, Execution::Succeeded { .. }) {
            return Err(invalid("Only a proven successful image may be discarded"));
        }
        let sha = self
            .journal
            .output_sha256(caller, operation)?
            .ok_or_else(|| {
                error(
                    "storage_unavailable",
                    "Successful image digest is unavailable",
                )
            })?;
        let status = self.acknowledge(caller, operation, &sha, "discarded", None)?;
        let _ = self.host.event(
            "image-generation:operation-changed",
            json!({"consumerPackageId":caller,"status":status}),
        );
        Ok(status)
    }
    fn changed(&self, configuration: &Configuration, affected: Vec<String>) {
        let _=self.host.event("image-generation:configuration-changed",json!({"documentRevision":configuration.document_revision,"affectedProfileIds":affected}));
    }
    pub fn settings(self: &Arc<Self>, method: &str, params: Value) -> Result<Value> {
        match method {
            "read" => self.sanitized(self.profiles.read()?),
            "save" => {
                let previous = self.profiles.read()?;
                let expected = number(&params, "expectedRevision")?;
                if previous.document_revision != expected {
                    return Err(error(
                        "configuration_changed",
                        "Image connections changed before saving",
                    ));
                }
                let mut value = params["configuration"].clone();
                if let Some(profiles) = value["profiles"].as_array_mut() {
                    for profile in profiles {
                        if let Some(p) = profile.as_object_mut() {
                            p.remove("hasCredential");
                            p.remove("capabilities");
                        }
                    }
                }
                let configuration: Configuration = serde_json::from_value(value)
                    .map_err(|_| invalid("Malformed image configuration"))?;
                let affected = configuration
                    .profiles
                    .iter()
                    .map(|p| p.id().into())
                    .collect();
                let saved = self.profiles.save(configuration, expected, None, None)?;
                for old in &previous.profiles {
                    if let Credential::Secret { id } = old.credential() {
                        if saved
                            .profiles
                            .iter()
                            .all(|p| p.id() != old.id() || p.credential() != old.credential())
                        {
                            let _ = self.host.call(
                                "host.credentials.remove",
                                json!({"profileId":old.id(),"id":id}),
                                &AtomicBool::new(false),
                            );
                        }
                    }
                }
                self.changed(&saved, affected);
                self.sanitized(saved)
            }
            "credential.set" | "credential.clear" => {
                let profile_id = text(&params, "profileId")?;
                let expected = number(&params, "expectedRevision")?;
                let configuration = self.profiles.read()?;
                if configuration.document_revision != expected {
                    return Err(error(
                        "configuration_changed",
                        "Image connections changed before rotating credentials",
                    ));
                }
                let old = configuration
                    .profiles
                    .iter()
                    .find(|profile| profile.id() == profile_id)
                    .cloned()
                    .ok_or_else(|| invalid("Unknown image profile"))?;
                let credential = if method == "credential.set" {
                    let key = text(&params, "key")?;
                    if key.trim().is_empty()
                        || key.len() > 4096
                        || key.chars().any(char::is_control)
                    {
                        return Err(invalid("Enter a nonempty bounded API key"));
                    }
                    let value = self.host.call(
                        "host.credentials.put",
                        json!({"profileId":profile_id,"key":key}),
                        &AtomicBool::new(false),
                    )?;
                    Credential::Secret {
                        id: value["id"]
                            .as_str()
                            .ok_or_else(|| invalid("Host returned no secret reference"))?
                            .into(),
                    }
                } else {
                    Credential::None
                };
                let result = self
                    .profiles
                    .rotate(&profile_id, credential.clone(), expected);
                if result
                    .as_ref()
                    .is_err_and(|failure| failure.code != "mutation_uncertain")
                {
                    if let Credential::Secret { id } = &credential {
                        let _ = self.host.call(
                            "host.credentials.remove",
                            json!({"profileId":profile_id,"id":id}),
                            &AtomicBool::new(false),
                        );
                    }
                }
                let saved = result?;
                if let Credential::Secret { id } = old.credential() {
                    let _ = self.host.call(
                        "host.credentials.remove",
                        json!({"profileId":profile_id,"id":id}),
                        &AtomicBool::new(false),
                    );
                }
                self.changed(&saved, vec![profile_id]);
                self.sanitized(saved)
            }
            "check" => {
                let profile = self.profile(&text(&params, "profileId")?)?;
                let result = match &profile {
                    Profile::Codex {
                        executable_path, ..
                    } => adapters::check_cli(executable_path),
                    _ => self.credential(&profile).map(|_| ()),
                };
                Ok(match result {
                    Ok(()) => json!({"available":true}),
                    Err(error) => json!({"available":false,"error":error}),
                })
            }
            "test" => self.test(params),
            "test.status" => Ok(serde_json::to_value(
                self.status("xnmp.image-generation", &text(&params, "requestId")?)?,
            )
            .map_err(storage)?),
            "cancelTest" => Ok(serde_json::to_value(
                self.cancel("xnmp.image-generation", &text(&params, "requestId")?)?,
            )
            .map_err(storage)?),
            "test.discard" => {
                let operation = text(&params, "requestId")?;
                self.status("xnmp.image-generation", &operation)?;
                let sha = self
                    .journal
                    .output_sha256("xnmp.image-generation", &operation)?
                    .ok_or_else(|| invalid("Successful test output required for discard"))?;
                let status =
                    self.acknowledge("xnmp.image-generation", &operation, &sha, "discarded", None)?;
                self.host.call(
                    "host.services.test.update",
                    json!({"operationId":operation,"status":status}),
                    &AtomicBool::new(false),
                )?;
                Ok(serde_json::to_value(status).map_err(storage)?)
            }
            _ => Err(error(
                "method_not_found",
                "Unknown private image settings method",
            )),
        }
    }
    pub fn migration(&self, method: &str, params: Value) -> Result<Value> {
        match method {
            "status" => self.profiles.import_status(&text(&params, "sourceId")?),
            "import" => {
                let receipt = self.profiles.import(&params)?;
                let configuration = self.profiles.read()?;
                self.changed(
                    &configuration,
                    receipt["profileIds"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|id| id.as_str().map(str::to_owned))
                        .collect(),
                );
                Ok(receipt)
            }
            _ => Err(error(
                "method_not_found",
                "Unknown host image migration method",
            )),
        }
    }
    fn test(self: &Arc<Self>, params: Value) -> Result<Value> {
        let operation = text(&params, "requestId")?;
        if let Some(status) = self.visible("xnmp.image-generation", &operation, || {
            self.journal.get("xnmp.image-generation", &operation, None)
        })? {
            return serde_json::to_value(status).map_err(storage);
        }
        let configuration = self.profiles.read()?;
        if configuration.document_revision != number(&params, "expectedConfigurationRevision")? {
            return Err(error(
                "configuration_changed",
                "Image settings changed before testing",
            ));
        }
        let profile = self.profile(&text(&params, "profileId")?)?;
        let context = self.host.call(
            "host.services.test.context",
            json!({}),
            &AtomicBool::new(false),
        )?;
        let caller: Caller = serde_json::from_value(context["caller"].clone())
            .map_err(|_| invalid("Host returned no private settings caller"))?;
        if caller.package_id != "xnmp.image-generation" {
            return Err(invalid("Invalid private settings caller owner"));
        }
        let prepared = PrepareRequest {
            operation_id: operation.clone(),
            connection_id: profile.id().into(),
            expected_connection_revision: profile.revision().into(),
            model: match &profile {
                Profile::Http { default_model, .. } => Some(default_model.clone()),
                _ => None,
            },
            prompt: "Create a simple solid blue square, without text.".into(),
            inputs: vec![],
            options: ImageOptions {
                size: "1024x1024".into(),
                resolution: None,
                aspect_ratio: None,
                quality: if matches!(profile, Profile::Http { .. }) {
                    "low"
                } else {
                    "auto"
                }
                .into(),
                background: "auto".into(),
            },
        };
        let preparation = self.prepare(caller.clone(), prepared.clone())?;

        let request = StartRequest {
            operation_id: prepared.operation_id,
            connection_id: prepared.connection_id,
            expected_connection_revision: prepared.expected_connection_revision,
            model: prepared.model,
            prompt: prepared.prompt,
            inputs: prepared.inputs,
            options: prepared.options,
            preparation_token: preparation.preparation_token,
            effective_recipe_digest: preparation.effective_recipe_digest,
        };
        serde_json::to_value(self.start(caller, request, true)?).map_err(storage)
    }
}
pub fn text(value: &Value, name: &str) -> Result<String> {
    value[name]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid("Missing or invalid string parameter"))
}
pub fn number(value: &Value, name: &str) -> Result<u64> {
    value[name]
        .as_u64()
        .ok_or_else(|| invalid("Missing or invalid revision parameter"))
}
