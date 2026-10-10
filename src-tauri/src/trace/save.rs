//! Save an unsaved output without creating a second edit or replacing a file.
use super::*;
use crate::files::publication::StagedEntry;
use std::io::{Seek, SeekFrom};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveSuggestion {
    directory: String,
    filename: String,
}

struct SavedImage {
    path: String,
    digest: String,
    run: i64,
    parameters: serde_json::Value,
}

fn image_at(database: &Path, id: i64) -> Result<SavedImage, AppError> {
    if id <= 0 {
        return Err(AppError::Other("Invalid image ID".into()));
    }
    connection_at(database)?.query_row(
        "SELECT a.path,a.digest,r.id,r.parameters FROM artifacts a JOIN runs r ON r.id=a.generating_run WHERE a.id=?1 AND r.status='succeeded'",
        [id], |row| Ok(SavedImage {path:row.get(0)?, digest:row.get(1)?, run:row.get(2)?, parameters:serde_json::from_str(&row.get::<_,String>(3)?).unwrap_or(serde_json::Value::Null)}),
    ).optional().map_err(sql)?.ok_or_else(|| AppError::Other("Image has no completed generation".into()))
}

fn is_temporary(image: &SavedImage) -> bool {
    image
        .parameters
        .get("output_storage")
        .and_then(serde_json::Value::as_str)
        == Some("temporary")
}

fn permanent_directory(directory: &Path, generated: &Path) -> Result<PathBuf, AppError> {
    if !directory.is_absolute() {
        return Err(AppError::InvalidPath(
            "Save requires an absolute directory".into(),
        ));
    }
    let directory = fs::canonicalize(directory)?;
    if !directory.is_dir() || directory.starts_with(fs::canonicalize(generated)?) {
        return Err(AppError::InvalidPath(
            "Choose a permanent folder outside temporary image storage".into(),
        ));
    }
    Ok(directory)
}

fn unused_filename(directory: &Path, filename: &str) -> Result<String, AppError> {
    let name = Path::new(filename);
    let stem = name
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::InvalidPath("Image filename is invalid".into()))?;
    let extension = name.extension().and_then(|s| s.to_str()).unwrap_or("png");
    for index in 1..=100_000 {
        let name = if index == 1 {
            filename.to_owned()
        } else {
            format!("{stem}_{index}.{extension}")
        };
        match fs::symlink_metadata(directory.join(&name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(name),
            Ok(_) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(AppError::Other(
        "Too many files share this image name".into(),
    ))
}

fn suggestion_at(database: &Path, generated: &Path, id: i64) -> Result<SaveSuggestion, AppError> {
    ensure_not_discarding(database, id)?;
    let image = image_at(database, id)?;
    if !is_temporary(&image) {
        return Err(AppError::Other("Image is already saved".into()));
    }
    let hint = image
        .parameters
        .get("save_directory_hint")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from);
    let directory = hint
        .and_then(|path| permanent_directory(&path, generated).ok())
        .or_else(|| dirs::picture_dir().filter(|path| path.is_dir()))
        .or_else(dirs::home_dir)
        .ok_or_else(|| AppError::Other("No default save folder is available".into()))?;
    let directory = permanent_directory(&directory, generated)?;
    let filename = Path::new(&image.path)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::InvalidPath("Image filename is invalid".into()))?;
    Ok(SaveSuggestion {
        filename: unused_filename(&directory, filename)?,
        directory: dunce::simplified(&directory).to_string_lossy().into_owned(),
    })
}

pub(crate) async fn suggestion(id: i64) -> Result<SaveSuggestion, AppError> {
    tokio::task::spawn_blocking(move || {
        with_trace_owner(|database| {
            suggestion_at(database, &config::config_dir()?.join("generated"), id)
        })
    })
    .await
    .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

pub(crate) async fn save(id: i64, target: Option<String>) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        with_trace_owner(|database| {
            let generated = config::config_dir()?.join("generated");
            match target {
                Some(target) => save_at(database, &generated, id, Path::new(&target)),
                None => save_default_at(database, &generated, id),
            }
        })
    })
    .await
    .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

