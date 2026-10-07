import {test,expect} from '@playwright/test';
async function open(page:any){
  await page.goto('/');
  await page.waitForFunction(()=>(window as any).traceHarness.pending().length>0);
  await page.evaluate(()=>{const api=(window as any).traceHarness;api.succeed(api.pending()[0].id);});
}
test('unconfigured title generation shows the truncated prompt with no spinner or model request',async({page})=>{
  await open(page);
  await page.evaluate(async()=>{const api=(window as any).traceHarness;api.titleConnection(false);await api.configureTitles();});
  const output=page.locator('.artifact[data-path="/fixture/one/source_edit.png"]');
  await expect(output.locator('strong')).toHaveText('Turn the rectangle blue.');
  await expect(output).toHaveAttribute('title','Turn the rectangle blue.');
  await expect(output.locator('strong')).toHaveCSS('text-overflow','ellipsis');
  await expect(page.getByRole('status',{name:'Generating title'})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).traceHarness.titleCalls())).toEqual([]);
});
test('configured titles show a spinner beside the full prompt then replace it with a cached AI title',async({page})=>{
  await open(page);
  await page.evaluate(async()=>{const api=(window as any).traceHarness;api.titleConnection(true);await api.configureTitles();});
  const output=page.locator('.artifact[data-path="/fixture/one/source_edit.png"]');
  await expect(output.locator('strong')).toHaveText('Turn the rectangle blue.');
  await expect(output.getByRole('status',{name:'Generating title'})).toBeVisible();
  await page.evaluate(()=>(window as any).traceHarness.finishTitle(10,'Blue rectangle'));
  await expect(output.locator('strong')).toHaveText('Blue rectangle');
  await expect(output.getByRole('status',{name:'Generating title'})).toHaveCount(0);
  await expect(output).toHaveAttribute('title','Turn the rectangle blue.');
  await page.getByRole('button',{name:'Remount inspector',exact:true}).click();
  await expect(output.locator('strong')).toHaveText('Blue rectangle');
  expect(await page.evaluate(()=>(window as any).traceHarness.titleCalls())).toEqual([10,11]);
  await page.evaluate(async()=>await (window as any).traceHarness.configureTitles({titleGenerator:'disabled'}));
  await expect(page.getByRole('status',{name:'Generating title'})).toHaveCount(0);
});
