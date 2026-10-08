import { describe,it,expect,vi } from "vitest";
vi.mock("$lib/plugins/trace/prompt-titles.svelte",()=>({promptTitles:{bind(){},unbind(){}}}));
vi.mock("$lib/plugins/openai-image/OpenAIImageDialog.svelte",()=>({default:{}}));
vi.mock("$lib/plugins/openai-image/OpenAIImageEditorTool.svelte",()=>({default:{}}));
vi.mock("$lib/plugins/openai-image/OpenAIImageEditDialog.svelte",()=>({default:{}}));
vi.mock("$lib/plugins/openai-image/OpenAIImageHistory.svelte",()=>({default:{}}));
import {openAIImagePlugin} from "$lib/plugins/openai-image";
import type {PluginContext} from "../../integration/plugin-sdk";
import type {FileEntry} from "$lib/domain/file";
const image:FileEntry={name:"photo.PNG",path:"/media/photo.PNG",kind:"file",size:20,modified:"2026-10-03T00:00:00Z"};
const folder:FileEntry={...image,name:"media",path:"/media",kind:"directory"};
function fixture(initial:Record<string,unknown>={}){
  let stored={...initial};let selection:FileEntry[]=[];
  const commands:Parameters<PluginContext["registerCommand"]>[0][]=[];
  const menus:Parameters<PluginContext["registerContextMenuItem"]>[0][]=[];
  const tools:Parameters<PluginContext["registerImageEditorTool"]>[0][]=[];
  const opened:{id:string;props:Record<string,unknown>}[]=[];
  const ctx:PluginContext={
    registerCommand:command=>{commands.push(command);},registerContextMenuItem:item=>{menus.push(item);},
    registerImageEditorTool:tool=>{tools.push(tool);},registerSettingsSection:()=>{},registerInspector:()=>{},registerDialog:()=>{},
    openDialog:(id,props)=>{opened.push({id,props:props??{}});},closeDialog:()=>{},
    toast:{show:()=>{},error:()=>{}},jobs:{accept:(_registration,start)=>start()},events:{listen:()=>{}},
    storage:{get:async()=>({...stored}),set:async next=>{stored={...next};}},saveSettings:async patch=>{stored={...stored,...patch};},
    workspace:{getSelection:()=>selection,captureSelection:()=>()=>true,selectFile:async()=>{},onFilesChanged:()=>{}},
  };
  return {ctx,commands,menus,tools,opened,setSelection:(entries:FileEntry[])=>{selection=entries;}};
}
describe("OpenAI plugin SDK contributions",()=>{
  it("opens the selected edit using freshly loaded connection settings",async()=>{
    const f=fixture({apiKey:"first-key"});await openAIImagePlugin.activate(f.ctx);
    await f.ctx.storage.set({apiKey:"current-key"});f.setSelection([image]);
    const command=f.commands.find(command=>command.id==="plugin.openai-image.edit")!;
    expect(command.shortcut).toBe("Ctrl+E");expect(command.when?.()).toBe(true);await command.handler();
    expect(f.opened.at(-1)).toMatchObject({id:"openai-image.edit-window",props:{sourcePath:image.path,referencePaths:[],outputDir:"/media",apiKey:"current-key",initialBackend:"codex"}});
    expect(f.opened.at(-1)?.props.onSaveSettings).toBe(f.ctx.saveSettings);
  });
  it("assigns the first image as edit target and subsequent images as references",async()=>{
    const f=fixture({backend:"api_key"});await openAIImagePlugin.activate(f.ctx);
    const reference={...image,name:"reference.png",path:"/media/reference.png"};
    const menu=f.menus.find(menu=>menu.id==="openai-image.edit")!;
    expect(menu.when([image,reference])).toBe(true);await menu.handler([image,reference]);
    expect(f.opened.at(-1)?.props).toMatchObject({sourcePath:image.path,referencePaths:[reference.path],initialBackend:"api_key"});
    for(const invalid of [[image,folder],[{...image,path:"demo://photo.png"}],[{...image,name:"animated.gif"}],Array.from({length:9},(_,i)=>({...image,path:`/media/${i}.png`}))])expect(menu.when(invalid)).toBe(false);
    expect(f.tools.some(tool=>tool.when({path:image.path,name:image.name,digest:"a".repeat(64),format:"PNG",referencePaths:[]}))).toBe(true);
  });
  it("Ctrl+E opens all highlighted images as ordered inputs and rejects duplicate or excessive selections",async()=>{
    const f=fixture();await openAIImagePlugin.activate(f.ctx);
    const selected=Array.from({length:8},(_,i)=>({...image,name:`input-${i}.png`,path:`/media/input-${i}.png`}));
    const command=f.commands.find(command=>command.id==="plugin.openai-image.edit")!;
    f.setSelection(selected);expect(command.when?.()).toBe(true);await command.handler();
    expect(f.opened.at(-1)?.props).toMatchObject({sourcePath:selected[0].path,referencePaths:selected.slice(1).map(item=>item.path)});
    for(const invalid of [[image,image],[...selected,image],[],[image,folder]]){
      f.setSelection(invalid);expect(command.when?.()).toBe(false);await command.handler();
    }
    expect(f.opened).toHaveLength(1);
  });
  it("generates in the chosen folder with no invented source and exposes history",async()=>{
    const f=fixture({codexPath:"/opt/custom tools/codex"});await openAIImagePlugin.activate(f.ctx);
    const menu=f.menus.find(menu=>menu.id==="openai-image.generate")!;
    expect(menu.when([folder])).toBe(true);await menu.handler([folder]);
    expect(f.opened.at(-1)).toMatchObject({id:"openai-image.create",props:{sourcePath:null,outputDir:"/media",codexPath:"/opt/custom tools/codex"}});
    await f.commands.find(command=>command.id==="plugin.openai-image.history")!.handler();
    expect(f.opened.at(-1)?.id).toBe("openai-image.history");
    expect(f.opened.at(-1)?.props).toMatchObject({jobs:f.ctx.jobs,storage:f.ctx.storage});
  });
});
