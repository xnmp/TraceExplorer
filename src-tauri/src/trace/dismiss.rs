//! Dismissing an "Interrupted" placeholder.
//!
//! A run whose provider outcome is unknown stays `uncertain` and keeps all its
//! evidence (row, error, result details, image-service operation link) so
//! retry and recovery keep working. Dismissal only records `runs.dismissed_at`,
//! which hides the output-less placeholder from the folder index and from
//! folder eligibility. If an output is ever recorded for the run it is shown
//! normally: only the placeholder is hidden.
use super::*;

/// Whether the user may dismiss a run's placeholder. Only an uncertain run
/// without output qualifies; a running run is still active and a run with an
/// output is shown through that output.
pub(crate) fn can_dismiss(status: &str, has_output: bool) -> bool {
    status == "uncertain" && !has_output
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
    tx.execute(
        "UPDATE runs SET dismissed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
        [run_id],
    )
    .map_err(sql)?;
    // The change-counter trigger on `runs` watches status and parameters only.
    tx.execute("UPDATE trace_revision SET value=value+1 WHERE id=1", [])
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
    use super::can_dismiss;

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
}
