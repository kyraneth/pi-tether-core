import * as ai from "@earendil-works/pi-ai";

/** Accept both pi's legacy Context and its system-message TranscriptContext. */
export function piContext(context: {
  messages: any[];
  systemPrompt?: string;
  tools?: any[];
}) {
  const transcript = context.messages.some((m) => m.role === "system");
  return {
    systemPrompt: transcript
      ? (ai as any).getCurrentSystemPrompt(context.messages)
      : (context.systemPrompt ?? ""),
    tools: transcript
      ? (ai as any).getCurrentTools(context.messages)
      : (context.tools ?? []),
    messages: context.messages.filter((m) => m.role !== "system"),
  };
}
