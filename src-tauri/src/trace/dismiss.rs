//! Dismissing an "Interrupted" placeholder.
//!
//! A run whose provider outcome is unknown stays `uncertain` and keeps all its
//! evidence (row, error, result details, image-service operation link) so
//! retry and recovery keep working. Dismissal only records `runs.dismissed_at`,
//! which hides the output-less placeholder from the folder index and from
//! folder eligibility. If an output is ever recorded for the run it is shown
//! normally: only the placeholder is hidden.
use super::*;
use serde_json::Value;

/// Whether a dismissed run's placeholder is hidden. Recovery can move a
/// dismissed run back to `running` while it publishes; that is shown again.
/// Shared by the folder index and folder eligibility.
pub(crate) fn hides_placeholder(status: &str, dismissed: bool) -> bool {
    dismissed && status == "uncertain"
}

/// The status rule: only an uncertain run without output can be dismissed.
pub(crate) fn can_dismiss(status: &str, has_output: bool) -> bool {
    status == "uncertain" && !has_output
}

fn execution_state(value: &Value) -> Option<&str> {
    match value {
        Value::Object(fields) => fields.get("state").and_then(Value::as_str),
        other => other.as_str(),
    }
}

/// The evidence rule: the outcome must be genuinely unknown, with nothing
/// recoverable. A provider success, a sealed or delivered result, or a transfer
/// receipt means the image will reappear, so hiding it would be misleading.
/// `link` is the image-service operation body, `details` the run's
/// `result_details`; absent evidence allows dismissal, anything malformed or
/// unrecognised does not.
pub(crate) fn evidence_allows_dismissal(link: Option<&str>, details: Option<&str>) -> bool {
    let unknown_state =
        |state: Option<&str>| matches!(state, Some("unknown" | "accepted" | "running"));
    if let Some(details) = details {
        let Ok(details) = serde_json::from_str::<Value>(details) else {
            return false;
        };
        if let Some(execution) = details
            .get("provider_execution")
            .or_else(|| details.get("execution"))
        {
            if !unknown_state(execution_state(execution)) {
                return false;
            }
        }
    }
    if let Some(link) = link {
        let Ok(link) = serde_json::from_str::<Value>(link) else {
            return false;
        };
        let absent = |key: &str| link.get(key).is_none_or(Value::is_null);
        if !absent("output") || !absent("transferReceipt") {
            return false;
        }
        if let Some(receipt) = link.get("receipt").filter(|receipt| !receipt.is_null()) {
            if !unknown_state(receipt.get("execution").and_then(execution_state)) {
                return false;
            }
            if let Some(delivery) = receipt.get("delivery") {
                if execution_state(delivery) != Some("none") {
                    return false;
                }
            }
        }
    }
    true
}

/// Whether the run's recorded evidence allows dismissal (see `evidence_allows_dismissal`).
pub(crate) fn evidence_ok(connection: &Connection, run_id: i64) -> Result<bool, AppError> {
    let details: Option<String> = connection
        .query_row(
            "SELECT result_details FROM runs WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?
        .flatten();
    let has_table: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='image_service_operations')",
            [],
            |row| row.get(0),
        )
        .map_err(sql)?;
    let link: Option<String> = if has_table {
        connection
            .query_row(
                "SELECT body FROM image_service_operations WHERE run_id=?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?
    } else {
        None
    };
    Ok(evidence_allows_dismissal(
        link.as_deref(),
        details.as_deref(),
    ))
}

/// Idempotent: dismissing an already dismissed run is a no-op.
pub(crate) fn dismiss_at(database: &Path, run_id: i64) -> Result<(), AppError> {
    let mut connection = connection_at(database)?;
    let tx = connection.transaction().map_err(sql)?;
    let row: Option<(String, bool, bool)> = tx
        .query_row(
            "SELECT status,dismissed_at IS NOT NULL,EXISTS(SELECT 1 FROM artifacts WHERE generating_run=?1) FROM runs WHERE id=?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(sql)?;
    let Some((status, dismissed, has_output)) = row else {
        return Err(AppError::Other("Unknown run".into()));
    };
    if dismissed {
        return Ok(());
    }
    if !can_dismiss(&status, has_output) {
        return Err(AppError::Other(
            "Only an interrupted placeholder without output can be dismissed".into(),
        ));
    }
    if !evidence_ok(&tx, run_id)? {
        return Err(AppError::Other(
            "This run's result is recoverable, so it cannot be dismissed".into(),
        ));
    }
    tx.execute(
        "UPDATE runs SET dismissed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
        [run_id],
    )
    .map_err(sql)?;
    tx.commit().map_err(sql)
}

pub(crate) async fn dismiss(run_id: i64) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || with_trace_owner(|database| dismiss_at(database, run_id)))
        .await
        .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_uncertain_run_without_output_can_be_dismissed() {
        assert!(can_dismiss("uncertain", false));
        assert!(!can_dismiss("uncertain", true));
        for status in [
            "running",
            "succeeded",
            "failed",
            "interrupted",
            "cancelled",
            "",
            "UNCERTAIN",
        ] {
            assert!(!can_dismiss(status, false), "{status}");
        }
    }

    #[test]
    fn a_dismissal_hides_only_an_uncertain_run() {
        assert!(hides_placeholder("uncertain", true));
        assert!(!hides_placeholder("uncertain", false));
        assert!(!hides_placeholder("running", true), "recovery resumed it");
        assert!(!hides_placeholder("succeeded", true));
    }

    #[test]
    fn evidence_must_show_an_unknown_unrecoverable_outcome() {
        let ok =
            |link: Option<&str>, details: Option<&str>| evidence_allows_dismissal(link, details);
        assert!(ok(None, None));
        assert!(ok(
            None,
            Some(r#"{"outcome":"unknown","provider_execution":{"state":"unknown"}}"#)
        ));
        assert!(ok(
            Some(
                r#"{"output":null,"transferReceipt":null,"receipt":{"execution":{"state":"running"},"delivery":{"state":"none"}}}"#
            ),
            None
        ));
        assert!(ok(Some(r#"{"output":null,"receipt":null}"#), None));
        // Provider success recorded in the run or in the link.
        assert!(!ok(
            None,
            Some(r#"{"provider_execution":{"state":"succeeded"}}"#)
        ));
        assert!(!ok(None, Some(r#"{"execution":"succeeded"}"#)));
        assert!(!ok(
            Some(r#"{"receipt":{"execution":{"state":"succeeded"},"delivery":{"state":"none"}}}"#),
            None
        ));
        // Sealed, delivered or transferred results will reappear.
        assert!(!ok(Some(r#"{"output":{"sha256":"x"}}"#), None));
        assert!(!ok(Some(r#"{"transferReceipt":"proof"}"#), None));
        assert!(!ok(
            Some(
                r#"{"receipt":{"execution":{"state":"unknown"},"delivery":{"state":"available"}}}"#
            ),
            None
        ));
        // Malformed or unrecognised evidence is never dismissable.
        assert!(!ok(Some("not json"), None));
        assert!(!ok(None, Some("{")));
        assert!(!ok(Some(r#"{"receipt":{"execution":{}}}"#), None));
        assert!(!ok(None, Some(r#"{"execution":{"state":"weird"}}"#)));
    }
}
