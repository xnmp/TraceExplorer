/** Diagnostic-only hooks in a temporary copy; production has no observer or mutable audit state.
 * bun layout-eval/instrument-anchor.ts <source-root> [temporary-root]
 */
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const source=resolve(process.argv[2]??'.');
const target=process.argv[3]?resolve(process.argv[3]):await mkdtemp('/tmp/trace-anchor-audit-');
if(!target.startsWith('/tmp/') && !target.startsWith('/var/tmp/te-wt2/')) throw new Error('Use a temporary checkout');
if(target===source)throw new Error('Instrumentation must not edit the source checkout');
await mkdir(target,{recursive:true});
await cp(join(source,'src'),join(target,'src'),{recursive:true});
await cp(join(source,'layout-eval'),join(target,'layout-eval'),{recursive:true,filter:path=>!path.startsWith(join(source,'layout-eval/out'))});
const path=join(target,'src/lib/domain/trace-graph/band-layout.ts');
let code=await readFile(path,'utf8');
const replace=(from:string,to:string)=>{if(!code.includes(from))throw new Error(`Missing instrumentation seam: ${from}`);code=code.replace(from,to);};
replace('    return { ...c, height: bandExtent(skeleton, key).height, holds,',
  '    (globalThis as any).__anchorAudit?.push({kind:"candidate",name:c.name,layout:c.layout,holds,request,previous});\n    return { ...c, height: bandExtent(skeleton, key).height, holds,');
replace('    if (incremental) history.push',
  '    (globalThis as any).__anchorAudit?.push({kind:"incremental",ok:!!incremental});\n    if (incremental) history.push');
replace('      if (compact) history.push',
  '      (globalThis as any).__anchorAudit?.push({kind:"repack",ok:!!compact});\n      if (compact) history.push');
replace('        if (!alternative) continue;',
  '        (globalThis as any).__anchorAudit?.push({kind:policy,ok:!!alternative,failure:alternative&&geometryGate(attachSingleBand(alternative,request),request.items,key,request.maxWidth)});\n        if (!alternative) continue;');
await writeFile(path,code);
console.log(target);
