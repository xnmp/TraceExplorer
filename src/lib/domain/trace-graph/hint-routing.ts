/** Request-local hint policy. The core captures its actual source before calling
 * this factory; the preferred pose never supplies replacement source constants. */
import type { IncrementalFrameFactory } from './incremental-routing';
import { deriveHintRoutingDrawing } from './hint-routing-frame';
import { declareHintRoutingFrame } from './hint-routing-declarations';
import { HintRoutingError } from './hint-routing-policy';
import { RoutingImportError } from './routing-plan';

export function hintRoutingFrame(heights: ReadonlyMap<string, number>): IncrementalFrameFactory {
  return (source, charge, choose) => {
    const descend = choose('retained hint pose', [false, true]);
    let chargeFailed = false;
    const checkedCharge: typeof charge = (work, reason) => {
      try { charge(work, reason); } catch (error) { chargeFailed = true; throw error; }
    };
    try {
      const preferred = deriveHintRoutingDrawing(source, heights, descend, checkedCharge);
      if (!preferred) return { reason: 'topology-conflict', constraints: ['hint pose has no native core'] };
      const frames = declareHintRoutingFrame(source, preferred, checkedCharge, heights, descend);
      return { preferred, frames };
    } catch (error) {
      if (chargeFailed) throw error;
      if (error instanceof RoutingImportError) return { reason: 'unsupported-input', constraints: [error.message] };
      if (!(error instanceof HintRoutingError)) throw error;
      return { reason: error.reason, constraints: [error.message] };
    }
  };
}
