/** Prompt replacement is a capability, never an inferred launch default. */
export type PromptMode = "replace" | "append" | "none";
export interface PromptCapabilities { promptModes: readonly PromptMode[]; instructionMechanisms: readonly string[] }
export function assertPromptMode(capabilities: PromptCapabilities, requested: PromptMode): void {
  if (!["replace", "append", "none"].includes(requested) || !capabilities.promptModes.includes(requested)) throw new Error(`Unsupported system prompt mode: ${requested}`);
  if (requested !== "none" && !capabilities.instructionMechanisms.length) throw new Error("No qualified instruction mechanism");
}
/** Select exact bytes once, before process/model submission. No fallback or file IO. */
export function selectSystemPrompt(capabilities: PromptCapabilities, requested: PromptMode, instructions: string, mechanism?: string) {
  assertPromptMode(capabilities, requested);
  if (requested === "none") {
    if (instructions !== "" || mechanism !== undefined) throw new Error("None mode cannot carry Pi instructions");
    return { mode: requested, instructions: "" };
  }
  if (!mechanism || !capabilities.instructionMechanisms.includes(mechanism)) throw new Error("Unsupported instruction mechanism");
  return { mode: requested, instructions, mechanism };
}
