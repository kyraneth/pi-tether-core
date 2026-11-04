import { createHash } from "node:crypto";
/** Preserve ordered, caller-projected request bytes. */
export function requestSignature(fields: unknown[]): string { return JSON.stringify(fields); }
export function projectionHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function matchesPrefix<T>(messages: T[], checkpoint: { length: number; hash: string }, hash: (value: T[]) => string): boolean {
  return messages.length >= checkpoint.length && hash(messages.slice(0, checkpoint.length)) === checkpoint.hash;
}