fn save_default_at(database: &Path, generated: &Path, id: i64) -> Result<String, AppError> {
    reconcile_at(database)?;
    let image = image_at(database, id)?;
    if !is_temporary(&image) {
        return Ok(image.path);
    }
    let suggestion = suggestion_at(database, generated, id)?;
    save_at(
        database,
        generated,
        id,
        &Path::new(&suggestion.directory).join(suggestion.filename),
    )
}

pub(super) fn save_at(
    database: &Path,
    generated: &Path,
    id: i64,
    target: &Path,
) -> Result<String, AppError> {
    reconcile_at(database)?;
    ensure_not_discarding(database, id)?;
    let image = image_at(database, id)?;
    // A lost successful reply may be retried safely; it must not make a copy.
    if !is_temporary(&image) {
        return Ok(image.path);
    }
    let pending: bool = connection_at(database)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM image_saves WHERE artifact_id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if pending {
        return Err(AppError::MutationUncertain(
            "An earlier save is awaiting verification".into(),
        ));
    }
    let root = fs::canonicalize(generated)?;
    let source = fs::canonicalize(&image.path)?;
    let metadata = fs::symlink_metadata(&image.path)?;
    if !source.starts_with(&root) || !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(AppError::InvalidPath(
            "Unsaved image is outside managed storage".into(),
        ));
    }
    if !target
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("png"))
    {
        return Err(AppError::InvalidPath(
            "Generated images must be saved with a .png extension".into(),
        ));
    }
    let directory = permanent_directory(
        target
            .parent()
            .ok_or_else(|| AppError::InvalidPath("Save target has no folder".into()))?,
        generated,
    )?;
    let target = directory.join(
        target
            .file_name()
            .ok_or_else(|| AppError::InvalidPath("Save target has no filename".into()))?,
    );
    let target_text = dunce::simplified(&target).to_string_lossy().into_owned();
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut input = options.open(source)?;
    if !input.metadata()?.is_file() {
        return Err(AppError::InvalidPath(
            "Unsaved image must be a regular file".into(),
        ));
    }
    if digest_file(&mut input)? != image.digest {
        return Err(AppError::Other(
            "Unsaved image changed; its recorded revision cannot be saved".into(),
        ));
    }
    input.seek(SeekFrom::Start(0))?;
    let mut staged = StagedEntry::prepare(&directory, |payload| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(payload)?;
        std::io::copy(&mut (&mut input).take(MAX_IMAGE_BYTES + 1), &mut output)?;
        output.sync_all()?;
        if digest(payload)? != image.digest {
            return Err(AppError::Other("Image changed while saving".into()));
        }
        Ok(())
    })?;
    let anchor = staged.trace_anchor()?;
    let identity = crate::files::trace_file_identity(&anchor)?;
    let connection = connection_at(database)?;
    connection.execute("INSERT INTO image_saves(artifact_id,source_path,target_path,digest,object_identity,anchor_path) VALUES(?1,?2,?3,?4,?5,?6)",params![id,image.path,target_text,image.digest,identity,anchor.to_string_lossy()]).map_err(sql)?;
    staged.retain_trace_anchor();
    if let Err(error) = staged.publish(&target) {
        // Publication refused. Keep the source and leave unrelated targets alone.
        cleanup_private_anchor(&anchor, &identity)?;
        connection
            .execute("DELETE FROM image_saves WHERE artifact_id=?1", [id])
            .map_err(sql)?;
        return Err(error);
    }
    if !matches!(
        observe_publication(&target, &anchor, &image.digest, &identity),
        PublicationObservation::Published
    ) {
        return Err(AppError::MutationUncertain(format!(
            "Saved bytes at {target_text}; Trace verification is pending"
        )));
    }
    commit_at(database, id).map_err(|error| {
        AppError::MutationUncertain(format!(
            "Saved bytes at {target_text}; Trace update is pending: {error}"
        ))
    })?;
    if let Err(error) = cleanup_at(database, id) {
        log::warn!("Image save {id} cleanup is pending: {error}");
    }
    Ok(target_text)
}

