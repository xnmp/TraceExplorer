//! Explicit host-owned data location, independent of any Tauri application.
use crate::error::AppError;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

static DATA_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

pub fn initialize(directory: &Path) -> Result<(), AppError> {
    if !directory.is_absolute() {
        return Err(AppError::InvalidPath(
            "Plugin data directory must be absolute".into(),
        ));
    }
    std::fs::create_dir_all(directory)?;
    let directory = dunce::canonicalize(directory)?;
    DATA_DIRECTORY
        .set(directory)
        .map_err(|_| AppError::Other("Backend already initialized".into()))?;
    Ok(())
}

pub(crate) fn config_dir() -> Result<PathBuf, AppError> {
    DATA_DIRECTORY
        .get()
        .cloned()
        .ok_or_else(|| AppError::Other("Backend not initialized".into()))
}
