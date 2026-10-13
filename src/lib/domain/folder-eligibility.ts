import type { FileViewEligibility } from "../../../integration/plugin-sdk";
import { isVirtualPath } from "./virtual-path";

/** Exact answers (including lookup failures) override optimistic candidates. */
export function folderEligibility(directory: string, known: boolean | undefined, candidate: boolean): FileViewEligibility {
  if (!directory || isVirtualPath(directory)) return false;
  return known ?? (candidate ? true : "pending");
}

/** Older hosts may interpret the pending string as true. */
export function compatibleFolderEligibility(answer: FileViewEligibility, supportsPending: boolean): FileViewEligibility {
  return answer === "pending" && !supportsPending ? false : answer;
}
