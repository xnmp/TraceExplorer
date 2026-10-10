import { expect, test, type Page } from '@playwright/test';
async function setup(page: Page) { await page.goto('/'); await page.getByRole('button', { name: 'Configure connections', exact: true }).click(); }
async function saveHttp(page: Page) {
  await page.getByRole('button', { name: 'Add Images API' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Saved Images');
  await page.getByLabel('Images resource URL').fill('https://example.test/v1/images');
  await page.getByLabel('Image model ID').fill('custom-image');
  await page.getByLabel('Default image connection').selectOption({ label: 'Saved Images' });
  await page.getByRole('button', { name: 'Save connections' }).click();
  await expect(page.getByText('Connections saved.', { exact: true })).toBeVisible();
}
test('configures independent custom API, write-only key, local check, and retained explicit test discard', async ({ page }) => {
  await setup(page); await expect(page.getByText('No image connections configured.', { exact: false })).toBeVisible(); await saveHttp(page);
  await page.getByLabel('New API key').fill('private-fixture-key'); await page.getByRole('button', { name: 'Save key securely' }).click();
  await expect(page.getByLabel('New API key')).toHaveValue(''); await expect(page.getByText('A key is saved in the OS credential store.')).toBeVisible();
  await page.getByRole('button', { name: 'Check locally' }).click(); await expect(page.getByText('Local checks passed. Model generation has not been tested.')).toBeVisible();
  await page.getByRole('button', { name: 'Test generation (may be billed)', exact: true }).click(); await expect(page.getByText('Generation succeeded. Test output is retained until you discard it.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).imageConnectionFixture.calls()); expect(calls).not.toContain('settings.test.discard');
  await page.getByRole('button', { name: 'Configure connections', exact: true }).click(); await expect(page.getByText('Generation succeeded. Test output is retained until you discard it.')).toBeVisible();
  await page.getByRole('button', { name: 'Discard test output', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Connection tests' })).toHaveCount(0);
  const saved = await page.evaluate(() => (window as any).imageConnectionFixture.snapshot()); expect(saved.profiles[0]).toMatchObject({ baseUrl: 'https://example.test/v1/images', defaultModel: 'custom-image', credential: { kind: 'secret' } }); expect(JSON.stringify(saved)).not.toContain('private-fixture-key');
});
test('remote revision preserves draft until explicit reload; keyboard close protects dirty changes', async ({ page }) => {
  await setup(page); await saveHttp(page); await page.getByLabel('Name', { exact: true }).fill('Unsaved local name');
  await page.evaluate(() => (window as any).imageConnectionFixture.remoteName('Remote saved name'));
  await expect(page.getByText('Settings changed in another window.', { exact: false })).toBeVisible(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved local name'); await expect(page.getByRole('button', { name: 'Save connections' })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Discard edits and close' })).toBeVisible(); await page.getByRole('button', { name: 'Keep editing' }).click();
  await page.getByRole('button', { name: 'Reload saved settings' }).click(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Remote saved name');
});
test('mobile Codex settings have adapter-managed model and fit the viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 }); await setup(page); await page.getByRole('button', { name: 'Add Codex' }).click();
  await expect(page.getByLabel('Image model ID')).toHaveCount(0); await expect(page.getByText('Codex uses its saved ChatGPT sign-in.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Save connections' }).click(); await expect(page.getByText('Connections saved.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-image-connections.png') });
});
