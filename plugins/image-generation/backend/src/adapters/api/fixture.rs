//! Test-only backend (`fixture-images`, feature `test-hooks`): returns a canned
//! image without any network IO. It exists to prove a third API transport needs
//! only a descriptor, a dispatch arm and a profile variant.
use super::*;

pub const DESCRIPTOR: ApiDescriptor = ApiDescriptor {
    transport: "fixture-images",
    default_base_url: "https://fixture.test/v1",
    credential_env: "FIXTURE_API_KEY",
    auth: Auth::Header("x-fixture-key"),
    options: Options {
        test_size: "auto",
        quality: &["auto"],
        background: &["auto"],
        resolution: true,
        aspect_ratio: true,
        sizes: false,
    },
    max_inputs: 2,
};
/// A model named `refuse-<code>` makes the fixture answer like a provider that
/// refused (structured code `<CODE>`), exercising the Failed/provider_refused path.
const REFUSALS: &[(&str, Refusal)] = &[("SAFETY", Refusal::Safety), ("POLICY", Refusal::Policy)];
pub(super) async fn generate(call: ApiCall<'_>) -> Result<Output> {
    if let Some(code) = call
        .recipe
        .model
        .as_deref()
        .and_then(|m| m.strip_prefix("refuse-"))
    {
        return Err(outcome(refused(&code.to_ascii_uppercase(), REFUSALS)));
    }
    let image = image::RgbImage::from_pixel(32, 32, image::Rgb([20, 40, 200]));
    let mut jpeg = std::io::Cursor::new(vec![]);
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut jpeg, image::ImageFormat::Jpeg)
        .map_err(|_| error("invalid_response", "Fixture could not encode an image"))?;
    output(call.recipe, &call.stage, &jpeg.into_inner(), None, None)
}
