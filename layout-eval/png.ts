/** Optional local SVG rasterization; no server or external requests. */
delete process.env.OPENAI_API_KEY;
import { chromium } from '@playwright/test';
import { readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = process.argv[2] ?? 'layout-eval/out';
const profile = resolve(directory, '.chromium-profile');
const browser = await chromium.launchPersistentContext(profile, { headless: true });
try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const file of (await readdir(directory)).filter(f => f.endsWith('.svg')).sort()) {
        const content = await readFile(resolve(directory, file), 'utf8'), dimensions = content.match(/width="([\d.]+)" height="([\d.]+)"/)!;
        await page.setViewportSize({ width: Math.ceil(Number(dimensions[1])), height: Math.ceil(Number(dimensions[2])) });
        await page.setContent(`<style>html,body{margin:0;background:#22252b}svg{display:block}</style>${content}`);
        await page.locator('svg').screenshot({ path: resolve(directory, file.replace('.svg', '.png')) });
        console.log(file.replace('.svg', '.png'));
    }
}
finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
}
