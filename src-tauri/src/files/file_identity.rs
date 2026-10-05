//! Native object and version observations from retained handles or supplied
//! metadata, never a path reopen. Callers separately validate privacy and authority.
use super::object_id::ObjectId;
use std::{fs::File, io};

#[cfg(windows)]
#[path = "file_identity/windows.rs"]
mod windows;
#[cfg(windows)]
pub(super) fn of_file(file: &File) -> io::Result<ObjectId> {
    windows::of_file(file)
}

#[cfg(unix)]
pub(super) fn of_file(file: &File) -> io::Result<ObjectId> {
    Ok(from_metadata(&file.metadata()?))
}

#[cfg(unix)]
fn from_metadata(metadata: &std::fs::Metadata) -> ObjectId {
    use std::os::unix::fs::MetadataExt;
    ObjectId::unix(metadata.dev(), metadata.ino())
}
