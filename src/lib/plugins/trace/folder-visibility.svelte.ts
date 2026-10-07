import type { PluginContext } from "../api";
import { invoke } from "$lib/api/common";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { samePath } from "$lib/domain/path";

let supported = $state(false);
let directory = $state<string|null>(null);
let eligible = $state.raw<ReadonlyMap<string,boolean>>(new Map());
let scope = 0;
const pending = new Set<string>();
const dirty = new Set<string>();
function refresh(path: string) {
  if (isVirtualPath(path)) return;
  if (pending.has(path)) { dirty.add(path); return; }
  pending.add(path);
  const current = scope;
  void invoke<boolean>("folder_has_trace",{directory:path}).then(value=>{
    if (current !== scope || dirty.has(path)) return;
    const next = new Map(eligible);next.delete(path);next.set(path,value===true);
    if(next.size>128)next.delete(next.keys().next().value!);
    eligible = next;
  }).catch(()=>{if(current===scope){const next=new Map(eligible);next.set(path,false);eligible=next;}}).finally(()=>{
    if (current !== scope) return;
    pending.delete(path);
    if (dirty.delete(path)) refresh(path);
  });
}
export const traceFolderVisibility = {
  get supported() { return supported; },
  get eligible() { return directory !== null && !isVirtualPath(directory) && eligible.get(directory) === true; },
  bind(ctx: PluginContext) {
    this.clear();
    supported = !!ctx.workspace.onDirectoryChanged;
    ctx.workspace.onDirectoryChanged?.(path=>{directory=path;if(path)refresh(path);});
    ctx.workspace.onFilesChanged(paths=>{const current=directory;if(current && paths.some(path=>samePath(path,current)))refresh(current);});
  },
  refresh() { if (directory) refresh(directory); },
  clear() { scope += 1; supported=false;directory=null;eligible=new Map();pending.clear();dirty.clear(); },
};
