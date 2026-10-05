//! Resolve the CLI without depending on an interactive shell's startup files.
//! The selected installation's bin directory is also available to npm's Node
//! launcher, only in the child process; the application's environment is unchanged.
use super::invalid;
use crate::error::AppError;
use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

pub(super) struct CodexExecutable {
    pub program: PathBuf,
    pub search_path: OsString,
}

struct Environment {
    path: OsString,
    fallback_bins: Vec<PathBuf>,
}

fn version_key(name: &OsStr) -> Option<(u32, u32, u32)> {
    let mut parts = name.to_str()?.strip_prefix('v')?.split('.');
    let version = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(version)
}

fn nvm_bins(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root.join("versions/node")) else {
        return Vec::new();
    };
    let mut versions: Vec<_> = entries
        .take(128)
        .filter_map(Result::ok)
        .filter_map(|entry| version_key(&entry.file_name()).map(|key| (key, entry.path())))
        .collect();
    versions.sort_by_key(|(version, _)| std::cmp::Reverse(*version));
    versions
        .into_iter()
        .map(|(_, path)| path.join("bin"))
        .collect()
}

impl Environment {
    fn current() -> Self {
        let mut fallback_bins = Vec::new();
        for key in ["NVM_BIN", "VOLTA_HOME"] {
            if let Some(path) = std::env::var_os(key).map(PathBuf::from) {
                fallback_bins.push(if key == "VOLTA_HOME" {
                    path.join("bin")
                } else {
                    path
                });
            }
        }
        if let Some(prefix) = std::env::var_os("NPM_CONFIG_PREFIX").map(PathBuf::from) {
            fallback_bins.push(if cfg!(windows) {
                prefix
            } else {
                prefix.join("bin")
            });
        }
        let home = dirs::home_dir();
        let nvm = std::env::var_os("NVM_DIR")
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join(".nvm")));
        if let Some(root) = nvm.filter(|root| root.is_absolute()) {
            fallback_bins.extend(nvm_bins(&root));
        }
        if let Some(home) = &home {
            for bin in [
                ".local/bin",
                ".npm-global/bin",
                ".npm/bin",
                ".volta/bin",
                ".bun/bin",
            ] {
                fallback_bins.push(home.join(bin));
            }
        }
        #[cfg(windows)]
        {
            if let Some(appdata) = std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .or_else(|| home.map(|home| home.join("AppData/Roaming")))
            {
                fallback_bins.push(appdata.join("npm"));
            }
            if let Some(program_files) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
                fallback_bins.push(program_files.join("nodejs"));
            }
        }
        #[cfg(not(windows))]
        fallback_bins
            .extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
        Self {
            path: std::env::var_os("PATH").unwrap_or_default(),
            fallback_bins,
        }
    }

    fn bins(&self) -> Vec<PathBuf> {
        let mut seen = HashSet::new();
        std::env::split_paths(&self.path)
            .take(256)
            .chain(self.fallback_bins.iter().cloned())
            .filter(|path| path.is_absolute() && seen.insert(path.clone()))
            .collect()
    }
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn resolve_in(configured: &str, environment: &Environment) -> Result<CodexExecutable, AppError> {
    let bins = environment.bins();
    let configured = configured.trim();
    let program = if configured.is_empty() {
        let names: &[&str] = if cfg!(windows) {
            &["codex.exe", "codex.cmd"]
        } else {
            &["codex"]
        };
        bins.iter().flat_map(|bin| names.iter().map(move |name| bin.join(name)))
            .find(|path| executable(path))
            .ok_or_else(|| invalid("Codex CLI could not be found. In Settings → AI / OpenAI Images, set Codex executable path to the full path reported by command -v codex (Windows: where codex)."))?
    } else {
        let path = PathBuf::from(configured);
        if configured.len() > 8192 || configured.contains('\0') || !path.is_absolute() {
            return Err(invalid("Codex executable path must be an absolute file path, without shell arguments or quotes"));
        }
        if !executable(&path) {
            return Err(invalid("Configured Codex executable does not exist or is not executable. Correct Codex executable path in Settings → AI / OpenAI Images."));
        }
        path
    };
    // Retain the launcher path rather than canonicalizing an npm symlink into
    // node_modules: its original sibling Node executable must stay discoverable.
    let parent = program.parent().expect("absolute executable has a parent");
    let search_path = std::env::join_paths(std::iter::once(parent.to_path_buf()).chain(bins))
        .map_err(|_| invalid("Codex installation contains an invalid executable search path"))?;
    Ok(CodexExecutable {
        program,
        search_path,
    })
}

pub(super) fn resolve(configured: &str) -> Result<CodexExecutable, AppError> {
    resolve_in(configured, &Environment::current())
}

#[cfg(test)]
#[path = "../../test_support/codex_executable.rs"]
mod tests;
