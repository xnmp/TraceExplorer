//! Durable image-job acceptance. Repeating an operation ID never repeats a provider call.
use super::*;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobStatus {
    pub job_id: u64,
    run_id: i64,
    status: String,
    output_path: Option<String>,
    error: Option<String>,
}

#[derive(Clone, serde::Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImageBatch {
    pub id: String,
    pub index: u32,
    pub count: u32,
}

impl ImageBatch {
    pub(crate) fn validate(&self) -> Result<(), AppError> {
        validate_id(&self.id)?;
        if !(2..=8).contains(&self.count) || self.index >= self.count {
            return Err(AppError::Other(
                "Invalid image batch position or count".into(),
            ));
        }
        Ok(())
    }
}
fn read_job_id(row: &rusqlite::Row<'_>) -> rusqlite::Result<u64> {
    let value: i64 = row.get(1)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(1, value))
}
fn validate_id(id: &str) -> Result<(), AppError> {
    let valid = match id.len() {
        32 => id.bytes().all(|byte| byte.is_ascii_hexdigit()),
        36 => id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        }),
        _ => false,
    };
    if !valid {
        return Err(AppError::Other("Invalid image operation ID".into()));
    }
    Ok(())
}
fn lookup_at(
    database: &Path,
    id: &str,
    expected: Option<&str>,
) -> Result<Option<JobStatus>, AppError> {
    validate_id(id)?;
    if !database.exists() {
        return Ok(None);
    }
    let connection = connection_at(database)?;
    let result:Option<(String,JobStatus)>=connection.query_row(
        "SELECT j.request_digest,j.job_id,r.id,r.status,(SELECT a.path FROM artifacts a WHERE a.generating_run=r.id ORDER BY a.id DESC LIMIT 1),r.error FROM image_jobs j JOIN runs r ON r.id=j.run_id WHERE j.operation_id=?1",
        [id],|row|Ok((row.get(0)?,JobStatus{job_id:read_job_id(row)?,run_id:row.get(2)?,status:row.get(3)?,output_path:row.get(4)?,error:row.get(5)?})),
    ).optional().map_err(sql)?;
    if result
        .as_ref()
        .is_some_and(|(digest, _)| expected.is_some_and(|expected| expected != digest))
    {
        return Err(AppError::Other(
            "Image operation ID already belongs to a different request".into(),
        ));
    }
    Ok(result.map(|(_, status)| status))
}
pub(crate) fn existing(id: &str, request_digest: &str) -> Result<Option<JobStatus>, AppError> {
    lookup_at(&database_path()?, id, Some(request_digest))
}
pub(crate) async fn status(id: String) -> Result<Option<JobStatus>, AppError> {
    tokio::task::spawn_blocking(move || lookup_at(&database_path()?, &id, None))
        .await
        .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

pub(crate) fn accept(
    start: OperationStart,
    id: &str,
    job_id: u64,
    request_digest: &str,
) -> Result<(TraceRunHandle, bool, u64), AppError> {
    validate_id(id)?;
    validate_start(&start)?;
    if job_id == 0 || job_id > 9_007_199_254_740_991 || !valid_digest(request_digest) {
        return Err(AppError::Other("Invalid image acceptance record".into()));
    }
    with_trace_owner(|database| accept_at(database, start, id, job_id, request_digest))
}

fn accept_at(
    database: &Path,
    start: OperationStart,
    id: &str,
    job_id: u64,
    request_digest: &str,
) -> Result<(TraceRunHandle, bool, u64), AppError> {
    accept_at_with_link(database,start,id,job_id,request_digest,|_,_|Ok(()))
}

/// The image consumer commits its service link and exact prepared recipe in
/// the same transaction as the Trace run/job. This callback is local SQL only.
pub(super) fn accept_at_with_link(
    database:&Path,
    start:OperationStart,
    id:&str,
    job_id:u64,
    request_digest:&str,
    link:impl FnOnce(&rusqlite::Transaction<'_>,i64)->Result<(),AppError>,
) -> Result<(TraceRunHandle,bool,u64),AppError> {
    validate_id(id)?;
    validate_start(&start)?;
    if job_id == 0 || job_id > 9_007_199_254_740_991 || !valid_digest(request_digest) {return Err(AppError::Other("Invalid image acceptance record".into()));}
    if let Some(existing) = lookup_at(database, id, Some(request_digest))? {
        return Ok((
            TraceRunHandle {
                database: database.into(),
                id: existing.run_id,
            },
            false,
            existing.job_id,
        ));
    }
    let mut connection = connection_at(database)?;
    let tx = connection.transaction().map_err(sql)?;
    let batch = start
        .parameters
        .get("batch")
        .map(|value| serde_json::from_value::<ImageBatch>(value.clone()))
        .transpose()
        .map_err(|_| AppError::Other("Invalid image batch".into()))?;
    let signature = if let Some(batch) = &batch {
        batch.validate()?;
        let mut parameters = start.parameters.clone();
        parameters
            .as_object_mut()
            .ok_or_else(|| AppError::Other("Invalid image parameters".into()))?
            .remove("operation_id");
        parameters["batch"] = serde_json::json!({"id":batch.id,"count":batch.count});
        let signature = serde_json::to_string(&serde_json::json!({"operation":start.operation,"parameters":parameters,"inputs":start.inputs})).map_err(|error|AppError::Other(error.to_string()))?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT signature FROM image_batch_members WHERE batch_id=?1 LIMIT 1",
                [&batch.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?;
        if existing.is_some_and(|value| value != signature) {
            return Err(AppError::Other(
                "Image batch inputs or settings changed".into(),
            ));
        }
        let occupied: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM image_batch_members WHERE batch_id=?1 AND position=?2)",params![batch.id,batch.index],|row|row.get(0)).map_err(sql)?;
        if occupied {
            return Err(AppError::Other(
                "This image batch output is already accepted".into(),
            ));
        }
        Some(signature)
    } else {
        None
    };
    let run = insert_start(&tx, &start, "running")?;
    if let Some(batch) = batch {
        tx.execute("INSERT INTO image_batch_members(batch_id,position,signature,run_id) VALUES(?1,?2,?3,?4)",params![batch.id,batch.index,signature,run]).map_err(sql)?;
    }
    tx.execute(
        "INSERT INTO image_jobs(operation_id,job_id,request_digest,run_id) VALUES(?1,?2,?3,?4)",
        params![id, job_id as i64, request_digest, run],
    )
    .map_err(sql)?;
    link(&tx,run)?;
    tx.commit().map_err(sql)?;
    Ok((
        TraceRunHandle {
            database: database.into(),
            id: run,
        },
        true,
        job_id,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    const BATCH: &str = "01234567-89ab-7cde-8f01-23456789abcd";
    #[test]
    fn service_link_commit_failure_cannot_accept_a_run_without_its_paid_intent() {
        let root=crate::test_support::tempdir().unwrap();let db=root.path().join("trace.sqlite");let op="e".repeat(32);
        assert!(accept_at_with_link(&db,start(0,"fixture"),&op,10,&"a".repeat(64),|_,_|Err(AppError::Other("injected service-link failure".into()))).is_err());
        assert!(lookup_at(&db,&op,None).unwrap().is_none());
        let (_,created,_)=accept_at(&db,start(0,"fixture"),&op,10,&"a".repeat(64)).unwrap();assert!(created);
    }
    fn start(index: u32, prompt: &str) -> OperationStart {
        OperationStart {
            operation: "openai.image.generate".into(),
            parameters: serde_json::json!({"prompt":prompt,"batch":{"id":BATCH,"index":index,"count":2}}),
            inputs: vec![],
        }
    }
    #[test]
    fn accepted_batch_retries_reuse_receipts_and_parentless_outputs_share_a_graph() {
        let root = crate::test_support::tempdir().unwrap();
        let db = root.path().join("trace.sqlite");
        let digest = "a".repeat(64);
        let first_id = "1".repeat(32);
        let second_id = "2".repeat(32);
        let (first, created, _) =
            accept_at(&db, start(0, "daytime"), &first_id, 1, &digest).unwrap();
        assert!(created);
        let (_, created, job_id) =
            accept_at(&db, start(0, "daytime"), &first_id, 999, &digest).unwrap();
        assert!(!created);
        assert_eq!(job_id, 1);
        assert!(accept_at(&db, start(0, "daytime"), &"3".repeat(32), 3, &digest).is_err());
        assert!(accept_at(&db, start(1, "different settings"), &second_id, 2, &digest).is_err());
        let (second, _, _) = accept_at(&db, start(1, "daytime"), &second_id, 2, &digest).unwrap();
        let pending = graph_for_job_at(&db, 1).unwrap().unwrap();
        assert!(pending.artifacts.is_empty());
        assert_eq!(pending.runs.len(), 2);
        assert!(pending.runs.iter().all(|run| run.status == "running"));
        for (name, run) in [("first.png", first), ("second.png", second)] {
            let target = root.path().join(name);
            crate::image_operation::execute_recorded(
                &run,
                &target,
                &crate::plugin_job::JobControl::new(),
                || {
                    Ok(crate::image_operation::GeneratedImage {
                        bytes: include_bytes!("../../test_support/fixtures/source32.png").to_vec(),
                        details: serde_json::Value::Null,
                    })
                },
            )
            .unwrap();
        }
        let graph = graph_for_path_at(&db, &root.path().join("first.png"))
            .unwrap()
            .unwrap();
        assert_eq!(graph.artifacts.len(), 2);
        assert_eq!(graph.runs.len(), 2);
        assert!(graph
            .artifacts
            .iter()
            .any(|artifact| artifact.path.ends_with("second.png")));
        let by_job = graph_for_job_at(&db, 1).unwrap().unwrap();
        assert_eq!(by_job.artifacts.len(), 2);
        assert_eq!(by_job.job_id, Some(1));
    }

    #[test]
    fn a_failed_jobs_run_is_found_by_its_host_job_id_with_ordered_inputs() {
        let root = crate::test_support::tempdir().unwrap();
        let db = root.path().join("trace.sqlite");
        let first = root.path().join("b.png");
        let second = root.path().join("a.png");
        std::fs::write(
            &first,
            include_bytes!("../../test_support/fixtures/source32.png"),
        )
        .unwrap();
        std::fs::write(
            &second,
            include_bytes!("../../test_support/fixtures/source.png"),
        )
        .unwrap();
        let inputs = || {
            [&first, &second].map(|path| OperationInput {
                path: path.to_string_lossy().into_owned(),
                digest: digest(path).unwrap(),
            })
        };
        let start = OperationStart {
            operation: "openai.image.edit".into(),
            parameters: serde_json::json!({"prompt":"swap the hats","provider":"codex-cli"}),
            inputs: inputs().into(),
        };
        let (run, _, _) = accept_at(&db, start, &"4".repeat(32), 77, &"b".repeat(64)).unwrap();
        assert!(crate::image_operation::execute_recorded(
            &run,
            &root.path().join("out.png"),
            &crate::plugin_job::JobControl::new(),
            || Err(crate::error::AppError::Other("no image".into())),
        )
        .is_err());
        let found = serde_json::to_value(image_run_for_job_at(&db, 77).unwrap().unwrap()).unwrap();
        assert_eq!(found["run"]["status"], "failed");
        assert_eq!(found["run"]["parameters"]["prompt"], "swap the hats");
        assert_eq!(found["inputs"], serde_json::to_value(inputs()).unwrap());
        assert!(image_run_for_job_at(&db, 78).unwrap().is_none());
        assert!(image_run_for_job_at(&db, 0).is_err());
    }
}
