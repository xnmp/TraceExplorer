//! Trace's provider-independent image intent. No credentials or executable paths.
use crate::{error::AppError, trace::jobs::ImageBatch};
use serde::{Deserialize, Serialize};
use te_image_generation_contract::ImageOptions;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageRequest {
    pub connection_id: String,
    pub expected_connection_revision: String,
    pub model: Option<String>,
    pub source_path: Option<String>,
    pub expected_source_digest: Option<String>,
    #[serde(default)]
    pub reference_paths: Vec<String>,
    #[serde(default)]
    pub expected_reference_digests: Vec<String>,
    pub prompt: String,
    pub output_dir: String,
    pub output_filename: String,
    pub size: String,
    pub resolution: Option<String>,
    pub aspect_ratio: Option<String>,
    pub quality: String,
    pub background: String,
    pub batch: Option<ImageBatch>,
    pub retry_of: Option<i64>,
}
impl ImageRequest {
    pub(crate) fn options(&self) -> ImageOptions {
        ImageOptions {
            size: self.size.clone(),
            resolution: self.resolution.clone(),
            aspect_ratio: self.aspect_ratio.clone(),
            quality: self.quality.clone(),
            background: self.background.clone(),
        }
    }
    pub(crate) fn inputs(&self) -> Result<Vec<(String, Option<String>)>, AppError> {
        if self.source_path.is_none() && self.expected_source_digest.is_some()
            || !self.expected_reference_digests.is_empty()
                && self.expected_reference_digests.len() != self.reference_paths.len()
        {
            return Err(AppError::Other(
                "Input revisions do not match the ordered image inputs".into(),
            ));
        }
        let inputs: Vec<_> = self
            .source_path
            .iter()
            .map(|path| (path.clone(), self.expected_source_digest.clone()))
            .chain(
                self.reference_paths
                    .iter()
                    .enumerate()
                    .map(|(index, path)| {
                        (
                            path.clone(),
                            self.expected_reference_digests.get(index).cloned(),
                        )
                    }),
            )
            .collect();
        if inputs.len() > 8
            || inputs.iter().any(|(path, digest)| {
                !std::path::Path::new(path).is_absolute()
                    || path.len() > 4096
                    || path.contains('\0')
                    || digest
                        .as_ref()
                        .is_some_and(|digest| !te_image_generation_contract::valid_digest(digest))
            })
        {
            return Err(AppError::Other(
                "Invalid image inputs; choose at most eight local images".into(),
            ));
        }
        Ok(inputs)
    }
    pub(crate) fn validate(&self) -> Result<(), AppError> {
        if !te_image_generation_contract::valid_operation_id(&self.connection_id)
            || !te_image_generation_contract::valid_operation_id(&self.expected_connection_revision)
            || self.prompt.trim().is_empty()
            || self.prompt.len() > 16000
            || self.prompt.contains('\0')
            || self.model.as_ref().is_some_and(|model| {
                model.trim().is_empty()
                    || model.chars().count() > 256
                    || model.chars().any(char::is_control)
            })
            || self.retry_of.is_some_and(|id| id <= 0)
            || self.output_dir.len() > 4096
            || self.output_dir.contains('\0')
            || self.output_filename.len() > 256
            || self.output_filename.contains('\0')
        {
            return Err(AppError::Other("Invalid image request".into()));
        }
        self.inputs()?;
        if !self.options().valid() {
            return Err(AppError::Other("Unsupported image options".into()));
        }
        if let Some(batch) = &self.batch {
            batch.validate()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> ImageRequest {
        serde_json::from_value(serde_json::json!({"connectionId":"my.profile_1","expectedConnectionRevision":"revision-1","model":"任意のモデル","sourcePath":null,"prompt":"Draw an image","outputDir":"","outputFilename":"image.png","size":"1024x1024","quality":"auto","background":"auto"})).unwrap()
    }
    #[test]
    fn arbitrary_model_and_adapter_managed_model_are_supported() {
        let mut request=request();request.validate().unwrap();request.model=None;request.validate().unwrap();
    }
    #[test]
    fn malformed_options_revisions_and_large_inputs_fail_before_capture() {
        let mut bad=request();bad.size="18446744073709551615x18446744073709551615".into();assert!(bad.validate().is_err());
        let mut bad=request();bad.expected_source_digest=Some("a".repeat(64));assert!(bad.validate().is_err());
        let mut bad=request();bad.reference_paths=vec!["/image.png".into();9];assert!(bad.validate().is_err());
        let mut bad=request();bad.prompt="a".repeat(16001);assert!(bad.validate().is_err());
        let mut bad=request();bad.prompt="Draw\0image".into();assert!(bad.validate().is_err());
    }
    #[test]
    fn provider_credentials_and_executables_are_not_consumer_parameters() {
        let mut value=serde_json::to_value(request()).unwrap();
        value["apiKey"]="secret".into();assert!(serde_json::from_value::<ImageRequest>(value).is_err());
    }
}
