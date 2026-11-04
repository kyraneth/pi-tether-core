import { timingSafeEqual } from "node:crypto";
/** Refuse non-string or different-length tokens before constant-time comparison. */
export function secretMatches(expectedValue: string, offered: unknown): boolean {
  if (typeof offered !== "string") return false;
  const expected = Buffer.from(expectedValue, "utf8");
  const actual = Buffer.from(offered, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(expected, actual);
}
