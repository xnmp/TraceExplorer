//! Durable provider receipts. Every transaction ends before external IO.
use crate::domain::stored_receipt::{StoredReceipt, MAX_RECIPE, MAX_STATUS};
use crate::error::{error, storage, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use te_image_generation_contract::{
    Caller, Delivery, EffectiveRecipe, Execution, OperationStatus, ProviderIdentity,
};
pub struct Journal {
    connection: Mutex<Connection>,
    directory: PathBuf,
    fresh: bool,
}
impl Journal {
    pub fn open(directory: &Path) -> Result<Self> {
        let path = directory.join("operations.sqlite");
        let initialized = initialized_marker(directory)?;
        // Only the initialization marker proves receipts once existed. An owner
        // lock, or an empty database left by an interrupted first activation,
        // is a fresh journal that activation may (re)create.
        let empty = || -> Result<(Connection, bool)> {
            let connection = Connection::open_in_memory().map_err(storage)?;
            schema(&connection)?;
            Ok((connection, true))
        };
        let (connection, fresh) = match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if initialized {
                    return Err(error("unavailable", "Image operation journal is missing; restore its original receipts before using generation"));
                }
                empty()?
            }
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                let connection =
                    Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                        .map_err(storage)?;
                if !initialized && never_initialized(&connection)? {
                    drop(connection);
                    empty()?
                } else {
                    validate_schema(&connection)?;
                    (connection, false)
                }
            }
            _ => {
                return Err(error(
                    "unavailable",
                    "Image operation journal must be a regular private file",
                ))
            }
        };
        Ok(Self {
            connection: Mutex::new(connection),
            directory: directory.into(),
            fresh,
        })
    }
    pub fn activate(&self) -> Result<()> {
        for name in [
            "operations.sqlite",
            "operations.sqlite-wal",
            "operations.sqlite-shm",
        ] {
            if std::fs::symlink_metadata(self.directory.join(name))
                .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
            {
                return Err(error(
                    "unavailable",
                    "Image journal files must be regular private files",
                ));
            }
        }
        let path = self.directory.join("operations.sqlite");
        let exists = path.try_exists().map_err(storage)?;
        let initialized = initialized_marker(&self.directory)?;
        if !exists && (!self.fresh || initialized) {
            return Err(error(
                "unavailable",
                "Image operation journal disappeared; restore the original receipts",
            ));
        }
        let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | if exists {
                rusqlite::OpenFlags::empty()
            } else {
                rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            };
        let connection = Connection::open_with_flags(&path, flags).map_err(storage)?;
        // Existing databases are validated before any write. Schema loss is
        // corruption, never an excuse to recreate idempotency evidence; only a
        // database that never committed a schema, before the marker, is fresh.
        let version = if exists && (initialized || !never_initialized(&connection)?) {
            Some(validate_schema(&connection)?)
        } else {
            None
        };
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
            )
            .map_err(storage)?;
        match version {
            None => schema(&connection)?,
            Some(1) => connection.execute_batch("BEGIN IMMEDIATE; ALTER TABLE operations ADD COLUMN admitted_at_ms INTEGER NOT NULL DEFAULT 0; ALTER TABLE operations ADD COLUMN deadline_at_ms INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=2; COMMIT;").map_err(storage)?,
            Some(2) => {},
            _ => unreachable!(),
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(storage)?;
        }
        mark_initialized(&self.directory)?;
        *self.connection.lock().map_err(storage)? = connection;
        Ok(())
    }
    pub fn get(
        &self,
        caller: &str,
        operation: &str,
        semantic: Option<&str>,
    ) -> Result<Option<OperationStatus>> {
        let connection = self.connection.lock().map_err(storage)?;
        load_receipt(&connection, caller, operation)?
            .map(|stored| {
                if semantic.is_some_and(|supplied| supplied != stored.semantic) {
                    return Err(error(
                        "operation_conflict",
                        "Operation ID belongs to a different image request",
                    ));
                }
                Ok(stored.status)
            })
            .transpose()
    }

    pub fn accept(
        &self,
        caller: &Caller,
        operation: &str,
        semantic: &str,
        recipe: &EffectiveRecipe,
        test: bool,
    ) -> Result<(OperationStatus, bool)> {
        self.accept_with_budget(
            caller,
            operation,
            semantic,
            recipe,
            test,
            Duration::from_secs(900),
        )
    }
    pub fn accept_with_budget(
        &self,
        caller: &Caller,
        operation: &str,
        semantic: &str,
        recipe: &EffectiveRecipe,
        test: bool,
        budget: Duration,
    ) -> Result<(OperationStatus, bool)> {
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection.transaction().map_err(storage)?;
        if let Some(stored) = load_receipt(&transaction, &caller.package_id, operation)? {
            if stored.semantic != semantic {
                return Err(error(
                    "operation_conflict",
                    "Operation ID belongs to a different image request",
                ));
            }
            return Ok((stored.status, false));
        }
        let cancelled = transaction
            .query_row(
                "SELECT 1 FROM cancellations WHERE caller=? AND operation=?",
                params![caller.package_id, operation],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage)?
            .is_some();
        let status = OperationStatus {
            version: 1,
            operation_id: operation.into(),
            request_fingerprint: recipe.digest(),
            provider: ProviderIdentity {
                package_id: "xnmp.image-generation".into(),
                service_id: "image-generation".into(),
                major: 1,
            },
            revision: 1,
            execution: if cancelled {
                Execution::Cancelled {}
            } else {
                Execution::Accepted {}
            },
            delivery: Delivery::None {},
            diagnostics: None,
        };
        let admitted_at = epoch_millis()?;
        let deadline_at = admitted_at
            .checked_add(i64::try_from(budget.as_millis()).map_err(storage)?)
            .ok_or_else(|| {
                error(
                    "unavailable",
                    "Image operation deadline exceeds storage bounds",
                )
            })?;
        transaction.execute("INSERT INTO operations(caller,operation,semantic,context,recipe,status,test,admitted_at_ms,deadline_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",params![caller.package_id,operation,semantic,serde_json::to_string(caller).map_err(storage)?,serde_json::to_string(recipe).map_err(storage)?,serde_json::to_string(&status).map_err(storage)?,test,admitted_at,deadline_at]).map_err(storage)?;
        load_receipt(&transaction, &caller.package_id, operation)?;
        transaction.commit().map_err(storage)?;
        Ok((status, true))
    }
    /// Admission rejection is authoritative and retryable only with a new operation ID.
    /// A concurrent existing receipt always wins; no accepted execution can be overwritten.
    pub fn reject(
        &self,
        caller: &Caller,
        operation: &str,
        semantic: &str,
        fingerprint: &str,
        failure: te_image_generation_contract::SafeError,
        test: bool,
    ) -> Result<OperationStatus> {
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection.transaction().map_err(storage)?;
        if let Some(stored) = load_receipt(&transaction, &caller.package_id, operation)? {
            if stored.semantic != semantic {
                return Err(error(
                    "operation_conflict",
                    "Operation ID belongs to a different image request",
                ));
            }
            return Ok(stored.status);
        }
        let status = OperationStatus {
            version: 1,
            operation_id: operation.into(),
            request_fingerprint: fingerprint.into(),
            provider: ProviderIdentity {
                package_id: "xnmp.image-generation".into(),
                service_id: "image-generation".into(),
                major: 1,
            },
            revision: 1,
            execution: Execution::Failed { error: failure },
            delivery: Delivery::None {},
            diagnostics: None,
        };
        transaction.execute(
            "INSERT INTO operations(caller,operation,semantic,context,recipe,status,test,admitted_at_ms,deadline_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
            params![caller.package_id, operation, semantic, serde_json::to_string(caller).map_err(storage)?, "null", serde_json::to_string(&status).map_err(storage)?, test, 0, 0],
        ).map_err(storage)?;
        load_receipt(&transaction, &caller.package_id, operation)?;
        transaction.commit().map_err(storage)?;
        Ok(status)
    }
    pub fn deadline(&self, caller: &str, operation: &str) -> Result<i64> {
        let connection = self.connection.lock().map_err(storage)?;
        load_receipt(&connection, caller, operation)?
            .map(|stored| stored.deadline)
            .ok_or_else(|| error("not_found", "Unknown image operation"))
    }
    fn change(
        &self,
        caller: &str,
        operation: &str,
        update: impl FnOnce(&mut OperationStatus, bool) -> Result<bool>,
    ) -> Result<(OperationStatus, bool)> {
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection.transaction().map_err(storage)?;
        let stored = load_receipt(&transaction, caller, operation)?
            .ok_or_else(|| error("not_found", "Unknown image operation"))?;
        let cancel = stored.cancelled;
        let mut status = stored.status;
        let changed = update(&mut status, cancel)?;
        if changed {
            status.revision = status
                .revision
                .checked_add(1)
                .ok_or_else(|| error("unavailable", "Operation revision exhausted"))?;
            transaction
                .execute(
                    "UPDATE operations SET status=? WHERE caller=? AND operation=?",
                    params![
                        serde_json::to_string(&status).map_err(storage)?,
                        caller,
                        operation
                    ],
                )
                .map_err(storage)?;
        }
        load_receipt(&transaction, caller, operation)?;
        transaction.commit().map_err(storage)?;
        Ok((status, changed))
    }
    pub fn claim(&self, caller: &str, operation: &str) -> Result<bool> {
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection.transaction().map_err(storage)?;
        let stored = load_receipt(&transaction, caller, operation)?
            .ok_or_else(|| error("not_found", "Unknown image operation"))?;
        let cancel = stored.cancelled;
        let deadline = stored.deadline;
        let mut status = stored.status;
        if status.execution != (Execution::Accepted {}) {
            return Ok(false);
        }
        let expired = epoch_millis()? >= deadline;
        if expired {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO cancellations(caller,operation) VALUES(?,?)",
                    params![caller, operation],
                )
                .map_err(storage)?;
        }
        status.execution = if cancel || expired {
            Execution::Cancelled {}
        } else {
            Execution::Running {}
        };
        status.revision += 1;
        transaction
            .execute(
                "UPDATE operations SET status=?,cancel_requested=? WHERE caller=? AND operation=?",
                params![
                    serde_json::to_string(&status).map_err(storage)?,
                    cancel || expired,
                    caller,
                    operation
                ],
            )
            .map_err(storage)?;
        load_receipt(&transaction, caller, operation)?;
        transaction.commit().map_err(storage)?;
        Ok(status.execution == (Execution::Running {}))
    }
    pub fn cancel(&self, caller: &str, operation: &str) -> Result<OperationStatus> {
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection.transaction().map_err(storage)?;
        let stored = load_receipt(&transaction, caller, operation)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO cancellations(caller,operation) VALUES(?,?)",
                params![caller, operation],
            )
            .map_err(storage)?;
        let Some(mut stored) = stored else {
            transaction.commit().map_err(storage)?;
            return Err(error("not_found", "Unknown image operation"));
        };
        if stored.status.execution == (Execution::Accepted {}) {
            stored.status.execution = Execution::Cancelled {};
            stored.status.revision += 1;
        }
        let cancel = stored.cancelled
            || matches!(
                stored.status.execution,
                Execution::Running {} | Execution::Cancelled {}
            );
        transaction
            .execute(
                "UPDATE operations SET status=?,cancel_requested=? WHERE caller=? AND operation=?",
                params![
                    serde_json::to_string(&stored.status).map_err(storage)?,
                    cancel,
                    caller,
                    operation
                ],
            )
            .map_err(storage)?;
        load_receipt(&transaction, caller, operation)?;
        transaction.commit().map_err(storage)?;
        Ok(stored.status)
    }
    pub fn fail_accepted(
        &self,
        caller: &str,
        operation: &str,
        failure: te_image_generation_contract::SafeError,
    ) -> Result<OperationStatus> {
        Ok(self
            .change(caller, operation, |status, _| {
                if status.execution == (Execution::Accepted {}) {
                    status.execution = Execution::Failed { error: failure };
                    Ok(true)
                } else {
                    Ok(false)
                }
            })?
            .0)
    }
    pub fn turn_checkpoint(
        &self,
        caller: &str,
        operation: &str,
        receipt: te_image_generation_contract::OperationDiagnostics,
    ) -> Result<()> {
        use crate::domain::codex_evidence::same_turn;
        let te_image_generation_contract::OperationDiagnostics::CodexImageTurn {
            explanation, ..
        } = &receipt;
        if !receipt.valid(false) || explanation.is_some() {
            return Err(error("invalid_response", "Invalid Codex turn receipt"));
        }
        self.change(caller, operation, |status, _| {
            if status.execution != (Execution::Running {}) {
                return Err(error(
                    "operation_conflict",
                    "Image turn is no longer running",
                ));
            }
            if let Some(previous) = &status.diagnostics {
                if !same_turn(previous, &receipt) {
                    return Err(error("operation_conflict", "Image turn identity changed"));
                }
                return Ok(false);
            }
            status.diagnostics = Some(receipt);
            Ok(true)
        })?;
        Ok(())
    }
    pub fn turn_failure(
        &self,
        caller: &str,
        operation: &str,
        receipt: te_image_generation_contract::OperationDiagnostics,
        failure: te_image_generation_contract::SafeError,
    ) -> Result<()> {
        if !receipt.valid(false) {
            return Err(error("invalid_response", "Invalid Codex failure receipt"));
        }
        self.change(caller, operation, |status, _| {
            if status.execution != (Execution::Running {}) {
                return Ok(false);
            }
            if !status
                .diagnostics
                .as_ref()
                .is_some_and(|before| crate::domain::codex_evidence::same_turn(before, &receipt))
            {
                return Err(error("operation_conflict", "Image turn identity changed"));
            }
            status.diagnostics = Some(receipt);
            status.execution = Execution::Unknown { error: failure };
            status.delivery = Delivery::None {};
            Ok(true)
        })?;
        Ok(())
    }
    pub fn finish(
        &self,
        caller: &str,
        operation: &str,
        execution: Execution,
        delivery: Delivery,
        sha256: Option<&str>,
    ) -> Result<OperationStatus> {
        self.finish_with_candidate(caller, operation, execution, delivery, sha256, None)
    }
    /// Persist validated provider success before any host stage/byte handoff IO.
    /// This immutable proof survives a deadline, lost stage reply or crash; only
    /// delivery availability may subsequently change, never paid execution.
    pub fn record_success(
        &self,
        caller: &str,
        operation: &str,
        metadata: te_image_generation_contract::ImageMetadata,
        sha256: &str,
    ) -> Result<OperationStatus> {
        let execution = Execution::Succeeded { metadata };
        let status = self.finish(
            caller,
            operation,
            execution.clone(),
            Delivery::Unavailable {
                reason: "storage_unavailable".into(),
            },
            Some(sha256),
        )?;
        if status.execution != execution
            || self.output_sha256(caller, operation)?.as_deref() != Some(sha256)
        {
            return Err(error(
                "operation_conflict",
                "Successful output conflicts with durable execution proof",
            ));
        }
        Ok(status)
    }
    pub fn seal_candidate(
        &self,
        caller: &str,
        operation: &str,
        metadata: te_image_generation_contract::ImageMetadata,
        candidate: &te_image_generation_contract::ArtifactDescriptor,
    ) -> Result<OperationStatus> {
        self.finish_with_candidate(
            caller,
            operation,
            Execution::Succeeded { metadata },
            Delivery::Unavailable {
                reason: "storage_unavailable".into(),
            },
            Some(&candidate.sha256),
            Some(candidate),
        )
    }
    fn finish_with_candidate(
        &self,
        caller: &str,
        operation: &str,
        execution: Execution,
        delivery: Delivery,
        sha256: Option<&str>,
        candidate: Option<&te_image_generation_contract::ArtifactDescriptor>,
    ) -> Result<OperationStatus> {
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection.transaction().map_err(storage)?;
        let stored = load_receipt(&transaction, caller, operation)?
            .ok_or_else(|| error("not_found", "Unknown image operation"))?;
        let mut status = stored.status;
        if status.execution == (Execution::Running {}) {
            status.execution = execution;
            status.delivery = delivery;
            status.revision += 1;
            transaction
                .execute(
                    "UPDATE operations SET status=?,output_sha256=?,output_descriptor=? WHERE caller=? AND operation=?",
                    params![
                        serde_json::to_string(&status).map_err(storage)?,
                        sha256,
                        match candidate {Some(output)=>Some(serde_json::to_string(output).map_err(storage)?),None=>match &status.delivery {Delivery::Available{output}=>Some(serde_json::to_string(output).map_err(storage)?),_=>None}},
                        caller,
                        operation
                    ],
                )
                .map_err(storage)?;
        } else if let Some(candidate) = candidate {
            if status.execution != execution
                || stored.output_sha.as_deref() != sha256
                || !matches!(
                    status.delivery,
                    Delivery::Unavailable { .. } | Delivery::Available { .. }
                )
            {
                return Err(error(
                    "operation_conflict",
                    "Output candidate conflicts with its successful operation or disposition",
                ));
            }
            match stored.output {
                Some(previous) if previous == *candidate => {}
                Some(_) => {
                    return Err(error(
                        "operation_conflict",
                        "The successful operation already owns a different output candidate",
                    ))
                }
                None if matches!(status.delivery, Delivery::Unavailable { .. }) => {
                    // Attach only this operation's first immutable candidate. The
                    // SHA/execution proof was already committed before stage IO.
                    status.revision = status
                        .revision
                        .checked_add(1)
                        .ok_or_else(|| error("unavailable", "Operation revision exhausted"))?;
                    transaction.execute("UPDATE operations SET status=?,output_descriptor=? WHERE caller=? AND operation=?",params![serde_json::to_string(&status).map_err(storage)?,serde_json::to_string(candidate).map_err(storage)?,caller,operation]).map_err(storage)?;
                }
                None => {
                    return Err(error(
                        "operation_conflict",
                        "Successful output candidate is missing",
                    ))
                }
            }
        }
        load_receipt(&transaction, caller, operation)?;
        transaction.commit().map_err(storage)?;
        Ok(status)
    }

    pub fn acknowledge(
        &self,
        caller: &str,
        operation: &str,
        sha: &str,
        disposition: &str,
        receipt: Option<&str>,
    ) -> Result<OperationStatus> {
        let expected = self.output_sha256(caller, operation)?;
        if expected.as_deref() != Some(sha) {
            return Err(error(
                "operation_conflict",
                "Output digest does not match the successful operation",
            ));
        }
        Ok(self
            .change(caller, operation, |status, _| {
                if !matches!(status.execution, Execution::Succeeded { .. }) {
                    return Err(error(
                        "invalid_request",
                        "Only a successful result can be acknowledged",
                    ));
                }
                let next = match disposition {
                    "acquired" => Delivery::Acquired {
                        transfer_receipt: receipt
                            .filter(|r| !r.is_empty() && r.len() <= 128)
                            .ok_or_else(|| {
                                error("invalid_request", "Acquisition requires a transfer receipt")
                            })?
                            .into(),
                    },
                    "discarded" => Delivery::Discarded {},
                    _ => return Err(error("invalid_request", "Invalid output disposition")),
                };
                if matches!(
                    status.delivery,
                    Delivery::Acquired { .. } | Delivery::Discarded {}
                ) {
                    if status.delivery != next {
                        return Err(error(
                            "operation_conflict",
                            "Output already has another disposition",
                        ));
                    }
                    return Ok(false);
                }
                status.delivery = next;
                Ok(true)
            })?
            .0)
    }
    pub fn output_descriptor(
        &self,
        caller: &str,
        operation: &str,
    ) -> Result<Option<te_image_generation_contract::ArtifactDescriptor>> {
        let connection = self.connection.lock().map_err(storage)?;
        Ok(load_receipt(&connection, caller, operation)?.and_then(|stored| stored.output))
    }
    pub fn output_sha256(&self, caller: &str, operation: &str) -> Result<Option<String>> {
        let connection = self.connection.lock().map_err(storage)?;
        Ok(load_receipt(&connection, caller, operation)?.and_then(|stored| stored.output_sha))
    }
    pub fn delivery_restored(
        &self,
        caller: &str,
        operation: &str,
        output: te_image_generation_contract::ArtifactDescriptor,
    ) -> Result<OperationStatus> {
        Ok(self
            .change(caller, operation, |status, _| {
                if matches!(status.delivery, Delivery::Unavailable { .. })
                    && matches!(status.execution, Execution::Succeeded { .. })
                {
                    status.delivery = Delivery::Available { output };
                    Ok(true)
                } else {
                    Ok(false)
                }
            })?
            .0)
    }
    pub fn delivery_missing(
        &self,
        caller: &str,
        operation: &str,
        reason: &str,
    ) -> Result<OperationStatus> {
        Ok(self
            .change(caller, operation, |status, _| {
                if matches!(status.delivery, Delivery::Available { .. }) || matches!(&status.delivery,Delivery::Unavailable{reason:previous} if previous != reason) {
                    status.delivery = Delivery::Unavailable {
                        reason: reason.into(),
                    };
                    Ok(true)
                } else {
                    Ok(false)
                }
            })?
            .0)
    }
    pub fn recover(&self) -> Result<Vec<(String, OperationStatus, bool)>> {
        let rows = {
            let connection = self.connection.lock().map_err(storage)?;
            let version: i64 = connection
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .map_err(storage)?;
            let mut statement = connection
                .prepare(&receipt_query(version))
                .map_err(storage)?;
            let mut cursor = statement.query([]).map_err(storage)?;
            let mut records = Vec::new();
            while let Some(row) = cursor.next().map_err(storage)? {
                let stored = decode_receipt(row)?;
                if matches!(
                    stored.status.execution,
                    Execution::Accepted {} | Execution::Running {}
                ) {
                    if records.len() == 36 {
                        return Err(corrupt_receipt());
                    }
                    records.push((stored.caller, stored.operation, stored.test));
                }
            }
            records
        };
        let mut recovered = vec![];
        for (caller, operation, test) in rows {
            let(status,changed)=self.change(&caller,&operation,|status,_|{match status.execution{Execution::Accepted {}=>{status.execution=Execution::Cancelled {};Ok(true)},Execution::Running {}=>{status.execution=Execution::Unknown{error:error("interrupted","Image execution was interrupted; it will not be submitted again automatically")};Ok(true)},_=>Ok(false)}})?;
            if changed {
                recovered.push((caller, status, test))
            }
        }
        Ok(recovered)
    }

    pub fn is_test(&self, caller: &str, operation: &str) -> Result<bool> {
        let connection = self.connection.lock().map_err(storage)?;
        load_receipt(&connection, caller, operation)?
            .map(|stored| stored.test)
            .ok_or_else(|| error("not_found", "Unknown image operation"))
    }
    pub fn checkpoint(&self) -> Result<()> {
        let (busy, log, checkpointed): (i64, i64, i64) = self
            .connection
            .lock()
            .map_err(storage)?
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(storage)?;
        if busy != 0 || log != checkpointed {
            return Err(error(
                "busy",
                "Image journal checkpoint is blocked by an active reader or writer",
            ));
        }
        Ok(())
    }
}

