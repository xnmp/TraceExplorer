/** Job targets use artifact identity, which survives Saves and component merges. */
export function revealArtifactId(targetId: string): number {
  const match = /^artifact:([1-9]\d*)$/.exec(targetId);
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id)) throw new Error("Invalid Trace reveal target");
  return id;
}
