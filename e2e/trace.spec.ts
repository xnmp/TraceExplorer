import {test,expect,type Page} from "@playwright/test";
async function respond(page:Page,path:string){
  await page.waitForFunction((path)=>(window as any).traceContribution.pending().some((item:any)=>item.path===path),path);
  await page.evaluate((path)=>{const api=(window as any).traceContribution;api.succeed(api.pending().filter((item:any)=>item.path===path).at(-1).id);},path);
}
test("deselection retains the trace, its selected node and prompt, while explicit toggle still closes it",async({page})=>{
  await page.goto("/contribution.html");
  await expect(page.getByRole("region",{name:"Trace contribution"})).toHaveCount(0);
  await page.getByRole("button",{name:"Select image",exact:true}).click();
  await respond(page,"/fixture/one/source.png");
  await page.locator(".artifact").filter({hasText:"source_edit.png"}).click();
  await respond(page,"/fixture/one/source_edit.png");
  await expect(page.locator(".details .prompt")).toHaveText("Turn the rectangle blue.");
  await page.getByRole("button",{name:"Clear selection",exact:true}).click();
  await expect(page.locator("[data-selection]")).toHaveText("No selection");
  await expect(page.locator(".artifact[aria-pressed=true] strong")).toHaveText("source_edit.png");
  await expect(page.locator(".details .prompt")).toHaveText("Turn the rectangle blue.");
  await expect(page.getByText("Loading trace…",{exact:true})).toHaveCount(0);
  await page.locator(".artifact").filter({hasText:"source_edit_2.png"}).click();
  await expect(page.locator("[data-selection]")).toHaveText("/fixture/two/source_edit_2.png");
  await expect(page.locator(".details .prompt")).toHaveText("Add a white stripe.");
  await expect(page.getByText("Loading trace…",{exact:true})).toHaveCount(0);
  await respond(page,"/fixture/two/source_edit_2.png");
  await page.getByRole("button",{name:"Clear selection",exact:true}).click();
  await page.getByRole("button",{name:"Toggle Trace pane",exact:true}).click();
  await expect(page.locator(".trace-body")).toHaveCount(0);
  await page.getByRole("button",{name:"Toggle Trace pane",exact:true}).click();
  await expect(page.locator(".details .prompt")).toHaveText("Add a white stripe.");
  await page.getByRole("button",{name:"Remount contribution",exact:true}).click();
  await expect(page.locator(".details .prompt")).toHaveText("Add a white stripe.");
});
test("thumbnails expose recorded prompts and hide raw metadata by default",async({page})=>{
  await page.goto("/contribution.html");await page.getByRole("button",{name:"Select image",exact:true}).click();await respond(page,"/fixture/one/source.png");
  const output=page.locator(".artifact").filter({hasText:"source_edit.png"});
  await output.hover();await expect(output.locator("img")).toHaveAttribute("title","Turn the rectangle blue.");
  await expect(output).toHaveAttribute("title","Turn the rectangle blue.");
  await output.click();await respond(page,"/fixture/one/source_edit.png");
  await expect(page.locator(".artifact small").filter({hasText:/^Current$/})).toHaveCount(0);
  await expect(page.locator("details summary").filter({hasText:"Raw"})).toBeVisible();
  await expect(page.locator("details")).not.toHaveAttribute("open");
});
test("an untraced image never displays unrelated ancestry and stays empty through deselection and refresh",async({page})=>{
  await page.goto("/contribution.html");await page.getByRole("button",{name:"Select image",exact:true}).click();await respond(page,"/fixture/one/source.png");
  await page.getByRole("button",{name:"Select untraced image",exact:true}).click();
  await expect(page.locator(".artifact")).toHaveCount(0);await respond(page,"/fixture/unrelated/empty.png");
  await expect(page.getByText("No recorded edits for this image.", {exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Clear selection",exact:true}).click();
  await expect(page.locator(".trace-body")).toBeVisible();await expect(page.getByText("Loading trace…",{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Refresh trace",exact:true}).click();
  await expect(page.getByText("Loading trace…",{exact:true})).toHaveCount(0);await respond(page,"/fixture/unrelated/empty.png");
  await expect(page.locator(".artifact")).toHaveCount(0);
});
