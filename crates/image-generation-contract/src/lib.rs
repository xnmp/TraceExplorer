//! Image service v1 wire values and canonical non-secret prepared recipe.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactDescriptor {
    pub handle: String,
    pub sha256: String,
    pub byte_length: u64,
    pub media_type: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Caller {
    pub package_id: String,
    pub package_digest: String,
    pub incarnation: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageOptions {
    pub size: String,
    pub resolution: Option<String>,
    pub aspect_ratio: Option<String>,
    pub quality: String,
    pub background: String,
}
impl ImageOptions {
    pub fn valid(&self) -> bool {
        let size = self.size == "auto"
            || self
                .size
                .split_once('x')
                .and_then(|(w, h)| Some((w.parse::<u64>().ok()?, h.parse::<u64>().ok()?)))
                .is_some_and(|(w, h)| {
                    w > 0
                        && h > 0
                        && w <= 3840
                        && h <= 3840
                        && w % 16 == 0
                        && h % 16 == 0
                        && w <= h * 3
                        && h <= w * 3
                        && (655360..=8294400).contains(&(w * h))
                });
        size && matches!(self.quality.as_str(), "auto" | "low" | "medium" | "high")
            && matches!(self.background.as_str(), "auto" | "opaque" | "transparent")
            && self
                .resolution
                .as_deref()
                .is_none_or(|v| matches!(v, "1k" | "2k" | "4k"))
            && self.aspect_ratio.as_deref().is_none_or(|v| {
                matches!(
                    v,
                    "keep" | "1:1" | "4:3" | "3:4" | "3:2" | "2:3" | "16:9" | "9:16"
                )
            })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    pub operation_id: String,
    pub connection_id: String,
    pub expected_connection_revision: String,
    pub model: Option<String>,
    pub prompt: String,
    pub inputs: Vec<ArtifactDescriptor>,
    pub options: ImageOptions,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectiveRecipe {
    pub schema_version: u32,
    pub formatter_version: u32,
    pub connection_id: String,
    pub connection_revision: String,
    pub adapter: String,
    pub endpoint_identity: String,
    pub model: Option<String>,
    pub options: ImageOptions,
    pub input_digests: Vec<String>,
    pub input_roles: Vec<String>,
    pub submitted_prompt: String,
    pub agent_task: Option<String>,
}
impl EffectiveRecipe {
    /// Canonical UTF8 serde_json fixed-struct-field order; Options serialize null,
    /// arrays retain input order. Handles, secrets, names and caller epoch excluded.
    pub fn digest(&self) -> String {
        hex::encode(Sha256::digest(
            serde_json::to_vec(self).expect("recipe serialization"),
        ))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preparation {
    pub preparation_token: String,
    pub effective_recipe: EffectiveRecipe,
    pub effective_recipe_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    pub operation_id: String,
    pub connection_id: String,
    pub expected_connection_revision: String,
    pub preparation_token: String,
    pub effective_recipe_digest: String,
    pub model: Option<String>,
    pub prompt: String,
    pub inputs: Vec<ArtifactDescriptor>,
    pub options: ImageOptions,
}
impl StartRequest {
    pub fn prepared(&self) -> PrepareRequest {
        PrepareRequest {
            operation_id: self.operation_id.clone(),
            connection_id: self.connection_id.clone(),
            expected_connection_revision: self.expected_connection_revision.clone(),
            model: self.model.clone(),
            prompt: self.prompt.clone(),
            inputs: self.inputs.clone(),
            options: self.options.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeError {
    pub code: String,
    pub message: String,
    pub correlation_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageMetadata {
    pub adapter: String,
    pub endpoint_identity: String,
    pub requested_model: Option<String>,
    pub actual_model: Option<String>,
    pub external_request_id: Option<String>,
    pub thread_id: Option<String>,
    pub options: ImageOptions,
    pub remote_charge_uncertain: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum Execution {
    Accepted {},
    Running {},
    Succeeded { metadata: ImageMetadata },
    Failed { error: SafeError },
    Cancelled {},
    Unknown { error: SafeError },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
    ,deny_unknown_fields
)]
pub enum Delivery {
    None {},
    Available { output: ArtifactDescriptor },
    Acquired { transfer_receipt: String },
    Discarded {},
    Unavailable { reason: String },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderIdentity {
    pub package_id: String,
    pub service_id: String,
    pub major: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexTurnState { Completed, Failed, Incomplete }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExplanationKind { Reply, Error }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FailedExplanation {
    pub kind: ExplanationKind,
    pub text: String,
    pub truncated: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum OperationDiagnostics {
    CodexImageTurn {
        thread_id: String,
        turn_state: CodexTurnState,
        usage: Option<TokenUsage>,
        explanation: Option<FailedExplanation>,
    },
}
impl OperationDiagnostics {
    pub fn valid(&self, succeeded: bool) -> bool {
        match self {
            Self::CodexImageTurn { thread_id, usage, explanation, .. } => {
                thread_id.len() == 36 && thread_id.bytes().enumerate().all(|(i,b)| if matches!(i,8|13|18|23) { b == b'-' } else { b.is_ascii_hexdigit() })
                    && usage.as_ref().is_none_or(|u| [u.input_tokens,u.cached_input_tokens,u.output_tokens].iter().all(|v|v.is_none_or(|v|v <= 9_007_199_254_740_991)))
                    && explanation.as_ref().is_none_or(|e| !succeeded && !e.text.trim().is_empty() && e.text.len() <= 4096 && !e.text.chars().any(|c|c.is_control() && !matches!(c,'\n'|'\r'|'\t')))
            }
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationStatus {
    pub version: u32,
    pub operation_id: String,
    pub request_fingerprint: String,
    pub provider: ProviderIdentity,
    pub revision: u64,
    pub execution: Execution,
    pub delivery: Delivery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<OperationDiagnostics>,
}
pub fn valid_operation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
pub fn valid_digest(digest: &str) -> bool {
    digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit())
}
