<script lang="ts">
  import {onDestroy} from "svelte";
  import type {Component} from "svelte";
  import {tracePlugin} from "$lib/plugins/trace";
  import type {FileEntry} from "$lib/domain/file";
  import {paths} from "./fixture";
  type Contribution={component:Component<any>;props?:Record<string,unknown>;when:(entries:FileEntry[])=>boolean};
  type Command={id:string;handler:()=>void|Promise<void>};
  let contribution=$state.raw<Contribution|null>(null);
  let command=$state.raw<Command|null>(null);
  let entries=$state<FileEntry[]>([]);
  let remountRevision=$state(0);
  let selectionVersion=0;
  const folderSupport=new URLSearchParams(location.search).has('folders');
  let directory='/fixture/one';
  let directoryListener: ((path:string)=>void)|undefined;
  const selections:string[]=[];
  const commands:string[]=[];
  const listeners=new Map<string,()=>void>();
  const entry=(path:string):FileEntry=>({path,name:path.split("/").at(-1)!,kind:"file",size:32,modified:"2026-10-05T00:00:00Z"});
  const visible=$derived(contribution?.when(entries)??false);
  export function choose(path:string){entries=[entry(path)];selectionVersion+=1;}
  export function clear(){entries=[];selectionVersion+=1;}
  export function nonImage(){entries=[entry("/fixture/note.txt")];selectionVersion+=1;}
  export function multiple(){entries=[entry(paths.source),entry(paths.edit)];selectionVersion+=1;}
  export function remount(){remountRevision+=1;}
  export function selectionCalls(){return [...selections];}
  export function commandCalls(){return [...commands];}
  export function predicate(){return contribution?.when(entries)??false;}
  export function invalidate(){listeners.get("trace:changed")?.();}
  export function changeDirectory(path:string){directory=path;clear();directoryListener?.(path);}
  async function selectFile(path:string){selections.push(path);choose(path);}
  function captureSelection(){const version=selectionVersion;return()=>version===selectionVersion;}
  async function toggle(){if(command){commands.push(command.id);await command.handler();}}
  tracePlugin.activate({
    registerInspector(value){contribution=value;},
    registerCommand(value){command=value;},
    events:{listen(name:string,callback:()=>void){listeners.set(name,callback);}},
    workspace:{getSelection:()=>entries,selectFile,captureSelection,onFilesChanged(){},
      ...(folderSupport ? {getCurrentDirectory:()=>directory,onDirectoryChanged(callback:(path:string)=>void){directoryListener=callback;callback(directory);}} : {})},
  } as any);
  onDestroy(()=>tracePlugin.deactivate?.());
</script>
<main>
  <h1>Trace contribution lifecycle fixture</h1>
  <p data-selection>{entries.length?entries.map(entry=>entry.path).join(" | "):"No selection"}</p>
  <nav>
    <button onclick={()=>choose(paths.source)}>Select image</button>
    <button onclick={clear}>Clear selection</button>
    <button onclick={nonImage}>Select non-image</button>
    <button onclick={multiple}>Select multiple images</button>
    <button onclick={()=>choose(paths.empty)}>Select untraced image</button>
    <button onclick={toggle}>Toggle Trace pane</button>
    <button onclick={remount}>Remount contribution</button>
    <button onclick={invalidate}>Refresh trace</button>
    {#if folderSupport}
      <button onclick={()=>changeDirectory('/fixture/one')}>Open traced folder</button>
      <button onclick={()=>changeDirectory('/fixture/empty')}>Open empty folder</button>
    {/if}
  </nav>
  {#if visible && contribution}
    <section class="inspector" aria-label="Trace contribution">
      {#key remountRevision}
        {@const Inspector=contribution.component}
        <Inspector {entries} {...contribution.props}/>
      {/key}
    </section>
  {/if}
</main>
<style>
  :global(body){margin:0;background:#f5f6f7;font:13px system-ui;--text-primary:#20252e;--text-secondary:#68717e;--background-card-secondary:#fff;--background-solid:#fff;--control-stroke:#cbd1d8;--surface-stroke:#d9dfe5;--radius-sm:6px;--subtle-fill-secondary:#edf2fd;--accent-text:#175dd8;--focus-stroke-outer:#175dd8;}
  main{max-width:850px;margin:20px auto;padding:0 18px;}h1{font-size:20px;}
  nav{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0;}nav button{padding:8px;border:1px solid #bdc5d0;border-radius:5px;background:white;cursor:pointer;}
  .inspector{width:380px;min-height:560px;border:1px solid #d9dfe5;background:white;border-radius:8px;}
</style>
