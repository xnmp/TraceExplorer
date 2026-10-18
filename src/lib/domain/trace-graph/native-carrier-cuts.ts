/** Finite geometric branch alternatives on authored source-owned L intervals.
 * Coordinate proposals come only from the current candidate and displayed
 * geometry; final topology/native admission remain independent. */
import type { GraphLayout, PlacedNode } from './layout';
import { pathCommands, type Point } from './path-sampling';
import { PORT_BERTH, LANE_SEPARATION } from './metrics';

export function nativeCarrierCuts(drawing:GraphLayout, source:string, target:PlacedNode, goal:Point,
  charge:(work:number,reason?:string)=>void):readonly (readonly Point[])[] {
  charge(10*(drawing.nodes.size+drawing.junctions.size+1),'carrier cut coordinate inputs');
  const xs=new Set<number>([goal.x,goal.x-PORT_BERTH-LANE_SEPARATION,goal.x+PORT_BERTH+LANE_SEPARATION,target.x,target.x+target.width/2,target.x+target.width]);
  const ys=new Set<number>([goal.y,goal.y-PORT_BERTH-LANE_SEPARATION,goal.y+PORT_BERTH+LANE_SEPARATION,target.y,target.y+target.height/2,target.y+target.height]);
  for(const node of drawing.nodes.values()){
    xs.add(node.x-PORT_BERTH);xs.add(node.x+node.width/2);xs.add(node.x+node.width+PORT_BERTH);
    ys.add(node.y-PORT_BERTH);ys.add(node.y+node.height/2);ys.add(node.y+node.height+PORT_BERTH);
  }
  for(const dot of drawing.junctions.values()){
    xs.add(dot.x-PORT_BERTH);xs.add(dot.x);xs.add(dot.x+PORT_BERTH);
    ys.add(dot.y-PORT_BERTH);ys.add(dot.y);ys.add(dot.y+PORT_BERTH);
  }
  const cuts:Point[][]=[],seen=new Set<string>();
  charge(drawing.routes.length,'carrier cut source scan');
  for(const route of drawing.routes){
    if(route.from.kind!=='node'||route.from.id!==source)continue;
    charge(route.path.length+1,'carrier cut native parse');
    const commands=pathCommands(route.path);if(!commands)continue;
    charge(commands.length,'carrier cut endpoints');
    const points=commands.map(command=>({x:command.values.at(-2)!,y:command.values.at(-1)!}));
    for(let i=1;i<commands.length;i++){
      if(commands[i].kind!=='L')continue;
      const a=points[i-1],b=points[i],vertical=a.x===b.x&&a.y!==b.y,horizontal=a.y===b.y&&a.x!==b.x;
      if(!vertical&&!horizontal)continue;
      const coordinates=vertical?ys:xs;
      charge(8*coordinates.size+1,'carrier cut interval projections');
      for(const coordinate of coordinates){
        if(!(coordinate>Math.min(vertical?a.y:a.x,vertical?b.y:b.x)&&coordinate<Math.max(vertical?a.y:a.x,vertical?b.y:b.x)))continue;
        const p=vertical?{x:a.x,y:coordinate}:{x:coordinate,y:a.y};
        charge(64,'carrier cut identity');const id=JSON.stringify([p.x,p.y]);
        if(seen.has(id))continue;seen.add(id);cuts.push([p]);
      }
    }
  }
  charge(cuts.length,'carrier cut candidate order');
  return cuts.sort((a,b)=>{charge(1,'carrier cut order comparison');return Math.abs(a[0].x-goal.x)+Math.abs(a[0].y-goal.y)-Math.abs(b[0].x-goal.x)-Math.abs(b[0].y-goal.y);});
}
