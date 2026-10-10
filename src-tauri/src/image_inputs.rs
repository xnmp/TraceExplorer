//! Local inspection for ordered image picks; contains no provider adapter.
use crate::error::AppError;
use serde::Serialize;
use sha2::{Digest,Sha256};
use std::{io::Read,path::Path};
#[derive(Debug,Serialize,PartialEq)]
#[serde(rename_all="camelCase")]
pub(crate) struct InputImage {
    path:String,
    #[serde(skip_serializing_if="Option::is_none")] digest:Option<String>,
    #[serde(skip_serializing_if="Option::is_none")] width:Option<u32>,
    #[serde(skip_serializing_if="Option::is_none")] height:Option<u32>,
    #[serde(skip_serializing_if="Option::is_none")] error:Option<String>,
}
fn invalid(message:&str)->AppError {AppError::Other(message.into())}
fn inspect(path:&str)->Result<(String,u32,u32),AppError> {
    if !Path::new(path).is_absolute() {return Err(invalid("Input image path must be absolute"));}
    let physical=dunce::canonicalize(path)?;
    let mut options=std::fs::OpenOptions::new();options.read(true);
    #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.custom_flags(libc::O_NOFOLLOW|libc::O_NONBLOCK);}
    let mut file=options.open(&physical)?;
    if !file.metadata()?.is_file() {return Err(invalid("Input image must be a regular file"));}
    let mut bytes=vec![];(&mut file).take(20*1024*1024+1).read_to_end(&mut bytes)?;
    if bytes.len()>20*1024*1024 {return Err(invalid("Input image exceeds the 20 MiB limit"));}
    let format=image::guess_format(&bytes).map_err(|_|invalid("Use a PNG, JPEG, or WebP input image"))?;
    if !matches!(format,image::ImageFormat::Png|image::ImageFormat::Jpeg|image::ImageFormat::WebP) {return Err(invalid("Use a PNG, JPEG, or WebP input image"));}
    let (width,height)=image::ImageReader::with_format(std::io::Cursor::new(&bytes),format).into_dimensions().map_err(|_|invalid("Unreadable image data"))?;
    if width==0||height==0||u64::from(width)*u64::from(height)>16_777_216 {return Err(invalid("Image dimensions exceed the 16 megapixel limit"));}
    let mut reader=image::ImageReader::with_format(std::io::Cursor::new(&bytes),format);
    let mut limits=image::Limits::default();limits.max_alloc=Some(128*1024*1024);reader.limits(limits);
    reader.decode().map_err(|_|invalid("Unreadable image data"))?;
    Ok((hex::encode(Sha256::digest(bytes)),width,height))
}
fn describe(path:&str)->InputImage {
    match inspect(path) {
        Ok((digest,width,height))=>InputImage{path:path.into(),digest:Some(digest),width:Some(width),height:Some(height),error:None},
        Err(error)=>InputImage{path:path.into(),digest:None,width:None,height:None,error:Some(error.to_string())},
    }
}
pub(crate) async fn describe_inputs(paths:Vec<String>)->Result<Vec<InputImage>,AppError> {
    if paths.len()>8 {return Err(invalid("At most eight input images are supported"));}
    tokio::task::spawn_blocking(move||paths.iter().map(|path|describe(path)).collect()).await.map_err(|_|invalid("Image input inspection failed"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn ordered_revisions_and_bad_inputs_are_reported_independently() {
        let root=crate::test_support::tempdir().unwrap();let image=root.path().join("image.png");let bad=root.path().join("bad.png");
        let bytes=include_bytes!("../test_support/fixtures/source32.png");std::fs::write(&image,bytes).unwrap();std::fs::write(&bad,b"not an image").unwrap();
        let paths=vec![bad.to_string_lossy().into_owned(),image.to_string_lossy().into_owned()];
        let values=describe_inputs(paths.clone()).await.unwrap();assert_eq!(values.iter().map(|value|value.path.clone()).collect::<Vec<_>>(),paths);
        assert!(values[0].error.is_some());assert_eq!(values[1].digest,Some(hex::encode(Sha256::digest(bytes))));assert_eq!((values[1].width,values[1].height),(Some(32),Some(32)));
        assert!(describe_inputs(vec!["relative.png".into();9]).await.is_err());
    }
}
