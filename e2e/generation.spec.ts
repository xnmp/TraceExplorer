import {test,expect,type Page} from "@playwright/test";
async function respond(page:Page,path='job:200') {
  await page.waitForFunction((path)=>(window as any).traceGeneration.pending().some((item:any)=>item.path===path),path);
  await page.evaluate((path)=>{const api=(window as any).traceGeneration;api.succeed(api.pending().filter((item:any)=>item.path===path).at(-1).id);},path);
}
test('multiple standalone generations appear as a group without navigating Explorer to a temp folder',async({page})=>{
  await page.goto('/generation.html');
  await page.getByLabel('Image prompt').fill('Make a bright daytime scene.');
  await page.getByLabel('Images',{exact:true}).fill('2');
  await expect(page.getByLabel('Temperature')).toBeDisabled();
  await page.getByRole('button',{name:'Generate',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).traceGeneration.generationCalls().length)).toBe(2);
  await respond(page);
  await expect(page.getByRole('group',{name:'2 image batch',exact:true})).toBeVisible();
  await expect(page.locator('.operation .spinner')).toHaveCount(2);
  await expect(page.locator('.operation strong')).toHaveText(['Make a bright daytime scene.','Make a bright daytime scene.']);
  await expect(page.locator('.operation').first()).toHaveAttribute('title','Make a bright daytime scene.');
  await expect(page.locator('[data-selection]')).toHaveText('No selection');
  await page.evaluate(()=>(window as any).traceGeneration.completeGenerations());await respond(page);
  await expect(page.locator('.artifact')).toHaveCount(2);
  await expect(page.locator('.unsaved-badge')).toHaveCount(2);
  await expect(page.locator('.operation')).toHaveCount(0);
  await page.locator('.artifact[data-path="/fixture/managed/batch-1.png"]').click();
  await respond(page,'/fixture/managed/batch-1.png');
  await expect(page.locator('.details h2')).toHaveText('batch-1.png');
  await expect(page.locator('[data-selection]')).toHaveText('No selection');
  await page.locator('.details').getByRole('button',{name:'Delete unsaved image'}).click();await respond(page,'/fixture/managed/batch-0.png');
  await expect(page.locator('.artifact')).toHaveCount(1);
  await expect(page.locator('.artifact[data-path="/fixture/managed/batch-0.png"]')).toBeVisible();
  await expect(page.locator('[data-selection]')).toHaveText('No selection');
});

test('generating nodes use the prompt immediately and adopt the shortened title when ready',async({page})=>{
  await page.goto('/generation.html');
  await page.evaluate(async()=>{const api=(window as any).traceGeneration;api.titleConnection(true);await api.configureTitles();});
  await page.getByLabel('Image prompt').fill('Turn the night scene into a bright daytime scene with soft sunlight.');
  await page.getByRole('button',{name:'Generate',exact:true}).click();
  await respond(page);
  const operation=page.locator('.operation');
  await expect(operation.locator('strong')).toHaveText('Turn the night scene into a bright daytime scene with soft sunlight.');
  await expect(operation.locator('strong')).toHaveCSS('text-overflow','ellipsis');
  await expect(operation.getByRole('status',{name:'Generating title'})).toBeVisible();
  await page.evaluate(()=>(window as any).traceGeneration.finishTitle(200,'Daytime scene'));
  await expect(operation.locator('strong')).toHaveText('Daytime scene');
  await expect(operation.getByRole('status',{name:'Generating title'})).toHaveCount(0);
  await expect(operation.locator('.spinner')).toBeVisible();
  await expect(operation).toHaveAttribute('title','Turn the night scene into a bright daytime scene with soft sunlight.');
});

for(const returnToOriginal of [false,true]) test(`a delayed hover save respects newer Trace selection${returnToOriginal ? ' even after returning to the same node' : ''}`,async({page})=>{
  await page.goto('/generation.html');
  await page.getByLabel('Image prompt').fill('Make it daytime.');await page.getByLabel('Images',{exact:true}).fill('2');
  await page.getByRole('button',{name:'Generate',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).traceGeneration.generationCalls().length)).toBe(2);
  await page.evaluate(()=>(window as any).traceGeneration.completeGenerations());await respond(page);
  const first='/fixture/managed/batch-0.png';const second='/fixture/managed/batch-1.png';
  await page.locator(`.artifact[data-path="${first}"]`).click();await respond(page,first);
  const frame=page.locator('.node-frame').filter({has:page.locator(`.artifact[data-path="${first}"]`)});
  await frame.hover();await frame.getByRole('button',{name:'Save image permanently'}).click();
  await page.waitForFunction(()=>(window as any).traceGeneration.saveState().pendingSaves===1);
  await page.locator(`.artifact[data-path="${second}"]`).click();await respond(page,second);
  if(returnToOriginal){await page.locator(`.artifact[data-path="${first}"]`).click();await respond(page,first);}
  await page.evaluate(()=>(window as any).traceGeneration.saveSuccess('/fixture/images/saved.png'));
  await respond(page,returnToOriginal ? first : second);
  await expect(page.locator('[data-selection]')).toHaveText('No selection');
  await expect(page.locator('.details h2')).toHaveText(returnToOriginal ? 'batch-0.png' : 'batch-1.png');
});
