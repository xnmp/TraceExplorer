//! Job presentation rules and bounded provider billing, independent of providers.
use super::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct JobCost {
    pub amount: String,
    pub currency: String,
    pub estimated: bool,
    pub source: String,
}
impl JobCost {
    pub fn valid(&self) -> bool {
        let (whole, fraction) = self.amount.split_once('.').unwrap_or((&self.amount, ""));
        !whole.is_empty()
            && whole.bytes().all(|b| b.is_ascii_digit())
            && (!self.amount.contains('.') || !fraction.is_empty())
            && fraction.len() <= 6
            && fraction.bytes().all(|b| b.is_ascii_digit())
            && self.currency.len() == 3
            && self.currency.bytes().all(|b| b.is_ascii_uppercase())
            && self.source.chars().count() <= 64
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BillingEvidence {
    schema: String,
    values: BTreeMap<String, Value>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProviderBilling {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<JobCost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    evidence: Option<BillingEvidence>,
}
impl ProviderBilling {
    pub fn valid(&self) -> bool {
        self.cost.as_ref().is_none_or(JobCost::valid)
            && self.evidence.as_ref().is_none_or(|e| {
                e.schema.chars().count() <= 64
                    && e.values.len() <= 32
                    && e.values.iter().all(|(k, v)| {
                        k.chars().count() <= 64
                            && match v {
                                Value::String(s) => s.chars().count() <= 128,
                                Value::Number(_) | Value::Bool(_) | Value::Null => true,
                                _ => false,
                            }
                    })
            })
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum JobReveal {
    File {
        path: String,
    },
    View {
        view_id: String,
        directory: String,
        target_id: String,
    },
}
/// Storage metadata, never a path heuristic, decides whether a file is saved.
fn reveal(
    artifact: i64,
    path: &str,
    storage: Option<&str>,
    folder: Option<&str>,
) -> Option<JobReveal> {
    if storage == Some("saved") {
        Some(JobReveal::File { path: path.into() })
    } else {
        folder.map(|directory| JobReveal::View {
            view_id: "trace.view".into(),
            directory: directory.into(),
            target_id: format!("artifact:{artifact}"),
        })
    }
}
/// Re-read publication metadata and the current artifact locator on every call.
pub(crate) fn current(
    connection: &Connection,
    run: i64,
) -> Result<(Option<JobReveal>, Option<JobCost>), AppError> {
    let (parameters, details): (String, Option<String>) = connection
        .query_row(
            "SELECT parameters,result_details FROM runs WHERE id=?1",
            [run],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql)?;
    let parameters: Value =
        serde_json::from_str(&parameters).map_err(|e| AppError::Other(e.to_string()))?;
    let details: Value = details
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| AppError::Other(e.to_string()))?
        .unwrap_or(Value::Null);
    let cost = details
        .get("provider_billing")
        .and_then(|b| b.get("cost"))
        .cloned()
        .and_then(|v| serde_json::from_value::<JobCost>(v).ok())
        .filter(JobCost::valid);
    let artifact: Option<(i64,String)> = connection.query_row(
        "SELECT id,path FROM artifacts WHERE generating_run=?1 AND id NOT IN (SELECT artifact_id FROM image_discards WHERE completed=1) ORDER BY id DESC LIMIT 1",
        [run], |r|Ok((r.get(0)?,r.get(1)?)),
    ).optional().map_err(sql)?;
    let folder: Option<String> = connection
        .query_row(
            "SELECT folder FROM image_folder_contexts WHERE run_id=?1",
            [run],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    Ok((
        artifact.and_then(|(id, path)| {
            reveal(
                id,
                &path,
                parameters["output_storage"].as_str(),
                folder.as_deref(),
            )
        }),
        cost,
    ))
}
pub(crate) fn extend(
    mut value: Value,
    reveal: Option<JobReveal>,
    cost: Option<JobCost>,
    reveal_supported: bool,
    cost_supported: bool,
) -> Value {
    if reveal_supported {
        if let Some(reveal) = reveal {
            value["reveal"] = json!(reveal);
        }
    }
    if cost_supported {
        if let Some(cost) = cost {
            value["cost"] = json!(cost);
        }
    }
    value
}
pub(crate) fn for_run(connection: &Connection, run: i64, value: Value) -> Result<Value, AppError> {
    let reveal_supported = crate::host_image::job_reveal_supported();
    let cost_supported = crate::host_image::job_cost_supported();
    if !reveal_supported && !cost_supported {
        return Ok(value);
    }
    let (reveal, cost) = current(connection, run)?;
    Ok(extend(
        value,
        reveal,
        cost,
        reveal_supported,
        cost_supported,
    ))
}
pub(crate) fn completion(job: u64, value: Value) -> Value {
    if !crate::host_image::job_cost_supported() && !crate::host_image::job_reveal_supported() {
        return value;
    }
    let result = (|| {
        let connection = connection_at(&database_path()?)?;
        let run: i64 = connection
            .query_row(
                "SELECT run_id FROM image_jobs WHERE job_id=?1",
                [job as i64],
                |r| r.get(0),
            )
            .map_err(sql)?;
        for_run(&connection, run, value.clone())
    })();
    result.unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn storage_drives_reveal_and_later_save_changes_target() {
        assert_eq!(
            json!(reveal(
                7,
                "/private/generated/generation-1/image.png",
                Some("temporary"),
                Some("/Pictures")
            )),
            json!({"kind":"view","viewId":"trace.view","directory":"/Pictures","targetId":"artifact:7"})
        );
        assert_eq!(
            json!(reveal(7, "/Pictures/saved.png", Some("saved"), None)),
            json!({"kind":"file","path":"/Pictures/saved.png"})
        );
        assert!(reveal(7, "/private/image.png", None, None).is_none());
    }
    #[test]
    fn billing_bounds_and_malformed_values() {
        let valid = json!({"cost":{"amount":"0.045","currency":"USD","estimated":true,"source":"ratecard:fixture"},"evidence":{"schema":"usage.v1","values":{"tokens":4,"cached":false,"note":null}}});
        let parse = |v| serde_json::from_value::<ProviderBilling>(v).is_ok_and(|b| b.valid());
        assert!(parse(valid.clone()));
        for amount in ["-1", "1e4", "0.1234567", "1.", "", "NaN"] {
            let mut v = valid.clone();
            v["cost"]["amount"] = json!(amount);
            assert!(!parse(v));
        }
        for v in [
            json!(false),
            json!({"cost":null,"unknown":1}),
            json!({"cost":{"amount":0.04}}),
        ] {
            assert!(!parse(v));
        }
        for (field, length) in [("schema", 65), ("key", 65), ("value", 129)] {
            let evidence = match field {
                "schema" => json!({"schema":"s".repeat(length),"values":{}}),
                "key" => json!({"schema":"s","values":{ "k".repeat(length): 1 }}),
                _ => json!({"schema":"s","values":{"k":"v".repeat(length)}}),
            };
            assert!(!parse(json!({"evidence":evidence})));
        }
        for value in [json!([]), json!({"nested":true})] {
            assert!(!parse(
                json!({"evidence":{"schema":"s","values":{"k":value}}})
            ));
        }
        let values: BTreeMap<_, _> = (0..33).map(|i| (i.to_string(), json!(i))).collect();
        assert!(!parse(json!({"evidence":{"schema":"s","values":values}})));
        let mut v = valid;
        v["cost"]["source"] = json!("s".repeat(65));
        assert!(!parse(v));
    }
    #[test]
    fn older_hosts_receive_identical_json_and_flags_are_independent() {
        let old = json!({"jobId":1,"status":"succeeded","outputPath":"/image.png","error":null});
        let r = reveal(7, "/image.png", Some("saved"), None);
        let c = JobCost {
            amount: "0".into(),
            currency: "USD".into(),
            estimated: false,
            source: "fixture".into(),
        };
        assert_eq!(
            serde_json::to_string(&extend(
                old.clone(),
                r.clone(),
                Some(c.clone()),
                false,
                false
            ))
            .unwrap(),
            serde_json::to_string(&old).unwrap()
        );
        let only_cost = extend(old.clone(), r.clone(), Some(c.clone()), false, true);
        assert!(only_cost.get("cost").is_some());
        assert!(only_cost.get("reveal").is_none());
        let only_reveal = extend(old, r, Some(c), true, false);
        assert!(only_reveal.get("cost").is_none());
        assert!(only_reveal.get("reveal").is_some());
    }
}

/// Consumer-local extension: shared provider receipts remain version 1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImageReceipt {
    receipt: te_image_generation_contract::OperationStatus,
    pub billing: Option<ProviderBilling>,
}
impl std::ops::Deref for ImageReceipt {
    type Target = te_image_generation_contract::OperationStatus;
    fn deref(&self) -> &Self::Target {
        &self.receipt
    }
}
impl std::ops::DerefMut for ImageReceipt {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.receipt
    }
}
impl From<te_image_generation_contract::OperationStatus> for ImageReceipt {
    fn from(receipt: te_image_generation_contract::OperationStatus) -> Self {
        Self {
            receipt,
            billing: None,
        }
    }
}
impl Serialize for ImageReceipt {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut value = serde_json::to_value(&self.receipt).map_err(serde::ser::Error::custom)?;
        if let Some(billing) = &self.billing {
            value["billing"] = serde_json::to_value(billing).map_err(serde::ser::Error::custom)?;
        }
        value.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for ImageReceipt {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut value = Value::deserialize(deserializer)?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| serde::de::Error::custom("Receipt must be an object"))?;
        let billing = object
            .remove("billing")
            .map(serde_json::from_value::<ProviderBilling>)
            .transpose()
            .map_err(serde::de::Error::custom)?;
        if billing.as_ref().is_some_and(|b| !b.valid()) {
            return Err(serde::de::Error::custom("Invalid provider billing"));
        }
        let receipt = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(Self { receipt, billing })
    }
}
