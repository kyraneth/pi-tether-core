/** Send the normal Pi terminal error event and close the stream. */
export function endStreamWithError(stream: { push: (event: any) => void; end: () => void }, message: any, error: string, reason: "error" | "aborted"): void {
  stream.push({ type: "error", reason, error: { ...message, stopReason: reason, errorMessage: error } });
  stream.end();
}
