//! Windows file identity captured from an already-open handle.

use super::ObjectId;
use std::{fs::File, io, mem::size_of, os::windows::io::AsRawHandle};
use windows::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO},
};

pub(super) fn of_file(file: &File) -> io::Result<ObjectId> {
    let mut information = FILE_ID_INFO::default();
    // FILE_ID_INFO preserves the volume serial and full 128-bit identifier used
    // to compare two open file handles on one computer.
    // https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_info
    // SAFETY: the borrowed handle remains live and the writable output buffer
    // has exactly the size required by FileIdInfo for this synchronous call.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            (&mut information as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .map_err(|error| io::Error::from_raw_os_error((error.code().0 as u32 & 0xffff) as i32))?;

    Ok(ObjectId::windows(
        information.VolumeSerialNumber,
        information.FileId.Identifier,
    ))
}
