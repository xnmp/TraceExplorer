/** Request-local typed outcomes; no diagnostic global supplies a failure cause. */
import type { IncrementalRoutingConflict } from '../incremental-routing';
import type { GridCell, GridRect } from '../grid-flow';
import type { FolderLayout } from './types';
export interface FolderWorldPreferences {readonly cells:ReadonlyMap<string,GridCell>;readonly cellFootprints?:ReadonlyMap<string,GridRect>}
export type FolderWorldRoutingResult={readonly ok:true;readonly drawing:FolderLayout;readonly work:number}|{readonly ok:false;readonly conflict:IncrementalRoutingConflict;readonly work:number};
export class WorldPlacementDecline extends Error {constructor(readonly conflict:IncrementalRoutingConflict){super(conflict.constraints.join('; '));}}
export function worldReject(constraint:string,reason:IncrementalRoutingConflict['reason']='metric-conflict'):never {throw new WorldPlacementDecline({reason,constraints:[constraint]});}
/** A core callback must return a semantic conflict so its exact paid work survives. */
export function guardedWorld<T>(run:()=>T):T|IncrementalRoutingConflict {try{return run();}catch(error){if(error instanceof WorldPlacementDecline)return error.conflict;throw error;}}
