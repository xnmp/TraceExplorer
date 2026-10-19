/** New host cells are preferences only. No band layout or route is requested. */
import { gridFlow } from '../grid-flow';
import type { FolderGridGeometry } from '../folder-grid';
import { RoutingConflictError } from '../layout';
import type { IncrementalWorkBudget } from '../band-incremental';
import { chargeRoutingSnapshot } from '../routing-problem';
import { withCellFootprints } from './cell-footprints';
import type { FolderLayoutInput } from './types';
import { WorldPlacementDecline, type FolderWorldPreferences } from './world-result';
export function folderWorldPreferences(input:FolderLayoutInput,geometry:FolderGridGeometry,work:IncrementalWorkBudget):FolderWorldPreferences {
 if(!work||!Number.isSafeInteger(work.remaining)||work.remaining<0||work.automaticRemaining!==undefined&&(!Number.isSafeInteger(work.automaticRemaining)||work.automaticRemaining<0))throw new WorldPlacementDecline({reason:'unsupported-input',constraints:['finite nonnegative integer shared folder work allowance']});
 const charge=(n:number,why?:string)=>{if(!Number.isFinite(n)||n<0||n>work.remaining||(work.automaticRemaining!==undefined&&n>work.automaticRemaining))throw new RoutingConflictError({kind:'search-exhausted',constraints:['folder host preferences',why??'work']});work.remaining-=n;if(work.automaticRemaining!==undefined)work.automaticRemaining-=n;};
 chargeRoutingSnapshot([input.items,input.tile,input.grid,geometry],charge);charge(16*(input.items.length+1),'host flow and physical footprints');
 const flow=gridFlow(input.items,new Map(),geometry.columns,{cellWidth:geometry.cellWidth,cellHeight:geometry.cellHeight,columnGap:geometry.gap,rowGap:geometry.gap});
 const painted=withCellFootprints({columns:geometry.columns,size:{width:flow.width,height:flow.height},bounds:{x:0,y:0,width:flow.width,height:flow.height},cells:flow.cells,bands:[],rowBands:[],graphs:new Map()},input);
 return {cells:painted.cells,cellFootprints:painted.cellFootprints};
}
