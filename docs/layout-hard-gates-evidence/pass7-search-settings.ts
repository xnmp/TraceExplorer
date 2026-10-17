import {cp,readFile,writeFile} from 'node:fs/promises';
const [name,scale,retries]=process.argv.slice(2);const k=Number(scale),n=Number(retries);const root='/tmp/layout-search-'+name;
await cp('/tmp/layout-search-base',root,{recursive:true});
for(const file of ['band-incremental.ts','repair-route-contacts.ts']){
 const path=root+'/src/lib/domain/trace-graph/'+file;let code=await readFile(path,'utf8');
 for(const key of ['SECOND_CHANCE_WORK','PROBE_WORK','FALLBACK_WORK','MAX_PROBES','MAX_REPAIRS'])code=code.replace(new RegExp(`const ${key} = ([\\d_]+);`),(_,num)=>`const ${key} = ${Number(num.replaceAll('_',''))*k};`);
 code=code.replace('slots: 16, budget: 50_000',`slots: ${16*k}, budget: ${50000*k}`);await writeFile(path,code);
}
const path=root+'/src/lib/domain/trace-graph/band-layout.ts';let code=await readFile(path,'utf8');code=code.replace('for (const policy of ["constrained", "repairable"] as const)',`for (const [retry, policy] of Array.from({length:${n}}, (_, i) => [[i, 'constrained'], [i, 'repairable']] as const).flat())`);
code=code.replace('incrementalTree(request, previous, incrementalBudget(), policy)','incrementalTree(request, previous, Object.fromEntries(Object.entries(incrementalBudget()).map(([key,value])=>[key,value * (retry + 1)])) as ReturnType<typeof incrementalBudget>, policy)');await writeFile(path,code);console.log(root);
