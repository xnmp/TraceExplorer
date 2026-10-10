//! Atomic, file-locked CAS public metadata. Immutable OS secret records live in host.
use crate::{
    domain::{validate_configuration, Configuration, Credential, Profile},
    error::{error, storage, Result},
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    schema_version: u32,
    configuration: Configuration,
    retired_profile_ids: Vec<String>,
    #[serde(default)]
    imports: Vec<ImportReceipt>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportReceipt {
    source_id: String,
    source_digest: String,
    profile_ids: Vec<String>,
}
fn valid_import_source(source: &str) -> bool {
    const ORIGINAL: &str = "trace-openai-image-v1";
    source == ORIGINAL
        || source
            .strip_prefix(ORIGINAL)
            .and_then(|suffix| suffix.strip_prefix('.'))
            .is_some_and(|epoch| {
                epoch.len() == 32
                    && epoch
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
}
fn imported(receipt: &ImportReceipt) -> serde_json::Value {
    serde_json::json!({"version":1,"state":"imported","sourceDigest":receipt.source_digest,"profileIds":receipt.profile_ids})
}
pub type DirectorySync = Arc<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>;

pub fn directory_sync() -> DirectorySync {
    Arc::new(te_plugin_runtime::durable_dir::sync)
}

pub struct Profiles {
    directory: PathBuf,
    sync_directory: DirectorySync,
}
pub fn nonce() -> Result<String> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(storage)?;
    Ok(hex::encode(bytes))
}
impl Profiles {
    pub fn new(directory: &Path) -> Self {
        Self::with_directory_sync(directory, directory_sync())
    }
    pub fn with_directory_sync(directory: &Path, sync_directory: DirectorySync) -> Self {
        Self {
            directory: directory.into(),
            sync_directory,
        }
    }
    fn locked<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let file = private_open(&self.directory.join("profiles.lock"), true)?;
        file.lock_exclusive().map_err(storage)?;
        operation()
    }
    fn read_document(&self) -> Result<Document> {
        let path = self.directory.join("profiles.json");
        if matches!(std::fs::symlink_metadata(&path),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        {
            return Ok(Document {
                schema_version: 1,
                configuration: Configuration::default(),
                retired_profile_ids: vec![],
                imports: vec![],
            });
        }
        let mut file = private_open(&path, false)?;
        if file.metadata().map_err(storage)?.len() > 256 * 1024 {
            return Err(error(
                "unavailable",
                "Image profiles document exceeds its limit",
            ));
        }
        let mut bytes = vec![];
        Read::by_ref(&mut file)
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(storage)?;
        let mut doc: Document = serde_json::from_slice(&bytes).map_err(|_| {
            error(
                "unavailable",
                "Image profiles document is malformed; repair it before using generation",
            )
        })?;
        if doc.schema_version != 1 {
            return Err(error("unavailable", "Image profiles schema is unsupported"));
        }
        validate_configuration(&mut doc.configuration).map_err(|_| {
            error(
                "unavailable",
                "Image profiles document is invalid; repair it before preparing new work",
            )
        })?;
        if doc
            .configuration
            .profiles
            .iter()
            .any(|p| !crate::domain::id(p.revision()))
        {
            return Err(error(
                "unavailable",
                "Image profile execution revision is invalid",
            ));
        }
        let mut import_sources = std::collections::HashSet::new();
        let invalid_history = doc
            .retired_profile_ids
            .iter()
            .any(|id| !crate::domain::id(id))
            || doc
                .retired_profile_ids
                .iter()
                .enumerate()
                .any(|(i, id)| doc.retired_profile_ids[..i].contains(id))
            || doc
                .configuration
                .profiles
                .iter()
                .any(|profile| doc.retired_profile_ids.iter().any(|id| id == profile.id()))
            || doc.imports.iter().any(|receipt| {
                !valid_import_source(&receipt.source_id)
                    || !import_sources.insert(&receipt.source_id)
                    || !te_image_generation_contract::valid_digest(&receipt.source_digest)
                    || receipt.profile_ids.len() > 32
                    || receipt.profile_ids.iter().any(|id| !crate::domain::id(id))
                    || receipt
                        .profile_ids
                        .iter()
                        .enumerate()
                        .any(|(i, id)| receipt.profile_ids[..i].contains(id))
            });
        if invalid_history {
            return Err(error(
                "unavailable",
                "Image profile history is invalid; repair it before preparing new work",
            ));
        }
        Ok(doc)
    }
    pub fn preflight_read(&self) -> Result<Configuration> {
        Ok(self.read_document()?.configuration)
    }
    pub fn read(&self) -> Result<Configuration> {
        self.locked(|| Ok(self.read_document()?.configuration))
    }
    fn write(&self, document: &Document) -> Result<()> {
        let bytes = serde_json::to_vec(document).map_err(storage)?;
        if bytes.len() > 256 * 1024 {
            return Err(error(
                "busy",
                "Image profile history reached its storage limit",
            ));
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory).map_err(storage)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(storage)?;
        }
        temporary.write_all(&bytes).map_err(storage)?;
        temporary.as_file().sync_all().map_err(storage)?;
        replace(temporary, &self.directory.join("profiles.json"))?;
        (self.sync_directory)(&self.directory).map_err(|_| {
            error(
                "mutation_uncertain",
                "Image profile change may have committed; reload saved connections before retrying",
            )
        })?;
        Ok(())
    }
    pub fn save(
        &self,
        mut next: Configuration,
        expected: u64,
        allow_new_secret: Option<(&str, &str)>,
        force_rotation: Option<&str>,
    ) -> Result<Configuration> {
        self.locked(|| {
            let mut old = self.read_document()?;
            if old.configuration.document_revision != expected {
                return Err(error(
                    "configuration_changed",
                    "Image connections changed; reload before saving",
                ));
            }
            validate_configuration(&mut next)?;
            for profile in &mut next.profiles {
                let previous = old
                    .configuration
                    .profiles
                    .iter()
                    .find(|p| p.id() == profile.id());
                if previous.is_none() && old.retired_profile_ids.iter().any(|id| id == profile.id())
                {
                    return Err(error(
                        "configuration_changed",
                        "Deleted profile IDs cannot be reused",
                    ));
                }
                if let Credential::Secret { id } = profile.credential() {
                    if previous.is_none_or(|p| p.credential() != profile.credential())
                        && allow_new_secret != Some((profile.id(), id.as_str()))
                    {
                        return Err(error(
                            "invalid_request",
                            "Save a key with the write-only credential command",
                        ));
                    }
                }
                let revision = previous
                    .filter(|p| {
                        Some(p.id()) != force_rotation
                            && p.execution_identity() == profile.execution_identity()
                    })
                    .map(|p| p.revision().to_owned())
                    .unwrap_or(nonce()?);
                profile.set_revision(revision);
            }
            for previous in &old.configuration.profiles {
                if !next.profiles.iter().any(|p| p.id() == previous.id()) {
                    old.retired_profile_ids.push(previous.id().into())
                }
            }
            next.document_revision = expected
                .checked_add(1)
                .ok_or_else(|| error("unavailable", "Image configuration revision exhausted"))?;
            old.configuration = next.clone();
            self.write(&old)?;
            Ok(next)
        })
    }
    /// Linearize admission with profile CAS after external credential/input reads.
    /// The callback may perform bounded local journal IO only.
    pub fn admit<T>(&self, snapshot: &Profile, accept: impl FnOnce() -> Result<T>) -> Result<T> {
        self.locked(|| {
            let current = self
                .read_document()?
                .configuration
                .profiles
                .into_iter()
                .find(|p| p.id() == snapshot.id())
                .ok_or_else(|| {
                    error(
                        "configuration_changed",
                        "Image connection was deleted before admission",
                    )
                })?;
            if current.revision() != snapshot.revision()
                || current.execution_identity() != snapshot.execution_identity()
            {
                return Err(error(
                    "configuration_changed",
                    "Image connection changed before admission; prepare again",
                ));
            }
            accept()
        })
    }
    pub fn import_status(&self, source: &str) -> Result<serde_json::Value> {
        if !valid_import_source(source) {
            return Err(error("invalid_request", "Unknown image migration source"));
        }
        self.locked(|| {
            let document = self.read_document()?;
            Ok(document
                .imports
                .iter()
                .find(|r| r.source_id == source)
                .map(imported)
                .unwrap_or_else(|| serde_json::json!({"version":1,"state":"absent"})))
        })
    }
    pub fn import(&self, params: &serde_json::Value) -> Result<serde_json::Value> {
        self.locked(|| {
            let source = params["sourceId"]
                .as_str()
                .ok_or_else(|| error("invalid_request", "Migration source is required"))?;
            let digest = params["sourceDigest"]
                .as_str()
                .ok_or_else(|| error("invalid_request", "Migration digest is required"))?;
            let mut document = self.read_document()?;
            if let Some(receipt) = document.imports.iter().find(|r| r.source_id == source) {
                if receipt.source_digest != digest {
                    return Err(error(
                        "operation_conflict",
                        "Image migration source already has a different receipt",
                    ));
                }
                return Ok(imported(receipt));
            }
            if !valid_import_source(source) || !te_image_generation_contract::valid_digest(digest) {
                return Err(error(
                    "invalid_request",
                    "Invalid image migration source or digest",
                ));
            }
            let expected = params["expectedRevision"].as_u64().ok_or_else(|| {
                error("invalid_request", "Migration expected revision is required")
            })?;
            if expected != document.configuration.document_revision {
                return Err(error(
                    "configuration_changed",
                    "Image connections changed before migration",
                ));
            }
            let mut profiles: Vec<Profile> = serde_json::from_value(params["profiles"].clone())
                .map_err(|_| error("invalid_request", "Malformed imported image profiles"))?;
            let default: Option<String> = serde_json::from_value(
                params
                    .get("defaultConnectionId")
                    .cloned()
                    .ok_or_else(|| error("invalid_request", "Migration default is required"))?,
            )
            .map_err(|_| error("invalid_request", "Malformed migration default"))?;
            for profile in &mut profiles {
                if document
                    .configuration
                    .profiles
                    .iter()
                    .any(|p| p.id() == profile.id())
                    || document
                        .retired_profile_ids
                        .iter()
                        .any(|id| id == profile.id())
                {
                    return Err(error(
                        "operation_conflict",
                        "Imported profile ID already exists or was retired",
                    ));
                }
                profile.set_revision(nonce()?)
            }
            let profile_ids = profiles
                .iter()
                .map(|p| p.id().to_owned())
                .collect::<Vec<_>>();
            if default.as_ref().is_some_and(|id| !profile_ids.contains(id)) {
                return Err(error(
                    "invalid_request",
                    "Imported default must select an imported profile",
                ));
            }
            let copy_default = document.configuration.document_revision == 0
                && document.configuration.profiles.is_empty()
                && document.configuration.default_connection_id.is_none();
            document.configuration.profiles.extend(profiles);
            if copy_default {
                document.configuration.default_connection_id = default
            }
            validate_configuration(&mut document.configuration)?;
            document.configuration.document_revision = expected
                .checked_add(1)
                .ok_or_else(|| error("unavailable", "Image configuration revision exhausted"))?;
            let receipt = ImportReceipt {
                source_id: source.into(),
                source_digest: digest.into(),
                profile_ids,
            };
            document.imports.push(receipt.clone());
            self.write(&document)?;
            Ok(imported(&receipt))
        })
    }
    pub fn rotate(
        &self,
        profile_id: &str,
        credential: Credential,
        expected: u64,
    ) -> Result<Configuration> {
        let mut configuration = self.read()?;
        let profile = configuration
            .profiles
            .iter_mut()
            .find(|p| p.id() == profile_id)
            .ok_or_else(|| error("invalid_request", "Unknown image profile"))?;
        if matches!(profile, Profile::Codex { .. }) {
            return Err(error(
                "invalid_request",
                "Codex login is managed by the CLI",
            ));
        }
        *profile.credential_mut() = credential.clone();
        let secret = if let Credential::Secret { id } = &credential {
            Some((profile_id, id.as_str()))
        } else {
            None
        };
        self.save(configuration, expected, secret, Some(profile_id))
    }
}
fn private_open(path: &Path, create: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(create).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(storage)?;
    if !file.metadata().map_err(storage)?.is_file() {
        return Err(error(
            "unavailable",
            "Image service metadata must be a regular file",
        ));
    }
    Ok(file)
}
#[cfg(not(windows))]
fn replace(file: tempfile::NamedTempFile, path: &Path) -> Result<()> {
    file.persist(path).map_err(storage)?;
    Ok(())
}
#[cfg(windows)]
fn replace(file: tempfile::NamedTempFile, path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let from: Vec<_> = file
        .path()
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let to: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
        return Err(storage(std::io::Error::last_os_error()));
    }
    Ok(())
}
