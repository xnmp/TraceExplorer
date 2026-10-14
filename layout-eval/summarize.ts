/** Summaries contain measured results only; acceptance remains owned by run.ts. */
delete process.env.OPENAI_API_KEY;
import { readFile, writeFile } from 'node:fs/promises';
const report = await readFile('layout-eval/out/acceptance.md', 'utf8');
await writeFile('layout-eval/out/analysis.md', report);
console.log(report);
