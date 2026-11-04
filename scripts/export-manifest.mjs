import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootFiles = new Set([".gitignore", "package.json", "package-lock.json", "README.md", "LICENSE"]);
export function allowedPublicPath(path) {
  return rootFiles.has(path) || path === "docs/DETAILS.md" || /^assets\/[A-Za-z0-9_.-]+\.(?:svg|mmd)$/.test(path) || /^(src|tests|scripts)\/[A-Za-z0-9_./-]+$/.test(path);
}
export function fileRecord(root, path) {
  if (!allowedPublicPath(path) || path.split("/").some(part => part === ".." || part === ".")) throw new Error("Disallowed export path");
  const absolute = resolve(root, path);
  if (!realpathSync(absolute).startsWith(realpathSync(root) + "/") || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error("Export must contain regular owned files");
  const bytes = readFileSync(absolute);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
export function exportManifest(root = packageRoot) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = tracked.filter(allowedPublicPath).sort().map(path => fileRecord(root, path));
  if (!files.length) throw new Error("Empty public export");
  return { format: "public-export-v1", files };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(exportManifest(), null, 2) + "\n"); }
  catch { console.error("Export failed: check indexed paths and file types"); process.exitCode = 1; }
}
