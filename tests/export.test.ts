import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { allowedPublicPath, exportManifest } from "../scripts/export-manifest.mjs";
import { scanManifest, violations } from "../scripts/public-tree.mjs";

function fixture() {
  // Retain synthetic fixtures for inspection; never copy real credentials.
  const root = mkdtempSync(join(tmpdir(), "tether-export-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(join(root, "README.md"), "Public example\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/example.ts"), "export const example = true;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}
describe("exact public export boundary", () => {
  it("exports technical details and diagram sources without opening other documentation paths", () => {
    for (const path of ["docs/DETAILS.md", "assets/family-dark.svg", "assets/family-light.svg", "assets/family.mmd"]) expect(allowedPublicPath(path)).toBe(true);
    for (const path of ["docs/private.md", "assets/private.txt", "internal/private.svg"]) expect(allowedPublicPath(path)).toBe(false);
  });
  it("hash-binds the exported bytes and rejects missing or stale records", () => {
    const root = fixture();
    const manifest = exportManifest(root);
    expect(scanManifest(manifest, root)).toEqual([]);
    expect(() => scanManifest({ ...manifest, files: manifest.files.slice(1) }, root)).toThrow();
    writeFileSync(join(root, "README.md"), "Changed after review\n");
    expect(() => scanManifest(manifest, root)).toThrow();
  });
  it("detects synthetic credentials without logging matched bytes", () => {
    const seeded = [
      "gh" + "p_" + "x".repeat(36),
      "api_key = '" + "x".repeat(32) + "'",
    ];
    for (const text of seeded) {
      const findings = violations("README.md", Buffer.from(text));
      expect(findings.length).toBeGreaterThan(0);
      expect(Object.keys(findings[0])).toEqual(["path", "rule"]);
      expect(JSON.stringify(findings)).not.toContain(text);
    }
    expect(violations("README.md", Buffer.from("Public adapter documentation; person@example.invalid; /home/example ; 203.0.113.8; fixture-session-abc"))).toEqual([]);
    expect(violations("scripts/public-tree.mjs", readFileSync(new URL("../scripts/public-tree.mjs", import.meta.url)))).toEqual([]);
  });
  it("scans exported content rather than an unrelated clean source", () => {
    const root = fixture();
    writeFileSync(join(root, "README.md"), "gh" + "p_" + "x".repeat(36));
    const manifest = exportManifest(root);
    const findings = scanManifest(manifest, root);
    expect(findings).toContainEqual({ path: "README.md", rule: "credential-token" });
    expect(findings.every(finding => finding.path === "README.md")).toBe(true);
  });
});
