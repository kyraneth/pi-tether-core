import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRuntimeDirectory } from "pi-tether-core/runtime";
import { piContext } from "pi-tether-core/pi-context";
import { requestSignature, projectionHash, matchesPrefix } from "pi-tether-core/request";
import { secretMatches } from "pi-tether-core/security";
import { acceptInvocation } from "pi-tether-core/socket-transport";
import { registerApiDispatch } from "pi-tether-core/register";
import { createLifecycleRevision } from "pi-tether-core/lifecycle";
import { endStreamWithError } from "pi-tether-core/pi-stream";
import { createMcpBridge } from "pi-tether-core/mcp/bridge";
import { selectSystemPrompt } from "pi-tether-core/system-prompt";
import { metadataLedger } from "pi-tether-core/metadata-ledger";

describe("standalone package entry points", () => {
  it("resolves every published subpath with no sibling workspace", () => {
    for (const entry of [createRuntimeDirectory, piContext, requestSignature, secretMatches, acceptInvocation, registerApiDispatch, createLifecycleRevision, endStreamWithError, createMcpBridge, selectSystemPrompt, metadataLedger]) expect(typeof entry).toBe("function");
    const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(metadata.pi.extensions).toEqual([]);
    expect(metadata.keywords).toContain("pi-package");
    expect(metadata.license).toBe("MIT");
  });
  it("exercises the prefix example in README and the prompt example in technical details",  () => {
    const messages = [{ role: "user", content: "Hello" }];
    const checkpoint = { length: messages.length, hash: projectionHash(messages) };
    expect(matchesPrefix(messages, checkpoint, projectionHash)).toBe(true);
    expect(matchesPrefix([{ role: "user", content: "Changed" }], checkpoint, projectionHash)).toBe(false);
    expect(requestSignature(["model-name", { temperature: 0 }])).toBe('["model-name",{"temperature":0}]');
    expect(selectSystemPrompt({ promptModes: ["replace"], instructionMechanisms: ["client-config"] }, "replace", "Exact\n", "client-config").instructions).toBe("Exact\n");
  });
});
