//! Fixtures use physical roots: macOS and Windows expose aliases for system temp paths.
pub(crate) fn tempdir() -> std::io::Result<tempfile::TempDir> {
    tempfile::Builder::new().tempdir_in(dunce::canonicalize(std::env::temp_dir())?)
}
