import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedPublicPath, exportManifest, fileRecord, packageRoot } from "./export-manifest.mjs";

// Optional local policy is deliberately outside the export boundary.
const policyURL = new URL("../internal/public-policy.mjs", import.meta.url);
const policy = existsSync(policyURL) ? await import(policyURL.href) : undefined;
if (policy && typeof policy.violations !== "function") throw new Error("Invalid local policy");
export const policyApplied = Boolean(policy);
const rules = [
  ["private-key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i],
  ["credential-token", /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})/],
  ["credential-literal", /(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["'][A-Za-z0-9_+/-]{20,}["']/i],
  ["credential-url", /https?:\/\/[^\s/@]+:[^\s/@]+@/i],
  ["personal-email", /\b[A-Z0-9._%+-]+@(?!example\.(?:invalid|com|net|org)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];
export function violations(path, bytes) {
  const text = path + "\n" + bytes.toString("utf8");
  return [...rules.filter(([, pattern]) => pattern.test(text)).map(([rule]) => ({ path, rule })), ...(policy?.violations(path, bytes) ?? [])];
}
function paths(root, prefix = "") {
  return readdirSync(resolve(root, prefix)).sort().flatMap(name => {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(resolve(root, path));
    if (stat.isSymbolicLink()) throw new Error("Links are not export bytes");
    if (stat.isDirectory()) return paths(root, path);
    if (!stat.isFile()) throw new Error("Non-regular export entry");
    return [path];
  });
}
function sameRecords(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
export function scanManifest(manifest, root = packageRoot, expected = exportManifest(root)) {
  if (manifest.format !== "public-export-v1" || !sameRecords(manifest.files, expected.files)) throw new Error("Manifest differs from exact export");
  const findings = [];
  for (const record of manifest.files) {
    if (!sameRecords(record, fileRecord(root, record.path))) throw new Error("Export bytes changed since manifest creation");
    findings.push(...violations(record.path, readFileSync(resolve(root, record.path))));
  }
  return findings;
}
function packageManifest(root) {
  const files = paths(root).map(path => {
    if (!(path === "package.json" || path === "README.md" || path === "LICENSE" || path === "docs/DETAILS.md" || /^assets\/[A-Za-z0-9_.-]+\.(?:svg|mmd)$/.test(path) || path.startsWith("src/")) || !allowedPublicPath(path)) throw new Error("Unexpected package entry");
    return fileRecord(root, path);
  });
  if (!["package.json", "README.md", "LICENSE"].every(path => files.some(f => f.path === path))) throw new Error("Missing package metadata");
  const metadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  for (const path of [...Object.values(metadata.exports), "src/mcp/server.cjs"]) if (!files.some(f => "./" + f.path === path || f.path === path)) throw new Error("Missing runtime export");
  return { format: "public-export-v1", files };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let root = packageRoot, manifest, expected;
    if (args[0] === "--package" && args.length === 2) {
      root = resolve(args[1]); manifest = packageManifest(root); expected = manifest;
    } else if (args.length === 0 || args.length === 1 || (args.length === 3 && args[1] === "--tree")) {
      if (args[1] === "--tree") root = resolve(args[2]);
      manifest = args[0] ? JSON.parse(readFileSync(args[0], "utf8")) : exportManifest(root);
      expected = args[1] === "--tree" ? { format: "public-export-v1", files: paths(root).map(path => fileRecord(root, path)) } : exportManifest(root);
    } else throw new Error("Usage: public-tree.mjs [manifest.json [--tree directory]] | --package directory");
    const findings = scanManifest(manifest, root, expected);
    console.log(JSON.stringify({ status: findings.length ? "failed" : policyApplied ? "clear" : "not-applied", policyApplied, files: manifest.files.length, bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0), findings }, null, 2));
    if (findings.length) process.exitCode = 1;
  } catch { console.error("Scan refused: invalid manifest, changed bytes or unexpected file boundary"); process.exitCode = 1; }
}