pub fn epoch_millis() -> Result<i64> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(storage)?
            .as_millis(),
    )
    .map_err(storage)
}

const INITIALIZED: &[u8] = b"image-generation-operations-v1\n";
fn initialized_marker(directory: &Path) -> Result<bool> {
    let path = directory.join("operations.initialized");
    if matches!(std::fs::symlink_metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(false);
    }
    let bytes = crate::adapters::read_regular(&path, 128)?;
    if bytes != INITIALIZED {
        return Err(error(
            "unavailable",
            "Image operation journal initialization marker is invalid or unsupported",
        ));
    }
    Ok(true)
}
fn mark_initialized(directory: &Path) -> Result<()> {
    if initialized_marker(directory)? {
        return Ok(());
    }
    use std::io::Write;
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(storage)?;
    }
    temporary.write_all(INITIALIZED).map_err(storage)?;
    temporary.as_file().sync_all().map_err(storage)?;
    temporary
        .persist_noclobber(directory.join("operations.initialized"))
        .map_err(storage)?;
    te_plugin_runtime::durable_dir::sync(directory).map_err(storage)?;
    Ok(())
}
/// A database file whose schema transaction never committed: no user version
/// and no schema objects at all. Anything else is validated as a journal.
fn never_initialized(connection: &Connection) -> Result<bool> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage)?;
    let objects: i64 = connection
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row.get(0))
        .map_err(storage)?;
    Ok(version == 0 && objects == 0)
}
fn validate_schema(connection: &Connection) -> Result<i64> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage)?;
    if ![1, 2].contains(&version) {
        return Err(error(
            "unavailable",
            "Image operation journal schema is unsupported or incomplete",
        ));
    }
    let integrity: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(storage)?;
    if integrity != "ok" {
        return Err(error("unavailable", "Image operation journal is corrupt"));
    }
    connection.prepare("SELECT caller,operation,semantic,context,recipe,status,output_sha256,output_descriptor,cancel_requested,test FROM operations LIMIT 0").map_err(storage)?;
    connection
        .prepare("SELECT caller,operation FROM cancellations LIMIT 0")
        .map_err(storage)?;
    if version == 2 {
        connection
            .prepare("SELECT admitted_at_ms,deadline_at_ms FROM operations LIMIT 0")
            .map_err(storage)?;
    }
    for table in ["operations", "cancellations"] {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(storage)?;
        let keys = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
            })
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        if !keys.iter().any(|(name, pk)| name == "caller" && *pk == 1)
            || !keys
                .iter()
                .any(|(name, pk)| name == "operation" && *pk == 2)
        {
            return Err(error(
                "unavailable",
                "Image journal idempotency keys are missing",
            ));
        }
    }
    validate_rows(connection, version)?;
    Ok(version)
}
fn schema(connection: &Connection) -> Result<()> {
    connection.execute_batch("BEGIN IMMEDIATE; CREATE TABLE cancellations(caller TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(caller,operation)); CREATE TABLE operations(caller TEXT NOT NULL,operation TEXT NOT NULL,semantic TEXT NOT NULL,context TEXT NOT NULL,recipe TEXT NOT NULL,status TEXT NOT NULL,output_sha256 TEXT,output_descriptor TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,test INTEGER NOT NULL DEFAULT 0,admitted_at_ms INTEGER NOT NULL,deadline_at_ms INTEGER NOT NULL,PRIMARY KEY(caller,operation)); PRAGMA user_version=2; COMMIT;").map_err(storage)
}