fn ensure_not_discarding(database: &Path, id: i64) -> Result<(), AppError> {
    let discarding: bool = connection_at(database)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM image_discards WHERE artifact_id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if discarding {
        return Err(AppError::Other(
            "This image was discarded or its deletion is pending".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn discard(id: i64) -> Result<Option<String>, AppError> {
    tokio::task::spawn_blocking(move || {
        with_trace_owner(|database| {
            let image = image_at(database, id)?;
            discard_at(database, &config::config_dir()?.join("generated"), id)?;
            let graph = graph_for_artifact_at(
                &connection_at(database)?,
                id,
                image.path,
                SelectedRevisionStatus::Matched,
            )?;
            Ok(graph
                .artifacts
                .into_iter()
                .find(|artifact| {
                    artifact.id != id && !artifact.discarded && Path::new(&artifact.path).is_file()
                })
                .map(|artifact| artifact.path))
        })
    })
    .await
    .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

fn validated_discard_source(
    generated: &Path,
    path: &Path,
    expected_digest: &str,
    identity: Option<&str>,
) -> Result<String, AppError> {
    let root = fs::canonicalize(generated)?;
    let source = fs::canonicalize(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !source.starts_with(root) || !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(AppError::InvalidPath(
            "Only managed temporary images can be deleted".into(),
        ));
    }
    let current_identity = crate::files::trace_file_identity(path)?;
    if identity.is_some_and(|value| value != current_identity) || digest(path)? != expected_digest {
        return Err(AppError::Other(
            "Temporary image changed; refusing to delete its replacement".into(),
        ));
    }
    Ok(current_identity)
}

fn finish_discard_at(database: &Path, generated: &Path, id: i64) -> Result<(), AppError> {
    let connection = connection_at(database)?;
    let (path, staged, digest, identity, completed): (String,String,String,String,bool) = connection.query_row("SELECT path,staged_path,digest,object_identity,completed FROM image_discards WHERE artifact_id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).map_err(sql)?;
    if completed {
        return Ok(());
    }
    // A missing parent means storage is unavailable, not confirmed absence.
    if matches!(fs::symlink_metadata(&staged),Err(error) if error.kind()==std::io::ErrorKind::NotFound)
    {
        if matches!(fs::symlink_metadata(&path),Err(error) if error.kind()==std::io::ErrorKind::NotFound)
            && Path::new(&path)
                .parent()
                .is_none_or(|parent| !parent.is_dir())
        {
            return Err(AppError::MutationUncertain(
                "Image storage is unavailable; deletion remains pending".into(),
            ));
        }
    }
    if !Path::new(&staged)
        .parent()
        .is_some_and(|parent| parent.is_dir())
    {
        return Err(AppError::MutationUncertain(
            "Private image deletion storage is unavailable".into(),
        ));
    }
    match fs::symlink_metadata(&staged) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::symlink_metadata(&path) {
                Ok(_) => {
                    validated_discard_source(
                        generated,
                        Path::new(&path),
                        &digest,
                        Some(&identity),
                    )?;
                    fs::rename(&path, &staged)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    }
    if fs::symlink_metadata(&staged).is_ok() {
        if let Err(error) =
            validated_discard_source(generated, Path::new(&staged), &digest, Some(&identity))
        {
            // A replaced source is preserved, never unlinked. Restore only
            // into an empty original name; a competing replacement stays put.
            if fs::hard_link(&staged, &path).is_ok() {
                let _ = fs::remove_file(&staged);
            }
            return Err(error);
        }
        fs::remove_file(&staged)?;
    }
    connection
        .execute(
            "UPDATE image_discards SET completed=1 WHERE artifact_id=?1",
            [id],
        )
        .map_err(sql)?;
    connection.execute("DELETE FROM image_folder_contexts WHERE run_id=(SELECT generating_run FROM artifacts WHERE id=?1)",[id]).map_err(sql)?;
    if let Some(directory) = Path::new(&staged).parent() {
        let _ = fs::remove_dir(directory);
    }
    Ok(())
}

pub(super) fn discard_at(database: &Path, generated: &Path, id: i64) -> Result<(), AppError> {
    reconcile_at(database)?;
    prepare_discard_at(database, generated, id)?;
    finish_discard_at(database, generated, id)
}

fn prepare_discard_at(database: &Path, generated: &Path, id: i64) -> Result<(), AppError> {
    let connection = connection_at(database)?;
    let recorded: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM image_discards WHERE artifact_id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if recorded {
        return Ok(());
    }
    let image = image_at(database, id)?;
    if !is_temporary(&image) {
        return Err(AppError::Other(
            "Only unsaved generated images can be discarded".into(),
        ));
    }
    let saving: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM image_saves WHERE artifact_id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if saving {
        return Err(AppError::MutationUncertain(
            "This image has a pending save".into(),
        ));
    }
    let identity =
        validated_discard_source(generated, Path::new(&image.path), &image.digest, None)?;
    let stage = tempfile::Builder::new()
        .prefix("discard-")
        .tempdir_in(generated)?;
    let staged = stage.path().join("payload");
    connection.execute("INSERT INTO image_discards(artifact_id,path,staged_path,digest,object_identity) VALUES(?1,?2,?3,?4,?5)",params![id,image.path,staged.to_string_lossy(),image.digest,identity]).map_err(sql)?;
    let _ = stage.keep();
    Ok(())
}

pub(super) fn reconcile_discards_at(database: &Path, generated: &Path) -> Result<(), AppError> {
    let connection = connection_at(database)?;
    let mut statement = connection
        .prepare("SELECT artifact_id FROM image_discards WHERE completed=0")
        .map_err(sql)?;
    let ids = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    for id in ids {
        if let Err(error) = finish_discard_at(database, generated, id) {
            log::warn!("Image discard {id} remains pending: {error}");
        }
    }
    Ok(())
}

fn commit_at(database: &Path, id: i64) -> Result<(), AppError> {
    let mut connection = connection_at(database)?;
    let tx = connection.transaction().map_err(sql)?;
    let (source, target, digest): (String, String, String) = tx
        .query_row(
            "SELECT source_path,target_path,digest FROM image_saves WHERE artifact_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(sql)?;
    let image = image_at(database, id)?;
    if image.path != source || image.digest != digest {
        return Err(AppError::MutationUncertain(
            "Image revision changed while saving".into(),
        ));
    }
    let mut parameters = image.parameters;
    parameters["output_storage"] = serde_json::json!("saved");
    parameters["save_directory_hint"] = serde_json::json!(Path::new(&target)
        .parent()
        .map(|path| path.to_string_lossy().into_owned()));
    tx.execute(
        "INSERT OR IGNORE INTO artifact_locators(artifact_id,path,digest) VALUES(?1,?2,?3)",
        params![id, source, digest],
    )
    .map_err(sql)?;
    tx.execute(
        "UPDATE artifacts SET path=?1 WHERE id=?2",
        params![target, id],
    )
    .map_err(sql)?;
    tx.execute(
        "UPDATE runs SET parameters=?1 WHERE id=?2",
        params![parameters.to_string(), image.run],
    )
    .map_err(sql)?;
    tx.execute(
        "DELETE FROM image_folder_contexts WHERE run_id=?1",
        [image.run],
    )
    .map_err(sql)?;
    tx.execute(
        "UPDATE image_saves SET committed=1 WHERE artifact_id=?1",
        [id],
    )
    .map_err(sql)?;
    tx.commit().map_err(sql)
}

fn cleanup_at(database: &Path, id: i64) -> Result<(), AppError> {
    let connection = connection_at(database)?;
    let (anchor, identity): (String, String) = connection
        .query_row(
            "SELECT anchor_path,object_identity FROM image_saves WHERE artifact_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sql)?;
    cleanup_private_anchor(Path::new(&anchor), &identity)?;
    connection
        .execute("DELETE FROM image_saves WHERE artifact_id=?1", [id])
        .map_err(sql)?;
    Ok(())
}

pub(super) fn reconcile_at(database: &Path) -> Result<(), AppError> {
    let connection = connection_at(database)?;
    let mut statement = connection.prepare("SELECT artifact_id,target_path,digest,object_identity,anchor_path,committed FROM image_saves").map_err(sql)?;
    let pending = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    drop(statement);
    drop(connection);
    for (id, target, digest, identity, anchor, committed) in pending {
        if committed {
            if let Err(error) = cleanup_at(database, id) {
                log::warn!("Image save {id} cleanup is pending: {error}");
            }
            continue;
        }
        let result =
            match observe_publication(Path::new(&target), Path::new(&anchor), &digest, &identity) {
                PublicationObservation::Published => {
                    commit_at(database, id).and_then(|()| cleanup_at(database, id))
                }
                PublicationObservation::NotPublished => cleanup_at(database, id),
                PublicationObservation::Unavailable => Ok(()),
            };
        if let Err(error) = result {
            // An unavailable or changed save must not disable unrelated history
            // and generations. Keep this record fenced for a later retry.
            log::warn!("Image save {id} remains pending: {error}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: tempfile::TempDir,
        database: PathBuf,
        generated: PathBuf,
        source: PathBuf,
        id: i64,
    }
    fn fixture() -> Fixture {
        let root = crate::test_support::tempdir().unwrap();
        let database = root.path().join("trace.sqlite");
        let generated = root.path().join("generated");
        fs::create_dir(&generated).unwrap();
        let source = generated.join("parent_edit.png");
        fs::write(
            &source,
            include_bytes!("../../test_support/fixtures/source32.png"),
        )
        .unwrap();
        record_operation_at(&database,OperationRecord{
            operation:"openai.image.edit".into(),
            parameters:serde_json::json!({"prompt":"blue background","output_storage":"temporary","save_directory_hint":root.path()}),
            inputs:vec![], output_path:source.to_string_lossy().into_owned(),output_digest:digest(&source).unwrap(),
        }).unwrap();
        let id = graph_for_path_at(&database, &source)
            .unwrap()
            .unwrap()
            .current_artifact_id;
        Fixture {
            root,
            database,
            generated,
            source,
            id,
        }
    }

    #[test]
    fn default_save_uses_available_names_and_retry_keeps_the_same_file() {
        let f = fixture();
        let first = save_default_at(&f.database, &f.generated, f.id).unwrap();
        assert_eq!(Path::new(&first).file_name().unwrap(), "parent_edit.png");
        assert_eq!(
            save_default_at(&f.database, &f.generated, f.id).unwrap(),
            first
        );
        fs::write(
            &f.source,
            include_bytes!("../../test_support/fixtures/source32.png"),
        )
        .unwrap();
        record_operation_at(&f.database, OperationRecord { operation:"openai.image.edit".into(), parameters:serde_json::json!({"prompt":"second","output_storage":"temporary","save_directory_hint":f.root.path(),"suggested_filename":"parent_edit.png"}), inputs:vec![], output_path:f.source.to_string_lossy().into_owned(), output_digest:digest(&f.source).unwrap() }).unwrap();
        let id = graph_for_path_at(&f.database, &f.source)
            .unwrap()
            .unwrap()
            .current_artifact_id;
        let second = save_default_at(&f.database, &f.generated, id).unwrap();
        assert_eq!(Path::new(&second).file_name().unwrap(), "parent_edit_2.png");
        assert_eq!(fs::read(first).unwrap(), fs::read(second).unwrap());
    }

    #[test]
    fn unsaved_folder_context_ends_after_save_elsewhere_or_discard() {
        let f = fixture();
        assert!(super::super::folders::has_trace_at(&f.database, f.root.path()).unwrap());
        let permanent = f.root.path().join("permanent");
        fs::create_dir(&permanent).unwrap();
        save_at(
            &f.database,
            &f.generated,
            f.id,
            &permanent.join("saved.png"),
        )
        .unwrap();
        assert!(!super::super::folders::has_trace_at(&f.database, f.root.path()).unwrap());
        assert!(super::super::folders::has_trace_at(&f.database, &permanent).unwrap());
        let f = fixture();
        assert!(super::super::folders::has_trace_at(&f.database, f.root.path()).unwrap());
        discard_at(&f.database, &f.generated, f.id).unwrap();
        assert!(!super::super::folders::has_trace_at(&f.database, f.root.path()).unwrap());
    }

    #[test]
    fn discard_is_idempotent_retains_descendant_history_and_refuses_saved_images() {
        let f = fixture();
        let child = f.root.path().join("child.png");
        fs::write(
            &child,
            include_bytes!("../../test_support/fixtures/source32.png"),
        )
        .unwrap();
        record_operation_at(
            &f.database,
            OperationRecord {
                operation: "image.crop".into(),
                parameters: serde_json::Value::Null,
                inputs: vec![OperationInput {
                    path: f.source.to_string_lossy().into_owned(),
                    digest: digest(&f.source).unwrap(),
                }],
                output_path: child.to_string_lossy().into_owned(),
                output_digest: digest(&child).unwrap(),
            },
        )
        .unwrap();
        discard_at(&f.database, &f.generated, f.id).unwrap();
        discard_at(&f.database, &f.generated, f.id).unwrap();
        assert!(!f.source.exists());
        let graph = graph_for_path_at(&f.database, &child).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 2);
        assert!(
            graph
                .artifacts
                .iter()
                .find(|a| a.id == f.id)
                .unwrap()
                .discarded
        );
        assert_eq!(
            fs::read(child).unwrap(),
            include_bytes!("../../test_support/fixtures/source32.png")
        );
        assert!(save_default_at(&f.database, &f.generated, f.id).is_err());
        let saved = fixture();
        let permanent = save_default_at(&saved.database, &saved.generated, saved.id).unwrap();
        assert!(discard_at(&saved.database, &saved.generated, saved.id).is_err());
        assert!(Path::new(&permanent).is_file());
    }

    #[test]
    fn pending_discard_waits_for_unavailable_storage_and_recovers_after_restart() {
        let f = fixture();
        prepare_discard_at(&f.database, &f.generated, f.id).unwrap();
        assert!(save_default_at(&f.database, &f.generated, f.id).is_err());
        let parked = f.root.path().join("unavailable");
        fs::rename(&f.generated, &parked).unwrap();
        assert!(finish_discard_at(&f.database, &f.generated, f.id).is_err());
        assert!(parked.join("parent_edit.png").is_file());
        fs::rename(&parked, &f.generated).unwrap();
        reconcile_discards_at(&f.database, &f.generated).unwrap();
        assert!(!f.source.exists());
        assert!(finish_discard_at(&f.database, &f.generated, f.id).is_ok());
    }

    #[test]
    fn pending_discard_never_deletes_a_replaced_source() {
        let f = fixture();
        prepare_discard_at(&f.database, &f.generated, f.id).unwrap();
        fs::write(&f.source, b"replacement").unwrap();
        assert!(finish_discard_at(&f.database, &f.generated, f.id).is_err());
        assert_eq!(fs::read(f.source).unwrap(), b"replacement");
    }

    #[test]
    fn saving_preserves_bytes_and_the_same_output_node_across_restart() {
        let f = fixture();
        let target = f.root.path().join("parent_edit.png");
        let before = graph_for_path_at(&f.database, &f.source).unwrap().unwrap();
        assert_eq!(
            suggestion_at(&f.database, &f.generated, f.id)
                .unwrap()
                .filename,
            "parent_edit.png"
        );
        assert_eq!(
            save_at(&f.database, &f.generated, f.id, &target).unwrap(),
            target.to_str().unwrap()
        );
        assert_eq!(fs::read(&target).unwrap(), fs::read(&f.source).unwrap());
        reconcile_at(&f.database).unwrap();
        let after = graph_for_path_at(&f.database, &target).unwrap().unwrap();
        assert_eq!(after.current_artifact_id, before.current_artifact_id);
        assert_eq!(after.artifacts.len(), before.artifacts.len());
        assert_eq!(after.runs.len(), before.runs.len());
        assert!(!after.artifacts[0].temporary);
        assert_eq!(after.runs[0].parameters["prompt"], "blue background");
        let duplicate = f.root.path().join("duplicate.png");
        assert_eq!(
            save_at(&f.database, &f.generated, f.id, &duplicate).unwrap(),
            target.to_str().unwrap()
        );
        assert!(!duplicate.exists());
        let alias = graph_for_path_at(&f.database, &f.source).unwrap().unwrap();
        assert_eq!(alias.current_artifact_id, f.id);
        assert!(matches!(
            alias.selected_revision_status,
            SelectedRevisionStatus::Matched
        ));
        let next = begin_operation_at(
            &f.database,
            OperationStart {
                operation: "openai.image.edit".into(),
                parameters: serde_json::json!({"prompt":"next edit"}),
                inputs: vec![OperationInput {
                    path: f.source.to_string_lossy().into_owned(),
                    digest: digest(&f.source).unwrap(),
                }],
            },
        )
        .unwrap();
        let chain = graph_for_path_at(&f.database, &target).unwrap().unwrap();
        assert_eq!(chain.artifacts.len(), before.artifacts.len());
        assert_eq!(
            chain
                .runs
                .iter()
                .find(|run| run.id == next)
                .unwrap()
                .input_ids,
            vec![f.id]
        );
    }

    #[test]
    fn save_suggests_suffixes_and_refuses_occupied_targets() {
        let f = fixture();
        let target = f.root.path().join("parent_edit.png");
        fs::write(&target, b"existing").unwrap();
        fs::create_dir(f.root.path().join("parent_edit_2.png")).unwrap();
        assert_eq!(
            suggestion_at(&f.database, &f.generated, f.id)
                .unwrap()
                .filename,
            "parent_edit_3.png"
        );
        assert!(matches!(
            save_at(&f.database, &f.generated, f.id, &target),
            Err(AppError::AlreadyExists(_))
        ));
        assert_eq!(fs::read(&target).unwrap(), b"existing");
        assert!(
            graph_for_path_at(&f.database, &f.source)
                .unwrap()
                .unwrap()
                .artifacts[0]
                .temporary
        );
        assert!(!f.root.path().read_dir().unwrap().any(|item| item
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".tauri-explorer-stage-")));
    }

    #[test]
    fn changed_images_invalid_ids_and_temporary_destinations_are_rejected() {
        let f = fixture();
        assert!(save_at(&f.database, &f.generated, 0, &f.root.path().join("out.png")).is_err());
        assert!(save_at(
            &f.database,
            &f.generated,
            f.id,
            &f.generated.join("copy.png")
        )
        .is_err());
        assert!(save_at(&f.database, &f.generated, f.id, Path::new("relative.png")).is_err());
        assert!(save_at(
            &f.database,
            &f.generated,
            f.id,
            &f.root.path().join("out.jpg")
        )
        .is_err());
        assert!(!f.root.path().join("out.jpg").exists());
        fs::write(&f.source, b"modified").unwrap();
        let target = f.root.path().join("out.png");
        assert!(save_at(&f.database, &f.generated, f.id, &target)
            .unwrap_err()
            .to_string()
            .contains("changed"));
        assert!(!target.exists());
    }

    #[test]
    fn restart_finishes_published_saves_and_ignores_unrelated_identical_files() {
        for published in [true, false] {
            let f = fixture();
            let target = f.root.path().join("out.png");
            let bytes = fs::read(&f.source).unwrap();
            let mut staged = StagedEntry::prepare(f.root.path(), |payload| {
                fs::write(payload, &bytes)?;
                Ok(())
            })
            .unwrap();
            let anchor = staged.trace_anchor().unwrap();
            let identity = crate::files::trace_file_identity(&anchor).unwrap();
            connection_at(&f.database).unwrap().execute("INSERT INTO image_saves(artifact_id,source_path,target_path,digest,object_identity,anchor_path) VALUES(?1,?2,?3,?4,?5,?6)",params![f.id,f.source.to_str(),target.to_str(),digest(&f.source).unwrap(),identity,anchor.to_str()]).unwrap();
            staged.retain_trace_anchor();
            if published {
                staged.publish(&target).unwrap();
            } else {
                drop(staged);
                fs::write(&target, &bytes).unwrap();
            }
            reconcile_unfinished_at(&f.database).unwrap();
            let path = if published { &target } else { &f.source };
            let graph = graph_for_path_at(&f.database, path).unwrap().unwrap();
            assert_eq!(graph.current_artifact_id, f.id);
            assert_eq!(graph.artifacts[0].temporary, !published);
            assert_eq!(fs::read(&f.source).unwrap(), bytes);
            assert_eq!(fs::read(&target).unwrap(), bytes);
        }
    }

    #[cfg(unix)]
    #[test]
    fn nonregular_unsaved_images_are_rejected_without_blocking() {
        use std::os::unix::ffi::OsStrExt;
        let f = fixture();
        fs::remove_file(&f.source).unwrap();
        let path = std::ffi::CString::new(f.source.as_os_str().as_bytes()).unwrap();
        // SAFETY: the NUL-terminated private fixture path lives for this call.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        // A blocking open of a FIFO with no writer never returns. A helper opens
        // the write end after a long delay, which would unblock a naive reader;
        // rejection must therefore be observed before that helper acts.
        let release_after = Duration::from_secs(60);
        let (sender, receiver) = std::sync::mpsc::channel();
        let target = f.root.path().join("saved.png");
        let (database, generated, id) = (f.database.clone(), f.generated.clone(), f.id);
        let save_target = target.clone();
        let saver = std::thread::spawn(move || {
            let rejected = save_at(&database, &generated, id, &save_target).is_err();
            sender.send(rejected).unwrap();
        });
        let (cancel, cancelled) = std::sync::mpsc::channel::<()>();
        let source = f.source.clone();
        let unblocker = std::thread::spawn(move || {
            if cancelled.recv_timeout(release_after).is_err() {
                // Only reached if the save call is still stuck: unblock it.
                let _ = fs::OpenOptions::new().write(true).open(&source);
                return true;
            }
            false
        });
        let rejected = receiver.recv().expect("save thread died");
        let _ = cancel.send(());
        let unblocked_by_helper = unblocker.join().unwrap();
        saver.join().unwrap();
        assert!(!unblocked_by_helper, "Save blocked on a FIFO until it was unblocked");
        assert!(rejected && !target.exists());
    }

    #[test]
    fn one_unavailable_save_does_not_disable_other_history() {
        let f = fixture();
        let stage = f.root.path().join(".tauri-explorer-stage-pending");
        fs::create_dir(&stage).unwrap();
        let anchor = stage.join("trace-anchor");
        fs::copy(&f.source, &anchor).unwrap();
        fs::write(stage.join("unrelated"), b"leave me alone").unwrap();
        let target = f.root.path().join("saved.png");
        connection_at(&f.database).unwrap().execute("INSERT INTO image_saves(artifact_id,source_path,target_path,digest,object_identity,anchor_path) VALUES(?1,?2,?3,?4,?5,?6)",params![f.id,f.source.to_str(),target.to_str(),digest(&f.source).unwrap(),crate::files::trace_file_identity(&anchor).unwrap(),anchor.to_str()]).unwrap();
        reconcile_unfinished_at(&f.database).unwrap();
        assert!(graph_for_path_at(&f.database, &f.source).unwrap().is_some());
        assert_eq!(
            fs::read(stage.join("unrelated")).unwrap(),
            b"leave me alone"
        );
        assert!(matches!(
            save_at(&f.database, &f.generated, f.id, &target),
            Err(AppError::MutationUncertain(_))
        ));
        assert!(!target.exists());
    }
}
