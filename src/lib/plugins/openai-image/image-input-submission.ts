import type { ImageInput } from "$lib/domain/image-inputs";
import { basename } from "$lib/domain/path";

interface InputSubmissionOptions {
  readonly getInputs: () => readonly ImageInput[];
  readonly pendingInspection: Promise<string | null> | null;
  readonly inspect: () => Promise<string | null>;
  readonly keepsSize: boolean;
}

/** Finish required inspection and reject unusable inputs before a job can start. */
export async function prepareImageInputSubmission(options: InputSubmissionOptions): Promise<void> {
  const inputs = options.getInputs();
  let problem: string | null = null;
  if (options.pendingInspection || inputs.some((input) => !input.digest && !input.error) || (options.keepsSize && !inputs[0]?.size)) {
    problem = await (options.pendingInspection ?? options.inspect());
  }
  const current = options.getInputs();
  const unusable = current.find((input) => input.error);
  if (unusable) throw new Error(`Remove ${basename(unusable.path)}: ${unusable.error}`);
  if (problem) throw new Error(problem);
  const uninspected = current.find((input) => !input.digest);
  if (uninspected) throw new Error(`Cannot read ${basename(uninspected.path)}: inspection unavailable`);
  if (options.keepsSize && !current[0]?.size) throw new Error("Wait for Image 1 to load, or choose an aspect ratio");
}
