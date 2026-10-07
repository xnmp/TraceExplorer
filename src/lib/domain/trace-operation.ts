/** Human label for a recorded run's operation id. */
export function traceOperationLabel(operation: string): string {
  if (operation === "image.crop") return "Crop";
  if (operation === "openai.image.edit") return "OpenAI edit";
  if (operation === "openai.image.generate") return "OpenAI image";
  return operation.replace(/^image\./, "");
}
