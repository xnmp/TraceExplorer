import { afterEach,describe,it,expect,vi } from "vitest";
vi.mock("$lib/plugins/trace/prompt-titles.svelte",()=>({promptTitles:{bind(){},unbind(){}}}));
vi.mock("$lib/plugins/openai-image/OpenAIImageDialog.svelte",()=>({default:{}}));
vi.mock("$lib/plugins/openai-image/OpenAIImageEditorTool.svelte",()=>({default:{}}));
vi.mock("$lib/plugins/trace/view/pane-registry.svelte",()=>({tracePanes:{active:()=>activeTrace,activeId:()=>activeTraceId,get:(paneId:string|null)=>paneId?traceViews.get(paneId)??null:null}}));
let activeTrace:{directory:string;inputs():readonly string[];hasUnusableTarget():boolean}|null=null;
let activeTraceId:string|null=null;
let traceViews=new Map<string,{expandForOutputs(paths:readonly string[]):void}>();
vi.mock("$lib/plugins/openai-image/OpenAIImageHistory.svelte",()=>({default:{}}));
import {openAIImagePlugin} from "$lib/plugins/openai-image";
import type {PluginContext} from "../../integration/plugin-sdk";
import type {FileEntry} from "$lib/domain/file";
import { SVELTE_ABI } from "../../src/sdk";
const image:FileEntry={name:"photo.PNG",path:"/media/photo.PNG",kind:"file",size:20,modified:"2026-10-03T00:00:00Z"};
const folder:FileEntry={...image,name:"media",path:"/media",kind:"directory"};
function fixture(initial:Record<string,unknown>={}){
  let stored={...initial};let selection:FileEntry[]=[];
  const commands:Parameters<PluginContext["registerCommand"]>[0][]=[];
  const menus:Parameters<PluginContext["registerContextMenuItem"]>[0][]=[];
  const tools:Parameters<PluginContext["registerImageEditorTool"]>[0][]=[];
  const settings:Parameters<PluginContext["registerSettingsSection"]>[0][]=[];
  const opened:{id:string;props:Record<string,unknown>}[]=[];
  const ctx:PluginContext={
    registerCommand:command=>{commands.push(command);},registerContextMenuItem:item=>{menus.push(item);},
    registerImageEditorTool:tool=>{tools.push(tool);},registerSettingsSection:section=>{settings.push(section);},registerInspector:()=>{},registerDialog:()=>{},
    openDialog:(id,props)=>{opened.push({id,props:props??{}});},closeDialog:()=>{},
    toast:{show:vi.fn(),error:vi.fn()},jobs:{accept:(_registration,start)=>start()},events:{listen:()=>{}},
    storage:{get:async()=>({...stored}),set:async next=>{stored={...next};}},saveSettings:async patch=>{stored={...stored,...patch};},
    workspace:{getSelection:()=>selection,captureSelection:()=>()=>true,selectFile:async()=>{},onFilesChanged:()=>{}},
  };
  return {ctx,commands,menus,tools,settings,opened,setSelection:(entries:FileEntry[])=>{selection=entries;}};
}
describe("OpenAI plugin SDK contributions",()=>{
  afterEach(() => { vi.unstubAllGlobals(); });
  it("captures and opens the owner synchronously for every AI dialog entry point", async () => {
    vi.stubGlobal("__TAURI_EXPLORER_PLUGIN_SDK__", { sdkVersion: 1, apiVersion: 2, svelteVersion: SVELTE_ABI, capabilities: ["paneDialogs", "fileDropTargets"] });
    const f = fixture(); f.ctx.workspace.getCurrentDirectory = () => "/media";
    const pane = Object.freeze({ paneId: "owner" });
    const capture = vi.fn(() => pane), register = vi.fn(() => () => {}), openDialog = vi.fn();
    f.ctx.workspace.capturePane = capture; f.ctx.workspace.registerFileDropTarget = register;
    f.ctx.openDialog = openDialog;
    f.ctx.storage.get = vi.fn(() => new Promise(() => {}));
    await openAIImagePlugin.activate(f.ctx);
    const actions = [
      () => f.commands.find((c) => c.id === "plugin.openai-image.edit")!.handler(),
      () => { f.setSelection([image]); return f.commands.find((c) => c.id === "plugin.openai-image.generate")!.handler(); },
      () => f.menus.find((m) => m.id === "openai-image.edit")!.handler([image]),
      () => f.menus.find((m) => m.id === "openai-image.generate")!.handler([folder]),
    ];
    for (const action of actions) {
      const before = capture.mock.calls.length;
      const opening = action();
      expect(capture).toHaveBeenCalledTimes(before + 1);
      expect(openDialog).toHaveBeenLastCalledWith("openai-image.create", expect.objectContaining({ registerFileDropTarget: expect.any(Function) }), { scope: "pane", pane });
      await opening;
    }
    expect(f.ctx.storage.get).not.toHaveBeenCalled();
  });
  it("uses exactly the legacy two-argument open when pane support is absent, while drops remain independent", async () => {
    vi.stubGlobal("__TAURI_EXPLORER_PLUGIN_SDK__", { sdkVersion: 1, apiVersion: 2, svelteVersion: SVELTE_ABI, capabilities: ["fileDropTargets"] });
    const f = fixture(); f.setSelection([image]);
    f.ctx.workspace.capturePane = vi.fn(() => ({ paneId: "unannounced" }));
    f.ctx.workspace.registerFileDropTarget = vi.fn(() => () => {});
    const opened = vi.fn(); f.ctx.openDialog = opened;
    await openAIImagePlugin.activate(f.ctx);
    await f.commands.find((c) => c.id === "plugin.openai-image.edit")!.handler();
    expect(opened.mock.calls[0]).toHaveLength(2);
    expect(opened.mock.calls[0][1]).toMatchObject({ registerFileDropTarget: expect.any(Function) });
    expect(f.ctx.workspace.capturePane).not.toHaveBeenCalled();
  });
  it("fails the action if a capable host cannot capture its owner instead of opening a window modal", async () => {
    vi.stubGlobal("__TAURI_EXPLORER_PLUGIN_SDK__", { sdkVersion: 1, apiVersion: 2, svelteVersion: SVELTE_ABI, capabilities: ["paneDialogs"] });
    const f = fixture(); f.setSelection([image]); f.ctx.workspace.capturePane = () => null;
    await openAIImagePlugin.activate(f.ctx);
    await expect(f.commands.find((c) => c.id === "plugin.openai-image.edit")!.handler()).rejects.toThrow("pane is unavailable");
    expect(f.opened).toEqual([]);
  });
  it("shows a job's outputs in the Trace view of the dialog's own pane, looked up when the job is accepted", async () => {
    vi.stubGlobal("__TAURI_EXPLORER_PLUGIN_SDK__", { sdkVersion: 1, apiVersion: 2, svelteVersion: SVELTE_ABI, capabilities: ["paneDialogs"] });
    const first = { expandForOutputs: vi.fn() }, remounted = { expandForOutputs: vi.fn() }, active = { expandForOutputs: vi.fn() };
    traceViews = new Map([["owner", first], ["active", active]]); activeTraceId = "active";
    const f = fixture(); f.setSelection([image]); f.ctx.workspace.capturePane = () => ({ paneId: "owner" });
    await openAIImagePlugin.activate(f.ctx);
    await f.commands.find((c) => c.id === "plugin.openai-image.edit")!.handler();
    const onStart = f.opened.at(-1)!.props.onStart as (paths: readonly string[]) => void;
    // The owner's view remounts before the job is accepted.
    traceViews.set("owner", remounted);
    onStart([image.path]);
    expect(remounted.expandForOutputs).toHaveBeenCalledWith([image.path]);
    expect(first.expandForOutputs).not.toHaveBeenCalled();
    expect(active.expandForOutputs, "never the active pane's view").not.toHaveBeenCalled();
    // Gone by then: nothing to show it in.
    traceViews.delete("owner");
    expect(() => onStart([image.path])).not.toThrow();
    // A dialog opened from a pane that does not show Trace has none.
    f.ctx.workspace.capturePane = () => ({ paneId: "files" });
    await f.commands.find((c) => c.id === "plugin.openai-image.edit")!.handler();
    expect(f.opened.at(-1)!.props.onStart).toBeUndefined();
    traceViews = new Map(); activeTraceId = null;
  });
  it("the image editor tool shows its jobs' outputs in the Trace view of the pane it was opened from", async () => {
    vi.stubGlobal("__TAURI_EXPLORER_PLUGIN_SDK__", { sdkVersion: 1, apiVersion: 2, svelteVersion: SVELTE_ABI, capabilities: ["paneDialogs"] });
    const owner = { expandForOutputs: vi.fn() };
    traceViews = new Map([["owner", owner]]);
    const f = fixture(); f.ctx.workspace.capturePane = () => ({ paneId: "owner" });
    await openAIImagePlugin.activate(f.ctx);
    const props = f.tools.find((tool) => tool.id === "openai-image")!.props as { outputsShownIn: () => ((paths: readonly string[]) => void) | undefined };
    const onStart = props.outputsShownIn();
    onStart!([image.path]);
    expect(owner.expandForOutputs).toHaveBeenCalledWith([image.path]);
    f.ctx.workspace.capturePane = () => ({ paneId: "files" });
    expect(props.outputsShownIn(), "opened from a pane without Trace").toBeUndefined();
    traceViews = new Map();
  });
  it("contributes only a shared configuration action and awaits managed dialog closure",async()=>{
    const f=fixture();
    let close:()=>void=()=>{};
    const openDialog=vi.fn(()=>new Promise<{reason:"closed"}>(resolve=>{close=()=>resolve({reason:"closed"});}));
    await openAIImagePlugin.activate({...f.ctx,presentation:{openDialog}});
    expect(f.settings[0].rows).toEqual([]);
    let finished=false;
    const opening=Promise.resolve(f.settings[0].actions![0].run()).then(()=>{finished=true;});
    expect(openDialog).toHaveBeenCalledWith("image-generation.connections");
    await Promise.resolve();expect(finished).toBe(false);
    close();await opening;expect(finished).toBe(true);
    expect(f.opened).toEqual([]);
  });
  it("does not fall back to raw provider dialogs on unsupported hosts",async()=>{
    const f=fixture();await openAIImagePlugin.activate(f.ctx);
    await expect(f.settings[0].actions![0].run()).rejects.toThrow("Update the host");
    expect(f.opened).toEqual([]);
  });
  it("opens the selected edit without loading legacy credentials",async()=>{
    const f=fixture({apiKey:"first-key"});await openAIImagePlugin.activate(f.ctx);
    await f.ctx.storage.set({apiKey:"current-key"});f.setSelection([image]);
    const command=f.commands.find(command=>command.id==="plugin.openai-image.edit")!;
    expect(command.shortcut).toBe("Ctrl+E");expect(command.when).toBeUndefined();await command.handler();
    expect(f.opened.at(-1)).toMatchObject({id:"openai-image.create",props:{inputs:[{path:image.path}],outputDir:"/media",configureConnections:expect.any(Function)}});
    expect(f.opened.at(-1)?.props).not.toHaveProperty("apiKey");
    expect(f.opened.at(-1)?.props).not.toHaveProperty("codexPath");
  });
  it("sends every selected image as an equal, numbered input",async()=>{
    const f=fixture({backend:"api_key"});await openAIImagePlugin.activate(f.ctx);
    const reference={...image,name:"reference.png",path:"/media/reference.png"};
    const menu=f.menus.find(menu=>menu.id==="openai-image.edit")!;
    expect(menu.when([image,reference])).toBe(true);await menu.handler([image,reference]);
    expect(f.opened.at(-1)?.props).toMatchObject({inputs:[{path:image.path},{path:reference.path}],configureConnections:expect.any(Function)});
    for(const invalid of [[image,folder],[{...image,path:"demo://photo.png"}],[{...image,name:"animated.gif"}],Array.from({length:9},(_,i)=>({...image,path:`/media/${i}.png`}))])expect(menu.when(invalid)).toBe(false);
    expect(f.tools.some(tool=>tool.when({path:image.path,name:image.name,digest:"a".repeat(64),format:"PNG",referencePaths:[]}))).toBe(true);
  });
  it("Ctrl+E opens all highlighted images as ordered inputs and reports invalid selections",async()=>{
    const f=fixture();await openAIImagePlugin.activate(f.ctx);
    const selected=Array.from({length:8},(_,i)=>({...image,name:`input-${i}.png`,path:`/media/input-${i}.png`}));
    const command=f.commands.find(command=>command.id==="plugin.openai-image.edit")!;
    f.setSelection(selected);expect(command.when).toBeUndefined();await command.handler();
    expect(f.opened.at(-1)?.props).toMatchObject({inputs:selected.map(item=>({path:item.path}))});
    for(const invalid of [[...selected,image],[image,folder],[{...image,name:"clip.gif",path:"/media/clip.gif"}],[{...image,path:"demo://photo.png"}]]){
      f.setSelection(invalid);await command.handler();
    }
    expect(f.opened).toHaveLength(1);
    expect(f.ctx.toast.show).toHaveBeenCalledTimes(4);
    expect(f.ctx.toast.show).toHaveBeenLastCalledWith("Select one to eight PNG, JPEG, or WebP images first", "info");
  });
  it("generates in the chosen folder with no invented source and exposes history",async()=>{
    const f=fixture({codexPath:"/opt/custom tools/codex"});await openAIImagePlugin.activate(f.ctx);
    const menu=f.menus.find(menu=>menu.id==="openai-image.generate")!;
    expect(menu.when([folder])).toBe(true);await menu.handler([folder]);
    expect(f.opened.at(-1)).toMatchObject({id:"openai-image.create",props:{inputs:[],outputDir:"/media",configureConnections:expect.any(Function)}});
    await f.commands.find(command=>command.id==="plugin.openai-image.history")!.handler();
    expect(f.opened.at(-1)?.id).toBe("openai-image.history");
    expect(f.opened.at(-1)?.props).toMatchObject({jobs:f.ctx.jobs});
  });
  it("in an active Trace view, Ctrl+E takes its ordered picks, including images the host cannot select",async()=>{
    const f=fixture();await openAIImagePlugin.activate(f.ctx);
    const picked=["/media/b.png","/managed/generation-1/unsaved_edit.png","/media/refs/a.webp"];
    activeTrace={hasUnusableTarget:()=>false,directory:"/media",inputs:()=>picked};
    try{
      f.setSelection([{...image,path:"/media/b.png",name:"b.png"}]);
      const command=f.commands.find(command=>command.id==="plugin.openai-image.edit")!;
      expect(command.when).toBeUndefined();await command.handler();
      expect(f.opened.at(-1)?.props).toMatchObject({inputs:picked.map(path=>({path})),outputDir:"/media"});
      // A context menu on something outside the picks uses what was clicked.
      const menu=f.menus.find(menu=>menu.id==="openai-image.edit")!;
      await menu.handler([image]);
      expect(f.opened.at(-1)?.props).toMatchObject({inputs:[{path:image.path}],outputDir:"/media"});
      // Picks that cannot all be sent are never silently cut down.
      activeTrace={hasUnusableTarget:()=>false,directory:"/media",inputs:()=>[...picked,"/media/clip.gif"]};
      f.setSelection([]);
      const opened=f.opened.length;await command.handler();
      expect(f.opened).toHaveLength(opened);
      expect(f.ctx.toast.show).toHaveBeenCalledWith("Select one to eight PNG, JPEG, or WebP images first", "info");
    }finally{activeTrace=null;}
  });
  it("Ctrl+E with no selection generates in the current pane folder",async()=>{
    const f=fixture();f.ctx.workspace.getCurrentDirectory=()=>"/current";
    await openAIImagePlugin.activate(f.ctx);
    const command=f.commands.find(c=>c.id==="plugin.openai-image.edit")!;
    expect(command.when).toBeUndefined();await command.handler();
    expect(f.opened.at(-1)?.props).toMatchObject({inputs:[],outputDir:"/current"});
    f.setSelection([image]);await command.handler();
    expect(f.opened.at(-1)?.props).toMatchObject({inputs:[{path:image.path}],outputDir:"/current"});
  });
  it("opens generation on old hosts with no folder API so the form can guide the output location",async()=>{
    const f=fixture();await openAIImagePlugin.activate(f.ctx);
    await f.commands.find(c=>c.id==="plugin.openai-image.edit")!.handler();
    expect(f.opened.at(-1)?.props).toMatchObject({inputs:[],outputDir:""});
    activeTrace={hasUnusableTarget:()=>false,directory:"/trace",inputs:()=>[]};
    try{
      await f.commands.find(c=>c.id==="plugin.openai-image.edit")!.handler();
      expect(f.opened.at(-1)?.props).toMatchObject({inputs:[],outputDir:"/trace"});
    }finally{activeTrace=null;}
  });
  it("rejects an unusable Trace target instead of generating, including with other-pane inputs",async()=>{
    const f=fixture();await openAIImagePlugin.activate(f.ctx);
    activeTrace={directory:"/media",inputs:()=>[],hasUnusableTarget:()=>true};
    try{
      const command=f.commands.find(c=>c.id==="plugin.openai-image.edit")!;
      await command.handler();
      const workspace=f.ctx.workspace;
      workspace.getCombinedSelection=()=>[image];
      await command.handler();
      expect(f.opened).toEqual([]);
      expect(f.ctx.toast.show).toHaveBeenCalledTimes(2);
      expect(f.ctx.toast.show).toHaveBeenLastCalledWith("Select one to eight PNG, JPEG, or WebP images first","info");
    }finally{activeTrace=null;}
  });
  it("edits local images from virtual/search panes in their own folder and rejects generation there",async()=>{
    for(const directory of ["demo://pictures","search://images"]){
      const f=fixture();f.ctx.workspace.getCurrentDirectory=()=>directory;
      await openAIImagePlugin.activate(f.ctx);
      const command=f.commands.find(c=>c.id==="plugin.openai-image.edit")!;
      f.setSelection([image]);await command.handler();
      expect(f.opened.at(-1)?.props).toMatchObject({inputs:[{path:image.path}],outputDir:"/media"});
      f.setSelection([]);await command.handler();
      expect(f.opened).toHaveLength(1);
      expect(f.ctx.toast.show).toHaveBeenLastCalledWith(expect.stringContaining("Open a local output folder"),"info");
    }
  });
  it("uses the optional combined selection even when the active pane has no inputs",async()=>{
    const f=fixture();
    const workspace=f.ctx.workspace;
    let combined:FileEntry[]=[image,image];
    workspace.getCombinedSelection=()=>combined;
    await openAIImagePlugin.activate(f.ctx);
    const command=f.commands.find(c=>c.id==="plugin.openai-image.edit")!;
    await command.handler();
    expect(f.opened.at(-1)?.props).toMatchObject({inputs:[{path:image.path}]});
    combined=[folder];await command.handler();
    expect(f.opened).toHaveLength(1);
    expect(f.ctx.toast.show).toHaveBeenCalledWith("Select one to eight PNG, JPEG, or WebP images first","info");
  });
  it("combines other panes with ordered Trace picks and rejects their invalid inputs",async()=>{
    const f=fixture(),second={...image,name:"other.webp",path:"/other/other.webp"};
    f.setSelection([image]);
    const workspace=f.ctx.workspace;
    let combined=[image,second];workspace.getCombinedSelection=()=>combined;
    activeTrace={hasUnusableTarget:()=>false,directory:"/media",inputs:()=>["/managed/new.png",image.path]};
    try{
      await openAIImagePlugin.activate(f.ctx);
      const command=f.commands.find(c=>c.id==="plugin.openai-image.edit")!;
      await command.handler();
      expect(f.opened.at(-1)?.props).toMatchObject({inputs:[{path:"/managed/new.png"},{path:image.path},{path:second.path}]});
      combined=[image,folder];await command.handler();
      expect(f.opened).toHaveLength(1);
    }finally{activeTrace=null;}
  });
  describe("direct image editor entry",()=>{
    const ids=["openai-image.edit-in-editor","plugin.openai-image.edit-in-editor"];
    const withEditor=(openImageEditor:(request:{path:string;tool:string})=>Promise<void>,toasts:[string,string|undefined][]=[])=>{
      const f=fixture();
      const ctx={...f.ctx,toast:{show:(m:string,v?:string)=>{toasts.push([m,v]);},error:()=>{}},presentation:{openDialog:async()=>({reason:"closed" as const}),openImageEditor}};
      return {f,ctx,toasts};
    };
    it("is not offered on hosts without openImageEditor",async()=>{
      const f=fixture();await openAIImagePlugin.activate({...f.ctx,presentation:{openDialog:async()=>({reason:"closed"})}});
      expect([...f.menus.map(m=>m.id),...f.commands.map(c=>c.id)].filter(id=>ids.includes(id))).toEqual([]);
    });
    it("opens the selected image in the AI edit tool from the menu and the command",async()=>{
      const calls:{path:string;tool:string}[]=[];
      const {f,ctx}=withEditor(async r=>{calls.push(r);});await openAIImagePlugin.activate(ctx);
      const menu=f.menus.find(m=>m.id===ids[0])!,command=f.commands.find(c=>c.id===ids[1])!;
      expect(menu).toMatchObject({label:"Edit in image editor with AI…",group:"ai"});
      expect(command).toMatchObject({label:"AI Edit in Image Editor…",category:"plugins"});expect(command.shortcut).toBeUndefined();
      await menu.handler([image]);f.setSelection([image]);expect(command.when?.()).toBe(true);await command.handler();
      expect(calls).toEqual([{path:image.path,tool:"openai-image"},{path:image.path,tool:"openai-image"}]);
      expect(f.tools.map(t=>t.id)).toContain("openai-image");
    });
    it("is unavailable for selections the host editor cannot open",async()=>{
      const calls:unknown[]=[];const {f,ctx,toasts}=withEditor(async r=>{calls.push(r);});await openAIImagePlugin.activate(ctx);
      const menu=f.menus.find(m=>m.id===ids[0])!,command=f.commands.find(c=>c.id===ids[1])!;
      const second={...image,name:"b.png",path:"/media/b.png"};
      for(const invalid of [[],[image,second],[folder],[{...image,name:"a.gif",path:"/media/a.gif"}],[{...image,path:"demo://photo.png"}]]){
        expect(menu.when(invalid)).toBe(false);f.setSelection(invalid);expect(command.when?.()).toBe(false);await command.handler();
      }
      expect(calls).toEqual([]);expect(toasts.map(t=>t[1])).toEqual(Array(5).fill("info"));
    });
    it("reports a host refusal as a toast without throwing",async()=>{
      const {f,ctx,toasts}=withEditor(async()=>{throw new Error("Image editor is already open");});await openAIImagePlugin.activate(ctx);
      await expect(f.menus.find(m=>m.id===ids[0])!.handler([image])).resolves.toBeUndefined();
      expect(toasts).toEqual([["Image editor is already open","error"]]);
    });
  });
});