// SQL slices limit allocation before decoding; loading a corrupt multi-megabyte
// value must never allocate it or produce an oversized stdio reply.
fn receipt_query(version: i64) -> String {
    let columns = [
        ("caller", 128),
        ("operation", 128),
        ("semantic", 64),
        ("context", 1024),
        ("recipe", MAX_RECIPE),
        ("status", MAX_STATUS),
        ("output_sha256", 64),
        ("output_descriptor", 1024),
    ];
    let mut selected = columns
        .iter()
        .map(|(name, limit)| {
            format!(
                "substr(CAST({name} AS BLOB),1,{}),typeof({name})",
                limit + 1
            )
        })
        .collect::<Vec<_>>();
    selected.push("cancel_requested,test".into());
    selected.push(
        if version == 1 {
            "0,0"
        } else {
            "admitted_at_ms,deadline_at_ms"
        }
        .into(),
    );
    format!("SELECT {} FROM operations", selected.join(","))
}
fn decode_receipt(row: &rusqlite::Row<'_>) -> Result<StoredReceipt> {
    let bounded = |index: usize, limit: usize, nullable: bool| -> Result<Option<String>> {
        let kind: String = row.get(index + 1).map_err(storage)?;
        if nullable && kind == "null" {
            return Ok(None);
        }
        if kind != "text" {
            return Err(corrupt_receipt());
        }
        let bytes: Vec<u8> = row.get(index).map_err(storage)?;
        if bytes.len() > limit {
            return Err(corrupt_receipt());
        }
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| corrupt_receipt())
    };
    let required = |index, limit| bounded(index, limit, false)?.ok_or_else(corrupt_receipt);
    let context = required(6, 1024)?;
    let recipe = required(8, MAX_RECIPE)?;
    let status = required(10, MAX_STATUS)?;
    let boolean = |index| -> Result<bool> {
        match row.get::<_, i64>(index).map_err(storage)? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(corrupt_receipt()),
        }
    };
    let output = bounded(14, 1024, true)?
        .map(|raw| serde_json::from_str(&raw).map_err(|_| corrupt_receipt()))
        .transpose()?;
    let value = StoredReceipt {
        caller: required(0, 128)?,
        operation: required(2, 128)?,
        semantic: required(4, 64)?,
        context: serde_json::from_str(&context).map_err(|_| corrupt_receipt())?,
        recipe: serde_json::from_str(&recipe).map_err(|_| corrupt_receipt())?,
        status: serde_json::from_str(&status).map_err(|_| corrupt_receipt())?,
        output_sha: bounded(12, 64, true)?,
        output,
        cancelled: boolean(16)?,
        test: boolean(17)?,
        admitted: row.get(18).map_err(storage)?,
        deadline: row.get(19).map_err(storage)?,
    };
    if !value.valid() {
        return Err(corrupt_receipt());
    }
    Ok(value)
}
fn corrupt_receipt() -> te_image_generation_contract::SafeError {
    error("storage_unavailable", "Image operation journal contains an invalid or oversized receipt; restore the original ledger")
}
fn load_receipt(
    connection: &Connection,
    caller: &str,
    operation: &str,
) -> Result<Option<StoredReceipt>> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage)?;
    let mut statement = connection
        .prepare(&(receipt_query(version) + " WHERE caller=? AND operation=?"))
        .map_err(storage)?;
    let mut rows = statement
        .query(params![caller, operation])
        .map_err(storage)?;
    rows.next()
        .map_err(storage)?
        .map(decode_receipt)
        .transpose()
}
fn validate_rows(connection: &Connection, version: i64) -> Result<()> {
    let mut statement = connection
        .prepare(&receipt_query(version))
        .map_err(storage)?;
    let mut rows = statement.query([]).map_err(storage)?;
    let mut live = 0;
    while let Some(row) = rows.next().map_err(storage)? {
        let stored = decode_receipt(row)?;
        if matches!(
            stored.status.execution,
            Execution::Accepted {} | Execution::Running {}
        ) {
            live += 1;
            if live > 36 {
                return Err(corrupt_receipt());
            }
        }
    }
    let mut statement = connection.prepare("SELECT substr(CAST(caller AS BLOB),1,129),typeof(caller),substr(CAST(operation AS BLOB),1,129),typeof(operation) FROM cancellations").map_err(storage)?;
    let mut rows = statement.query([]).map_err(storage)?;
    while let Some(row) = rows.next().map_err(storage)? {
        for index in [0, 2] {
            if row.get::<_, String>(index + 1).map_err(storage)? != "text" {
                return Err(corrupt_receipt());
            }
            let bytes: Vec<u8> = row.get(index).map_err(storage)?;
            if !std::str::from_utf8(&bytes).is_ok_and(crate::domain::id) {
                return Err(corrupt_receipt());
            }
        }
    }
    Ok(())
}
