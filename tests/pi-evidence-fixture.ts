// Offline real-Pi proof fixture. Not a vendor adapter or shipped extension.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createMcpBridge } from "../src/mcp/bridge.js";
import { registerApiDispatch } from "../src/register.js";

export default function(pi: any) {
  const id = "core-evidence-fixture";
  const corpus = JSON.parse(readFileSync(new URL("../conformance/tool-results.json", import.meta.url), "utf8"));
  const selected = corpus.cases.find((c: any) => c.id === process.env.CORE_EVIDENCE_CASE);
  if (!selected) throw new Error("CORE_EVIDENCE_CASE must name a corpus case");
  const log = (row: any) => appendFileSync(process.env.CORE_EVIDENCE_LOG!, JSON.stringify(row) + "\n");
  let manager: any, bridge: any, invocation: any, child: any, response: Promise<any>;
  pi.on("session_start", (_: any, ctx: any) => { manager = ctx.sessionManager; });
  const schema = { type: "object", properties: {}, additionalProperties: false };
  pi.registerTool({ name: "evidence_result", label: "Synthetic evidence", description: "Synthetic corpus result", parameters: schema,
    async execute() { log({ event: "pi_executed", case: selected.id }); return { ...selected.result, details: {} }; } });
  const stream = (model: any, context: any) => {
    const s = createAssistantMessageEventStream();
    const out: any = { role: "assistant", content: [], api: id, provider: id, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    void (async () => {
      try {
        s.push({ type: "start", partial: out });
        if (!bridge) {
          bridge = createMcpBridge({ sessionId: manager.getSessionId(), generation: "fixture-generation",
            tools: [{ name: "evidence_result", inputSchema: schema }], onInvocation(inv: any) {
              invocation = inv;
              const call = { type: "toolCall" as const, id: inv.piCallId, name: inv.name, arguments: inv.arguments };
              out.content.push(call); out.stopReason = "toolUse";
              s.push({ type: "toolcall_start", contentIndex: 0, partial: out });
              s.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: out });
              s.push({ type: "done", reason: "toolUse", message: out }); s.end();
            } });
          const d = await bridge.start();
          child = spawn(d.command, d.args, { stdio: "pipe", env: { ...process.env, ...d.env } });
          const pending = new Map();
          createInterface({ input: child.stdout }).on("line", line => { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); });
          const rpc = (n: number, method: string, params: any) => new Promise(resolve => {
            pending.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
          });
          await rpc(1, "initialize", {});
          response = rpc(2, "tools/call", { name: "evidence_result", arguments: {} });
        } else {
          const entry = manager.getBranch().findLast((x: any) => x.type === "message" && x.message?.role === "toolResult" && x.message.toolCallId === invocation.piCallId);
          const last = context.messages.findLast((x: any) => x.role === "toolResult" && x.toolCallId === invocation.piCallId);
          if (!entry || !last || JSON.stringify(entry.message.content) !== JSON.stringify(last.content)) throw new Error("No identical Pi journaled result");
          const result = { content: last.content, isError: last.isError === true };
          bridge.journalResult({ ...invocation, journalEntryId: entry.id, result });
          await response;
          // Synthetic adapter reconstruction deliberately matches the journal.
          // A wrong-body seed still must fence, regardless of declared strength.
          const observed = process.env.CORE_EVIDENCE_WRONG ? { content: [{ type: "text", text: "wrong synthetic body" }] } : result;
          const equal = bridge.verifyContent(invocation, observed);
          const receipt = bridge.receipts()[0];
          log({ event: "receipt", journalEntryId: entry.id, equal, states: receipt.states, evidence: receipt.evidence });
          if (process.env.CORE_EVIDENCE_WRONG) {
            if (equal || receipt.states.at(-1) !== "mismatch") throw new Error("Wrong body was accepted");
            let fenced = false; try { bridge.setAttached(true); } catch { fenced = true; }
            if (!fenced) throw new Error("Wrong body did not fence");
          } else if (!equal || receipt.evidence?.kind !== "unknown" || receipt.states.includes("content_verified")) throw new Error("Legacy reconstruction overclaimed exact evidence");
          const text = "CORE_EVIDENCE_OK";
          out.content.push({ type: "text", text });
          s.push({ type: "text_start", contentIndex: 0, partial: out });
          s.push({ type: "text_delta", contentIndex: 0, delta: text, partial: out });
          s.push({ type: "text_end", contentIndex: 0, content: text, partial: out });
          s.push({ type: "done", reason: "stop", message: out }); s.end();
          child.stdin.end(); await bridge.retire();
        }
      } catch (e: any) {
        out.stopReason = "error"; out.errorMessage = String(e?.stack || e);
        s.push({ type: "error", reason: "error", error: out }); s.end();
        child?.stdin.end(); if (bridge) await bridge.retire();
      }
    })();
    return s;
  };
  registerApiDispatch(id, stream);
  const template = getBuiltinModels("anthropic")[0]; // Catalog metadata, not a new workload limit.
  pi.registerProvider(id, { api: id, apiKey: "unused-offline", baseUrl: id,
    models: [{ id: "fixture", name: "Core evidence fixture", reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: template.contextWindow, maxTokens: template.maxTokens }], streamSimple: stream });
}
