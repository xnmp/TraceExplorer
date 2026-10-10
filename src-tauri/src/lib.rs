mod config;
mod error;
mod events;
mod files;
mod host_process;
pub mod host_rpc;
mod host_text;
mod host_image;
mod service_image_domain;
mod image_crop;
mod image_inputs;
mod image_operation;
// Historical adapter fixtures remain test-only. Production delegates image
// execution exclusively to the optional declared shared provider.
#[cfg(test)]
mod openai_image;
mod plugin_job;
#[cfg(test)]
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
