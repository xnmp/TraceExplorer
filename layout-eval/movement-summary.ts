/** Restore movement is correct by product rule, but remains visible separately.
 * Keep both historical per-layout means and changed-transition means: initial and
 * unchanged states must not dilute the latter when the two populations differ.
 */
interface Movement { readonly movedFraction: number; readonly anchorDisplacement: number }
interface Row { readonly changed: boolean; readonly revisited?: boolean; readonly metrics: Movement | null }
export function movementSummary(rows: readonly Row[]) {
  const summarize = (restore: boolean) => {
    const selected = rows.filter(row => !!row.revisited === restore && row.metrics !== null);
    const changed = selected.filter(row => row.changed);
    const mean = (population: readonly Row[]): Movement | null => population.length ? {
      movedFraction: population.reduce((sum, row) => sum + row.metrics!.movedFraction, 0) / population.length,
      anchorDisplacement: population.reduce((sum, row) => sum + row.metrics!.anchorDisplacement, 0) / population.length,
    } : null;
    return { layouts: selected.length, transitions: changed.length, mean: mean(selected), changed: mean(changed) };
  };
  return { newStates: summarize(false), exactRestores: summarize(true) };
}
