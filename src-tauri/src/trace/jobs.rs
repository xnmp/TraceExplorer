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
    with_trace_owner(|database| {
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
        let run = insert_start(&tx, &start, "running")?;
        tx.execute(
            "INSERT INTO image_jobs(operation_id,job_id,request_digest,run_id) VALUES(?1,?2,?3,?4)",
            params![id, job_id as i64, request_digest, run],
        )
        .map_err(sql)?;
        tx.commit().map_err(sql)?;
        Ok((
            TraceRunHandle {
                database: database.into(),
                id: run,
            },
            true,
            job_id,
        ))
    })
}
