import {test,expect,type Page} from "@playwright/test";
const temporary="/fixture/managed/generated-302.png";
async function respond(page:Page,path:string){
  await page.waitForFunction((path)=>(window as any).traceHarness.pending().some((item:any)=>item.path===path),path);
  await page.evaluate((path)=>{const api=(window as any).traceHarness;api.succeed(api.pending().filter((item:any)=>item.path===path).at(-1).id);},path);
}
async function openOutput(page:Page){
  await page.goto("/");await page.waitForFunction(()=>!!(window as any).traceHarness);
  await page.evaluate((path)=>{const api=(window as any).traceHarness;api.enableSelectionLease();api.select(path);},temporary);
  await respond(page,temporary);await expect(page.locator(".details").getByRole("button",{name:"Save image permanently"})).toBeVisible();
}
async function picker(page:Page){
  await page.locator(".details").getByRole("button",{name:"Save image as…"}).click();
  await page.waitForFunction(()=>(window as any).traceHarness.saveState().pendingSuggestions===1);
  await page.evaluate(()=>(window as any).traceHarness.suggestion("parent_edit.png"));
  await page.waitForFunction(()=>(window as any).traceHarness.saveState().pendingPickers===1);
}
test("clicking a temporary output selects its details without navigating Explorer",async({page})=>{
  await page.goto("/");
  await page.evaluate(()=>(window as any).traceHarness.select("/fixture/images/parent.png"));
  await respond(page,"/fixture/images/parent.png");
  await page.locator('.artifact[data-path="/fixture/managed/generated-302.png"]').click();
  await expect(page.locator("[data-explorer-selection]")).toHaveText("/fixture/images/parent.png");
  await expect(page.locator(".artifact[aria-pressed=true] strong")).toHaveText("Keep the same image; make the rectangle blue.");
  await expect(page.locator(".details .prompt")).toHaveText("Keep the same image; make the rectangle blue.");
  await expect(page.locator(".details").getByRole("button",{name:"Save image permanently"})).toBeVisible();
  await page.getByRole("button",{name:"Refresh trace"}).click();
  await respond(page,temporary);
  await expect(page.locator(".artifact[aria-pressed=true] strong")).toHaveText("Keep the same image; make the rectangle blue.");
  expect(await page.evaluate(()=>(window as any).traceHarness.selectionCalls())).toEqual([]);
});
test("cancelling permanent save preserves the temporary output and makes no write",async({page})=>{
  await openOutput(page);await picker(page);
  await page.evaluate(()=>(window as any).traceHarness.picker(null));
  await expect(page.locator(".details").getByRole("button",{name:"Save image permanently"})).toBeEnabled();
  expect(await page.evaluate(()=>(window as any).traceHarness.saveState().saveCalls)).toEqual([]);
  await expect(page.locator("[data-explorer-selection]")).toHaveText(temporary);
});
test("successful save selects the permanent image and retains its prompt and output identity",async({page})=>{
  await openOutput(page);await picker(page);const target="/fixture/images/parent_edit.png";
  await page.evaluate((path)=>(window as any).traceHarness.picker(path),target);
  await page.waitForFunction(()=>(window as any).traceHarness.saveState().pendingSaves===1);
  await page.evaluate((path)=>(window as any).traceHarness.saveSuccess(path),target);
  await expect(page.locator("[data-explorer-selection]")).toHaveText(target);await respond(page,target);
  await expect(page.locator(".details .prompt")).toHaveText("Keep the same image; make the rectangle blue.");
  await expect(page.locator(".details").getByRole("button",{name:"Save image permanently"})).toHaveCount(0);
  await expect(page.locator('.unsaved-badge')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).traceHarness.saveState().saveCalls)).toEqual([{artifactId:302,target}]);
});
test("a delayed save cannot steal a newer explorer selection",async({page})=>{
  await openOutput(page);await picker(page);const target="/fixture/images/parent_edit.png";
  await page.evaluate((path)=>(window as any).traceHarness.picker(path),target);
  await page.waitForFunction(()=>(window as any).traceHarness.saveState().pendingSaves===1);
  await page.evaluate(()=>(window as any).traceHarness.select("/fixture/unrelated/unrelated.png"));
  await respond(page,"/fixture/unrelated/unrelated.png");
  await page.evaluate((path)=>(window as any).traceHarness.saveSuccess(path),target);
  await expect(page.locator("[data-explorer-selection]")).toHaveText("/fixture/unrelated/unrelated.png");
  await expect(page.locator(".details .prompt")).toHaveText("Unrelated green circle.");
  expect(await page.evaluate(()=>(window as any).traceHarness.selectionCalls())).not.toContain(target);
});
test("the save icon uses the default name without opening a picker",async({page})=>{
  await openOutput(page);
  await page.locator('.details').getByRole('button',{name:'Save image permanently'}).click();
  await page.waitForFunction(()=>(window as any).traceHarness.saveState().pendingSaves===1);
  const state=await page.evaluate(()=>(window as any).traceHarness.saveState());
  expect(state.saveCalls).toEqual([{artifactId:302}]);expect(state.pickerCalls).toEqual([]);expect(state.suggestionCalls).toEqual([]);
  await page.evaluate(()=>(window as any).traceHarness.saveSuccess());
  await expect(page.locator('[data-explorer-selection]')).toHaveText('/fixture/images/parent_edit.png');
  await respond(page,'/fixture/images/parent_edit.png');
  await expect(page.locator('.details .prompt')).toHaveText('Keep the same image; make the rectangle blue.');
});
test("hover controls discard a candidate without navigating Explorer or removing its parent",async({page})=>{
  await page.goto('/');await page.evaluate(()=>(window as any).traceHarness.select('/fixture/images/parent.png'));await respond(page,'/fixture/images/parent.png');
  const frame=page.locator('.node-frame').filter({has:page.locator(`.artifact[data-path="${temporary}"]`)});
  await frame.hover();
  await expect(frame.getByRole('button',{name:'Save image permanently'})).toBeVisible();
  await frame.getByRole('button',{name:'Delete unsaved image'}).click();
  await respond(page,'/fixture/images/parent.png');
  await expect(page.locator(`.artifact[data-path="${temporary}"]`)).toHaveCount(0);
  await expect(page.locator('.artifact[data-path="/fixture/images/parent.png"]')).toBeVisible();
  await expect(page.locator('[data-explorer-selection]')).toHaveText('/fixture/images/parent.png');
  expect(await page.evaluate(()=>(window as any).traceHarness.saveState().discardCalls)).toEqual([{artifactId:302}]);
});
