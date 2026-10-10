use te_image_generation_contract::SafeError;
pub type Result<T> = std::result::Result<T, SafeError>;
pub fn error(code: &str, message: &str) -> SafeError {
    // Host reverse errors also enter durable receipts. Enforce the same public
    // bounds at construction so a malformed peer cannot poison our next start.
    let code = if te_image_generation_contract::valid_operation_id(code) {
        code
    } else {
        "host_unavailable"
    };
    let mut bounded = String::new();
    for c in message
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
    {
        if bounded.len() + c.len_utf8() > 2048 {
            break;
        }
        bounded.push(c);
    }
    if bounded.trim().is_empty() {
        bounded = "Image service failed".into();
    }
    SafeError {
        code: code.into(),
        message: bounded,
        correlation_id: None,
    }
}
pub fn storage(_: impl std::fmt::Display) -> SafeError {
    error(
        "storage_unavailable",
        "Image service storage is unavailable",
    )
}
pub fn invalid(message: &str) -> SafeError {
    error("invalid_request", message)
}
