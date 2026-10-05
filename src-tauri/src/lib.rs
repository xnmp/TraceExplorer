mod config;
mod error;
mod events;
mod files;
pub mod host_process;
mod image_crop;
mod image_operation;
mod openai_image;
mod plugin_job;
mod process_ext;
mod protocol;
mod temporary_output;
mod trace;

pub use config::initialize;
pub use error::AppError;
pub use events::EventEmitter;
pub use plugin_job::shutdown_jobs;
pub use protocol::{dispatch, Request, MAX_MESSAGE_BYTES};

#[cfg(test)]
#[path = "../test_support/mod.rs"]
mod test_support;
