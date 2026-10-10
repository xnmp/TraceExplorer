//! Pure validation of durable, non-secret receipt identity and public bounds.
use super::{id, MAX_OUTPUT};
use te_image_generation_contract::*;

pub const MAX_STATUS: usize = 32 * 1024;
pub const MAX_RECIPE: usize = 256 * 1024;
pub struct StoredReceipt {
    pub caller: String,
    pub operation: String,
    pub semantic: String,
    pub context: Caller,
    pub recipe: Option<EffectiveRecipe>,
    pub status: OperationStatus,
    pub output_sha: Option<String>,
    pub output: Option<ArtifactDescriptor>,
    pub cancelled: bool,
    pub test: bool,
    pub admitted: i64,
    pub deadline: i64,
}
fn model(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
}
fn safe_error(error: &SafeError) -> bool {
    id(&error.code)
        && !error.message.trim().is_empty()
        && error.message.len() <= 2048
        && !error
            .message
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        && error.correlation_id.as_deref().is_none_or(id)
}
fn artifact(value: &ArtifactDescriptor) -> bool {
    id(&value.handle)
        && valid_digest(&value.sha256)
        && value.byte_length > 0
        && value.byte_length <= MAX_OUTPUT as u64
        && value.media_type == "image/png"
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
impl StoredReceipt {
    pub fn valid(&self) -> bool {
        let status = &self.status;
        let succeeded = matches!(status.execution, Execution::Succeeded { .. });
        if !id(&self.caller)
            || !valid_operation_id(&self.operation)
            || !valid_digest(&self.semantic)
            || self.context.package_id != self.caller
            || !valid_digest(&self.context.package_digest)
            || self.context.incarnation == 0
            || self.context.incarnation > 9_007_199_254_740_991
            || status.version != 1
            || status.operation_id != self.operation
            || !valid_digest(&status.request_fingerprint)
            || status.revision == 0
            || status.revision > 9_007_199_254_740_991
            || status.provider.package_id != "xnmp.image-generation"
            || status.provider.service_id != "image-generation"
            || status.provider.major != 1
            || self.admitted < 0
            || self.deadline < self.admitted
            || self.deadline - self.admitted > 900_000
            || (self.admitted == 0 && self.deadline != 0)
            || status
                .diagnostics
                .as_ref()
                .is_some_and(|d| !d.valid(succeeded))
            || self.output_sha.as_deref().is_some_and(|v| !valid_digest(v))
            || self
                .output
                .as_ref()
                .is_some_and(|a| !artifact(a) || Some(&a.sha256) != self.output_sha.as_ref())
        {
            return false;
        }
        if let Execution::Failed { error } | Execution::Unknown { error } = &status.execution {
            if !safe_error(error) {
                return false;
            }
        }
        let Some(recipe) = &self.recipe else {
            return matches!(status.execution, Execution::Failed { .. })
                && status.delivery == (Delivery::None {})
                && status.diagnostics.is_none()
                && self.output_sha.is_none()
                && self.output.is_none()
                && self.admitted == 0
                && self.deadline == 0;
        };
        if recipe.schema_version != 1
            || recipe.formatter_version != 1
            || !id(&recipe.connection_id)
            || !id(&recipe.connection_revision)
            || !matches!(recipe.adapter.as_str(), "openai-images" | "codex-cli")
            || recipe.endpoint_identity.len() > 8192
            || recipe.endpoint_identity.chars().any(char::is_control)
            || !recipe.options.valid()
            || recipe.input_digests.len() > 8
            || recipe.input_digests.iter().any(|d| !valid_digest(d))
            || recipe.input_roles
                != (1..=recipe.input_digests.len())
                    .map(|i| format!("Image {i}"))
                    .collect::<Vec<_>>()
            || recipe.submitted_prompt.trim().is_empty()
            || recipe.submitted_prompt.len() > 100 * 1024
            || recipe
                .agent_task
                .as_ref()
                .is_some_and(|v| v.trim().is_empty() || v.len() > 100 * 1024)
            || recipe.digest() != status.request_fingerprint
        {
            return false;
        }
        // Old private CLI receipts may carry the previous empty discovery identity.
        // Preserve their canonical digest; all newly prepared recipes use the sentinel.
        if recipe.adapter == "openai-images" {
            if !url::Url::parse(&recipe.endpoint_identity).is_ok_and(|url| {
                matches!(url.scheme(), "http" | "https")
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
            }) || !recipe.model.as_deref().is_some_and(model)
                || recipe.agent_task.is_some()
                || status.diagnostics.is_some()
            {
                return false;
            }
        } else if recipe.model.is_some() || recipe.agent_task.is_none() {
            return false;
        }
        if let Execution::Succeeded { metadata } = &status.execution {
            if metadata.adapter != recipe.adapter
                || metadata.endpoint_identity != recipe.endpoint_identity
                || metadata.requested_model != recipe.model
                || metadata.options != recipe.options
                || metadata.actual_model.as_deref().is_some_and(|v| !model(v))
                || metadata
                    .external_request_id
                    .as_deref()
                    .is_some_and(|v| !id(v))
                || metadata.thread_id.as_deref().is_some_and(|v| !uuid(v))
                || self.output_sha.is_none()
            {
                return false;
            }
            if let Some(OperationDiagnostics::CodexImageTurn {
                thread_id,
                turn_state,
                ..
            }) = &status.diagnostics
            {
                if metadata.thread_id.as_ref() != Some(thread_id)
                    || *turn_state != CodexTurnState::Completed
                {
                    return false;
                }
            }
            if recipe.adapter == "openai-images" && metadata.thread_id.is_some() {
                return false;
            }
            match &status.delivery {
                Delivery::Available { output } => {
                    artifact(output) && self.output.as_ref() == Some(output)
                }
                Delivery::Acquired { transfer_receipt } => {
                    id(transfer_receipt) && self.output.is_some()
                }
                Delivery::Discarded {} => true,
                Delivery::Unavailable { reason } => matches!(
                    reason.as_str(),
                    "missing" | "corrupt" | "storage_unavailable"
                ),
                Delivery::None {} => false,
            }
        } else {
            status.delivery == (Delivery::None {})
                && self.output.is_none()
                && self.output_sha.is_none()
        }
    }
}
