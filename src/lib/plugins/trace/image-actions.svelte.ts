/** Shared mutation ownership across thumbnail and details controls. */
let busyIds = $state<readonly number[]>([]);
export const imageActionState = {
  busy(id: number) { return busyIds.includes(id); },
  begin(id: number) { if (busyIds.includes(id)) return false; busyIds = [...busyIds, id]; return true; },
  end(id: number) { busyIds = busyIds.filter(value => value !== id); },
};
