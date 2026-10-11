//! Pure usage extraction and dated pricing. No IO, credentials, or floating point
//! money arithmetic. Rates are hundredths of USD per million tokens; accumulate
//! hundredths of a micro-dollar and round once, half up, to micro-dollars.
use serde::Deserialize;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::{collections::BTreeMap, sync::OnceLock};
use te_image_generation_contract::{Billing, BillingEvidence, JobCost};
const MAX_COUNT: u64 = 9_007_199_254_740_991;
#[derive(Deserialize)]
struct Card {
    date: String,
    rates: Vec<Rate>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rate {
    backend: String,
    model: String,
    input_text: u64,
    input_image: u64,
    // Retained in the dated card; nonzero cache usage needs modality evidence.
    #[allow(dead_code)]
    cached_text: Option<u64>,
    #[allow(dead_code)]
    cached_image: Option<u64>,
    output_text: Option<u64>,
    output_image: u64,
}
fn card() -> &'static Card {
    static CARD: OnceLock<Card> = OnceLock::new();
    CARD.get_or_init(|| {
        serde_json::from_str(include_str!("rate-card.json")).expect("published rate card")
    })
}
fn rate(backend: &str, model: &str) -> Option<&'static Rate> {
    card()
        .rates
        .iter()
        .find(|r| r.backend == backend && r.model == model)
}
pub fn decimal(micros: u128) -> String {
    let whole = micros / 1_000_000;
    let fraction = micros % 1_000_000;
    if fraction == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{fraction:06}")
            .trim_end_matches('0')
            .to_owned()
    }
}
fn cost(micros: u128, estimated: bool, source: String) -> JobCost {
    JobCost {
        amount: decimal(micros),
        currency: "USD".into(),
        estimated,
        source,
    }
}
fn count(v: &Value) -> Option<u64> {
    v.as_u64().filter(|n| *n <= MAX_COUNT)
}
fn optional_count(v: &Value) -> Option<u64> {
    if v.is_null() {
        Some(0)
    } else {
        count(v)
    }
}
fn collect(schema: &str, fields: impl IntoIterator<Item = (String, Value)>) -> Billing {
    let values = fields
        .into_iter()
        .filter(|(k, v)| k.chars().count() <= 64 && (count(v).is_some() || v.is_null()))
        .take(32)
        .collect::<BTreeMap<_, _>>();
    Billing {
        cost: None,
        evidence: Some(BillingEvidence {
            schema: schema.into(),
            values,
        }),
    }
}
/// A missing complementary modality can be derived only from a reported total.
fn split(total: u64, image: &Value, text: &Value) -> Option<(u64, u64)> {
    let image = if image.is_null() {
        None
    } else {
        Some(count(image)?)
    };
    let text = if text.is_null() {
        None
    } else {
        Some(count(text)?)
    };
    match (image, text) {
        (Some(i), Some(t)) if i.checked_add(t)? == total => Some((i, t)),
        (Some(i), None) => Some((i, total.checked_sub(i)?)),
        (None, Some(t)) => Some((total.checked_sub(t)?, t)),
        (None, None) if total == 0 => Some((0, 0)),
        _ => None,
    }
}
fn weighted(tokens: u64, price: Option<u64>) -> Option<u128> {
    if tokens == 0 {
        Some(0)
    } else {
        Some(u128::from(tokens) * u128::from(price?))
    }
}
/// Images API output_tokens means image tokens when there is no output breakdown
/// (OpenAI Images reference). An explicit breakdown takes precedence.
pub fn openai(response: &Value, model: &str, base_url: &str) -> Option<Billing> {
    let usage = response.get("usage")?.as_object()?;
    let u = Value::Object(usage.clone());
    let mut fields = Vec::new();
    for name in ["input_tokens", "output_tokens", "total_tokens"] {
        if let Some(v) = u.get(name) {
            fields.push((name.into(), v.clone()));
        }
    }
    for group in ["input_tokens_details", "output_tokens_details"] {
        for name in ["image_tokens", "text_tokens", "cached_tokens"] {
            if let Some(v) = u[group].get(name) {
                fields.push((format!("{group}.{name}"), v.clone()));
            }
        }
    }
    let mut billing = collect("openai.images.usage.v1", fields);
    let estimate = || -> Option<JobCost> {
        if base_url.trim_end_matches('/') != "https://api.openai.com/v1/images" {
            return None;
        }
        let r = rate("openai-images", model)?;
        let input = count(&u["input_tokens"])?;
        let output = count(&u["output_tokens"])?;
        if let Some(total) = u.get("total_tokens").filter(|v| !v.is_null()) {
            if count(total)? != input.checked_add(output)? {
                return None;
            }
        }
        let (ii, it) = split(
            input,
            &u["input_tokens_details"]["image_tokens"],
            &u["input_tokens_details"]["text_tokens"],
        )?;
        let (oi, ot) = if u["output_tokens_details"].is_null() {
            (output, 0)
        } else {
            split(
                output,
                &u["output_tokens_details"]["image_tokens"],
                &u["output_tokens_details"]["text_tokens"],
            )?
        };
        // Cache counts without modality evidence cannot be priced accurately.
        if optional_count(&u["input_tokens_details"]["cached_tokens"])? != 0 {
            return None;
        }
        let amount = weighted(ii, Some(r.input_image))?
            + weighted(it, Some(r.input_text))?
            + weighted(oi, Some(r.output_image))?
            + weighted(ot, r.output_text)?;
        Some(cost(
            (amount + 50) / 100,
            true,
            format!("ratecard:openai-images:{}", card().date),
        ))
    };
    billing.cost = estimate();
    Some(billing)
}
pub fn gemini(response: &Value, model: &str) -> Option<Billing> {
    let u = response.get("usage")?.as_object()?;
    let u = Value::Object(u.clone());
    let mut fields = Vec::new();
    for name in [
        "total_input_tokens",
        "total_output_tokens",
        "total_cached_tokens",
        "total_thought_tokens",
    ] {
        if let Some(v) = u.get(name) {
            fields.push((name.into(), v.clone()));
        }
    }
    if let Some(modalities) = u["output_tokens_by_modality"].as_array() {
        for m in modalities.iter().take(32) {
            if let Some(name) = m["modality"].as_str() {
                fields.push((
                    format!("output_tokens_by_modality.{name}"),
                    m["tokens"].clone(),
                ));
            }
        }
    }
    let mut billing = collect("gemini.interactions.usage.v1", fields);
    let estimate = || -> Option<JobCost> {
        let r = rate("gemini", model)?;
        let input = count(&u["total_input_tokens"])?;
        let output = count(&u["total_output_tokens"])?;
        let thought = optional_count(&u["total_thought_tokens"])?;
        // The supplied card has no Gemini cache rate. Keep evidence, never guess.
        if optional_count(&u["total_cached_tokens"])? != 0 {
            return None;
        }
        let modalities = u["output_tokens_by_modality"].as_array()?;
        if modalities.len() > 32 {
            return None;
        }
        let mut image = 0u64;
        let mut text = 0u64;
        let mut seen = std::collections::BTreeSet::new();
        for m in modalities {
            let name = m["modality"].as_str()?;
            if !seen.insert(name) {
                return None;
            }
            let tokens = count(&m["tokens"])?;
            match name {
                "image" => image = tokens,
                "text" => text = tokens,
                _ => return None,
            }
        }
        if image.checked_add(text)? != output {
            return None;
        }
        // Interactions separates thoughts from generated responses; add once.
        let amount = weighted(input, Some(r.input_text))?
            + weighted(image, Some(r.output_image))?
            + weighted(text.checked_add(thought)?, r.output_text)?;
        Some(cost(
            (amount + 50) / 100,
            true,
            format!("ratecard:gemini:{}", card().date),
        ))
    };
    billing.cost = estimate();
    Some(billing)
}
/// Decimal JSON credits -> integer micro-dollars. Parse the decimal spelling,
/// including scientific notation, without binary floating point arithmetic.
fn credit_micros(value: &Value) -> Option<u128> {
    if !value.is_number() {
        return None;
    }
    let spelling = value.to_string();
    let (mantissa, exponent) = spelling
        .split_once(['e', 'E'])
        .map_or(Some((spelling.as_str(), 0i32)), |(m, e)| {
            Some((m, e.parse::<i32>().ok()?))
        })?;
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if whole.is_empty()
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let digits = format!("{whole}{fraction}").parse::<u128>().ok()?;
    let scale = 4i32
        .checked_add(exponent)?
        .checked_sub(fraction.len() as i32)?;
    if scale >= 0 {
        digits.checked_mul(10u128.checked_pow(scale as u32)?)
    } else {
        let divisor = 10u128.checked_pow(scale.unsigned_abs())?;
        Some(digits.checked_add(divisor / 2)? / divisor)
    }
}
/// Merge operation evidence by replacement, not summation. Missing poll fields
/// retain submit evidence; a valid settled cost (including zero) replaces it.
pub fn bfl(response: &Value, previous: Option<&Billing>) -> Option<Billing> {
    let mut values = previous
        .and_then(|b| b.evidence.as_ref())
        .map(|e| e.values.clone())
        .unwrap_or_default();
    let mut charge = previous.and_then(|b| b.cost.clone());
    for (key, name) in [
        ("credits", "cost"),
        ("input_mp", "input_mp"),
        ("output_mp", "output_mp"),
    ] {
        if let Some(v) = response
            .get(name)
            .filter(|v| credit_micros(v).is_some() && v.to_string().len() <= 128)
        {
            values.insert(key.into(), v.clone());
            if key == "credits" {
                charge = Some(cost(credit_micros(v)?, false, "bfl.credits".into()));
            }
        }
    }
    if values.is_empty() {
        return None;
    }
    Some(Billing {
        cost: charge,
        evidence: Some(BillingEvidence {
            schema: "bfl.v1".into(),
            values,
        }),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn openai_card_models_and_unknown_or_custom_endpoint() {
        let u = json!({"usage":{"input_tokens":1000,"input_tokens_details":{"image_tokens":800,"text_tokens":200},"output_tokens":2000,"total_tokens":3000}});
        for (model, amount) in [
            ("gpt-image-1", "0.089"),
            ("gpt-image-1.5", "0.0714"),
            ("gpt-image-2", "0.0674"),
            ("gpt-image-2.5-sunburst", "0.0674"),
            ("gpt-image-2.5-flare", "0.0674"),
        ] {
            let b = openai(&u, model, "https://api.openai.com/v1/images").unwrap();
            assert_eq!(b.cost.unwrap().amount, amount);
        }
        for (model, url) in [
            ("unknown", "https://api.openai.com/v1/images"),
            ("gpt-image-1", "https://proxy.test/v1/images"),
        ] {
            let b = openai(&u, model, url).unwrap();
            assert!(b.cost.is_none());
            assert_eq!(b.evidence.unwrap().values["input_tokens"], 1000);
        }
        assert!(openai(
            &json!({}),
            "gpt-image-1",
            "https://api.openai.com/v1/images"
        )
        .is_none());
    }
    #[test]
    fn gemini_card_prices_image_text_and_thinking_once() {
        let u = json!({"usage":{"total_input_tokens":1000,"total_output_tokens":2100,"total_thought_tokens":100,"total_cached_tokens":0,"output_tokens_by_modality":[{"modality":"image","tokens":2000},{"modality":"text","tokens":100}]}});
        for (model, amount) in [
            ("gemini-2.5-flash-image", "0.0608"),
            ("gemini-3-pro-image", "0.2444"),
            ("gemini-3.1-flash-image", "0.1211"),
            ("gemini-3.1-flash-lite-image", "0.06055"),
            ("gemini-nano-banana-2.1", "0.063"),
        ] {
            assert_eq!(gemini(&u, model).unwrap().cost.unwrap().amount, amount);
        }
        assert!(gemini(&u, "unknown").unwrap().cost.is_none());
    }
    #[test]
    fn bfl_submit_and_settlement_replace_preserving_megapixels() {
        let submit = bfl(&json!({"cost":4.5,"input_mp":1.25,"output_mp":2}), None).unwrap();
        assert_eq!(submit.cost.as_ref().unwrap().amount, "0.045");
        let settled = bfl(&json!({"cost":8}), Some(&submit)).unwrap();
        assert_eq!(settled.cost.as_ref().unwrap().amount, "0.08");
        assert!(!settled.cost.as_ref().unwrap().estimated);
        assert_eq!(settled.evidence.as_ref().unwrap().values["input_mp"], 1.25);
        assert_eq!(bfl(&json!({"cost":8}), Some(&settled)), Some(settled));
        assert_eq!(bfl(&json!({}), Some(&submit)), Some(submit));
        assert_eq!(credit_micros(&json!(0.00005)), Some(1));
    }
    #[test]
    fn raw_decimal_credit_rounding_does_not_pass_through_binary_floats() {
        for (raw, amount) in [
            (r#"{"cost":0.000049999999999999999999}"#, "0"),
            (r#"{"cost":0.00005}"#, "0.000001"),
            (r#"{"cost":4.123456789}"#, "0.041235"),
            (r#"{"cost":5e-5}"#, "0.000001"),
        ] {
            let response: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(bfl(&response, None).unwrap().cost.unwrap().amount, amount);
        }
    }
    #[test]
    fn malformed_huge_incomplete_and_unpriced_usage_never_guess() {
        for bad in [json!(-1), json!(1.5), json!("100"), json!(u64::MAX)] {
            let u = json!({"usage":{"input_tokens":bad,"output_tokens":100,"input_tokens_details":{"image_tokens":0,"text_tokens":0}}});
            let b = openai(&u, "gpt-image-1", "https://api.openai.com/v1/images").unwrap();
            assert!(b.valid());
            assert!(b.cost.is_none());
            assert!(!b.evidence.unwrap().values.contains_key("input_tokens"));
        }
        assert!(bfl(
            &json!({"cost":-1,"input_mp":"secret","output_mp":1e100}),
            None
        )
        .is_none());
        let u = json!({"usage":{"total_input_tokens":10,"total_output_tokens":10,"total_cached_tokens":1,"output_tokens_by_modality":[{"modality":"image","tokens":10}]}});
        assert!(gemini(&u, "gemini-3-pro-image").unwrap().cost.is_none());
        let mut u = u;
        u["usage"]["total_cached_tokens"] = json!(0);
        u["usage"]["output_tokens_by_modality"] =
            json!([{ "modality":"x".repeat(100),"tokens":10}]);
        let b = gemini(&u, "gemini-3-pro-image").unwrap();
        assert!(b.valid());
        assert!(b.cost.is_none());
    }
}
