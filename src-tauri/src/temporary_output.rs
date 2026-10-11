//! Managed unsaved images: human filenames in private per-generation folders.
use crate::error::AppError;
use std::path::{Path, PathBuf};

pub(crate) struct TemporaryOutput {
    pub directory: PathBuf,
    pub filename: String,
    pub save_directory_hint: String,
}

/// A caller's resolved local folder takes precedence over Image 1's history.
/// Missing or unusable hints leave Save to choose its normal fallback folder.
/// Existence and write access are checked when saving, not when recording intent.
pub(crate) fn save_directory_hint<'a>(output_dir: &'a str, inherited: Option<&'a str>) -> &'a str {
    let usable = |directory: &&str| {
        directory.len() <= 4096 && !directory.contains('\0') && Path::new(directory).is_absolute()
    };
    Some(output_dir)
        .filter(usable)
        .or_else(|| inherited.filter(usable))
        .unwrap_or("")
}

fn image_name(source: Option<&Path>) -> String {
    let stem = source
        .and_then(Path::file_stem)
        .and_then(|name| name.to_str());
    let Some(stem) = stem else {
        return "generated.png".into();
    };
    let mut bounded = String::new();
    for character in stem.chars() {
        if bounded.len() + character.len_utf8() > 180 {
            break;
        }
        bounded.push(character);
    }
    format!("{bounded}_edit.png")
}

pub(crate) fn prepare(
    root: &Path,
    source: Option<&Path>,
    save_directory_hint: String,
) -> Result<TemporaryOutput, AppError> {
    std::fs::create_dir_all(root)?;
    let metadata = std::fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(AppError::InvalidPath(
            "Temporary image storage must be a regular directory".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
    }
    let directory = tempfile::Builder::new()
        .prefix("generation-")
        .tempdir_in(root)?
        .keep();
    Ok(TemporaryOutput {
        directory,
        filename: image_name(source),
        save_directory_hint,
    })
}

impl Drop for TemporaryOutput {
    fn drop(&mut self) {
        // Preserve published images and retained journal evidence across
        // worker disposal and ordinary restarts; remove only empty failures.
        let _ = std::fs::remove_dir(&self.directory);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolved_output_folder_overrides_an_inherited_save_hint() {
        let current = std::env::temp_dir().join("current");
        let historical = std::env::temp_dir().join("historical");
        let current = current.to_str().unwrap();
        let historical = historical.to_str().unwrap();
        assert_eq!(save_directory_hint(current, Some(historical)), current);
        assert_eq!(save_directory_hint(current, None), current);
        assert_eq!(save_directory_hint("", Some(historical)), historical);
        assert_eq!(save_directory_hint("", None), "");
        for invalid in [
            "".to_owned(),
            "relative/folder".into(),
            "search://images".into(),
            format!("{current}\0bad"),
            format!("{current}{}", "a".repeat(4097)),
        ] {
            assert_eq!(save_directory_hint(&invalid, Some(historical)), historical);
            assert_eq!(save_directory_hint(&invalid, None), "");
            assert_eq!(save_directory_hint("", Some(&invalid)), "");
        }
    }

    #[test]
    fn unsaved_images_use_human_names_without_sharing_a_destination() {
        let root = crate::test_support::tempdir().unwrap();
        let first = prepare(
            root.path(),
            Some(Path::new("portrait.png")),
            "/Pictures".into(),
        )
        .unwrap();
        let second = prepare(
            root.path(),
            Some(Path::new("portrait.png")),
            "/Pictures".into(),
        )
        .unwrap();
        assert_eq!(first.filename, "portrait_edit.png");
        assert_ne!(first.directory, second.directory);
        let image = first.directory.join(&first.filename);
        std::fs::write(&image, b"image").unwrap();
        let empty = second.directory.clone();
        drop(second);
        assert!(!empty.exists());
        drop(first);
        assert_eq!(std::fs::read(image).unwrap(), b"image");
    }
    #[test]
    fn prompt_only_and_long_unicode_names_remain_usable() {
        assert_eq!(image_name(None), "generated.png");
        let name = format!("{}.png", "猫".repeat(150));
        let output = image_name(Some(Path::new(&name)));
        assert!(output.len() <= 255);
        assert!(output.ends_with("_edit.png"));
    }
}
