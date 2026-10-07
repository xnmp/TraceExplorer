//! Cached short prompt titles; text-only Codex runs never generate an image.
use super::*;
use sha2::{Digest, Sha256};

pub(crate) async fn title(run_id: i64, configured: String) -> Result<String, AppError> {
    if run_id <= 0 {
        return Err(AppError::Other("Invalid image run ID".into()));
    }
    static SLOTS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    let _permit = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        SLOTS
            .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)))
            .clone()
            .acquire_owned(),
    )
    .await
    .map_err(|_| AppError::Other("Prompt title generator is busy".into()))?
    .map_err(|_| AppError::Other("Prompt title queue closed".into()))?;
    tokio::task::spawn_blocking(move || {
        let database = database_path()?;
        let connection = connection_at(&database)?;
        let parameters: String = connection
            .query_row("SELECT parameters FROM runs WHERE id=?1", [run_id], |row| {
                row.get(0)
            })
            .map_err(sql)?;
        let parameters: serde_json::Value = serde_json::from_str(&parameters)
            .map_err(|error| AppError::Other(error.to_string()))?;
        let prompt = parameters["prompt"]
            .as_str()
            .filter(|value| !value.trim().is_empty() && value.len() <= 16_000)
            .ok_or_else(|| AppError::Other("Image has no prompt".into()))?;
        let digest = hex::encode(Sha256::digest(prompt.as_bytes()));
        if let Some(title) = connection
            .query_row(
                "SELECT title FROM image_prompt_titles WHERE digest=?1",
                [&digest],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sql)?
        {
            return Ok(title);
        }
        drop(connection);
        let title = crate::openai_image::prompt_title(prompt, &configured)?;
        with_trace_owner(|database| {
            connection_at(database)?
                .execute(
                    "INSERT OR IGNORE INTO image_prompt_titles(digest,title) VALUES(?1,?2)",
                    params![digest, title],
                )
                .map_err(sql)?;
            Ok(())
        })?;
        Ok(title)
    })
    .await
    .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}
