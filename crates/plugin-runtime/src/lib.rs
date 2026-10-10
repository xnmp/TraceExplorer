//! Narrow stdio/reverse host transport shared by independent native packages.
//! No Tauri, Trace persistence, image policy or provider adapter dependency.
pub mod durable_dir;
pub mod process;
mod rpc;
pub use rpc::{configure, deliver, disconnected, invoke, notify, HostRpcClient};
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Other(String),
    #[error("{message}")]
    Remote { code: String, message: String },
}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::Other("Plugin transport IO failed".into())
    }
}
impl Error {
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Remote { code, .. } => Some(code),
            _ => None,
        }
    }
}
