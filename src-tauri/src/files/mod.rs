//! Native file identity and no-replace publication; no host crate dependency.
mod file_identity;
mod object_id;
pub(crate) mod publication;

pub(crate) fn trace_file_identity(
    path: &std::path::Path,
) -> Result<String, crate::error::AppError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(crate::error::AppError::Other(
            "Trace publication evidence requires a regular file".into(),
        ));
    }
    trace_file_identity_of(&std::fs::File::open(path)?)
}

pub(crate) fn trace_file_identity_of(
    file: &std::fs::File,
) -> Result<String, crate::error::AppError> {
    serde_json::to_string(&file_identity::of_file(file)?)
        .map_err(|error| crate::error::AppError::Other(error.to_string()))
}
