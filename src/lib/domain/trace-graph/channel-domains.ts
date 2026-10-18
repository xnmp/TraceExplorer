/** Exact capacity pruning for small unordered channels. State is the set of
 * assigned segments and its smallest possible final coordinate. Larger groups
 * skip this optional pruning; the final separation solve still checks them. */
export interface ChannelDomain { readonly id: string; readonly intervals: readonly {readonly low:number;readonly high:number}[] }
export function smallChannelOrder(domains: readonly ChannelDomain[], gap: number): readonly string[] | null | undefined {
  if (domains.length>8) return undefined;
  if (!Number.isFinite(gap) || gap<0 || new Set(domains.map(d=>d.id)).size!==domains.length
    || domains.some(d=>d.intervals.some(v=>!Number.isFinite(v.low) || !Number.isFinite(v.high) || v.low>v.high))) return null;
  const sorted=domains.map(d=>[...d.intervals].sort((a,b)=>a.low-b.low));
  const ends=new Array<number>(1<<domains.length).fill(Infinity), previous=new Array<number>(ends.length), picked=new Array<number>(ends.length);
  ends[0]=-Infinity;
  for(let mask=0;mask<ends.length;mask++) if(ends[mask]<Infinity) for(let i=0;i<domains.length;i++) if(!(mask&(1<<i))) {
    const lower=ends[mask]+gap, interval=sorted[i].find(v=>v.high>=lower);
    if(!interval) continue;
    const position=Math.max(lower,interval.low), next=mask|(1<<i);
    if(position<ends[next]) {ends[next]=position;previous[next]=mask;picked[next]=i;}
  }
  let mask=ends.length-1;
  if(ends[mask]===Infinity) return null;
  const order:string[]=[];
  while(mask) {order.push(domains[picked[mask]].id);mask=previous[mask];}
  return order.reverse();
}

/** Minimum free-boundary extension for this ordered separation DAG. Alignment
 * delay belongs only to lower bounds whose downstream path reaches the boundary. */
export function freeBoundaryGrowth(variables: readonly {readonly id:string;readonly lower:number;readonly alignmentSlack:number}[],
  order: readonly string[], separations: readonly {readonly before:string;readonly after:string;readonly gap:number}[], boundary:number): number {
  const distance=new Map(order.map(id=>[id,0]));
  const following=new Map<string,typeof separations[number][]>();
  for(const edge of separations) {
    const next=following.get(edge.before);
    if(next) next.push(edge); else following.set(edge.before,[edge]);
  }
  for(let i=order.length-1;i>=0;i--) {
    let longest=0;
    for(const edge of following.get(order[i])??[]) longest=Math.max(longest,edge.gap+distance.get(edge.after)!);
    distance.set(order[i],longest);
  }
  let growth=0;
  for(const variable of variables) {
    const needed=variable.lower+distance.get(variable.id)!-boundary;
    if(needed>0) growth=Math.max(growth,needed+variable.alignmentSlack);
  }
  return growth;
}
