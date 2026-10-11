//! Per-backend profile rules, read from `plugins/image-generation/backends.json`.
//!
//! That file is the single source of truth: the frontend enforces the same
//! fields in `frontend/domain.ts`. A backend with no entry (the test-only
//! fixture) has no extra rules.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendRules {
    pub transport: String,
    pub base_url_label: String,
    /// Case-insensitive; matched against every path segment of the base URL.
    /// A trailing `*` makes the entry a prefix match.
    pub rejected_path_segments: Vec<String>,
    /// The model id becomes a URL path segment, so it must be one.
    pub model_id_in_path: bool,
}

static RULES: OnceLock<Vec<BackendRules>> = OnceLock::new();

/// Every entry of `backends.json`; panics on a malformed file (a build defect,
/// caught by the first test run).
pub fn all() -> &'static [BackendRules] {
    RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../backends.json"))
            .expect("backends.json must match the backend rules schema")
    })
}

pub fn for_transport(transport: &str) -> Option<&'static BackendRules> {
    all().iter().find(|r| r.transport == transport)
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`: safe as one URL path segment.
pub fn path_safe_model_id(value: &str) -> bool {
    value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn matches(pattern: &str, segment: &str) -> bool {
    let (pattern, segment) = (pattern.to_ascii_lowercase(), segment.to_ascii_lowercase());
    match pattern.strip_suffix('*') {
        Some(prefix) => segment.starts_with(prefix),
        None => segment == pattern,
    }
}

impl BackendRules {
    /// The first base-URL path segment this backend refuses, with its pattern.
    pub fn rejected_segment<'a>(&'a self, url: &'a url::Url) -> Option<(&'a str, &'a str)> {
        url.path_segments()?.find_map(|segment| {
            self.rejected_path_segments
                .iter()
                .find(|p| matches(p, segment))
                .map(|p| (segment, p.as_str()))
        })
    }

    pub fn base_url_problem(&self, url: &url::Url) -> Option<String> {
        self.rejected_segment(url).map(|(segment, pattern)| {
            format!(
                "The {} cannot contain the path segment /{segment}{}",
                self.base_url_label,
                if pattern.ends_with('*') {
                    " (segments starting with that prefix are reserved)"
                } else {
                    ""
                }
            )
        })
    }

    /// `None` when `model` is acceptable for this backend.
    pub fn model_problem(&self, model: &str) -> Option<&'static str> {
        (self.model_id_in_path && !path_safe_model_id(model)).then_some(MODEL_IN_PATH_MESSAGE)
    }
}

pub const MODEL_IN_PATH_MESSAGE: &str = "The model ID can contain only letters, digits, '.', '_' and '-', start with a letter or digit, and be at most 128 characters";
