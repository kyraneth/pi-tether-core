import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, writeFileSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createRuntimeDirectory } from "../runtime.js";
import { secretMatches } from "../security.js";
import { acceptInvocation } from "../socket-transport.js";
import { projectionHash } from "../request.js";

export interface BridgeTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface InvocationIdentity { sessionId: string; generation: string; connectionId: string; requestId: string | number }
export interface BridgeInvocation {
  piCallId: string;
  identity: InvocationIdentity;
  name: string;
  arguments: Record<string, unknown>;
  /** Opaque MCP metadata. Vendor-id interpretation belongs to the adapter. */
  metadata?: unknown;
}
export interface BridgeResult { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean }
export type ReceiptState = "requested" | "surfaced_to_pi" | "result_journaled" | "response_sent" | "host_accepted" | "content_verified" | "unknown" | "mismatch";
export interface BridgeReceipt extends BridgeInvocation { states: ReceiptState[]; resultHash?: string; journalEntryId?: string; isError?: boolean }
export interface JournaledBridgeResult extends BridgeInvocation { journalEntryId: string; result: BridgeResult }
export interface BridgeOptions {
  sessionId: string;
  generation: string;
  tools: BridgeTool[];
  /** Surface a normal Pi toolCall only. No executor is accepted by this API. */
  onInvocation: (invocation: BridgeInvocation) => void;
}
const errorResult = (text: string): BridgeResult => ({ content: [{ type: "text", text }], isError: true });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const key = (id: InvocationIdentity) => canonical(id);
const clone = <T>(value: T): T => structuredClone(value);
function resultValid(r: BridgeResult): boolean {
  return !!r && Array.isArray(r.content) && (r.isError === undefined || typeof r.isError === "boolean") && r.content.every(b =>
    b && ((b.type === "text" && typeof b.text === "string") || (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string")));
}

/** Instance-owned blocked-call broker. Loading the module starts nothing. */
export function createMcpBridge(options: BridgeOptions) {
  if (!options.sessionId || !options.generation || typeof options.onInvocation !== "function") throw new Error("Bridge owner is required");
  const sessionId = options.sessionId, generation = options.generation;
  const tools = clone(options.tools);
  const declared = new Map(tools.map(t => [t.name, t]));
  if (declared.size !== tools.length || tools.some(t => !t.name || !t.inputSchema || typeof t.inputSchema !== "object" || Array.isArray(t.inputSchema))) throw new Error("Invalid tool declarations");
  const schemaHash = projectionHash(tools);
  const runtime = createRuntimeDirectory("pi-tether-");
  const secret = randomBytes(32).toString("hex"); // 256-bit local authentication token, not a workload budget.
  const records = new Map<string, { receipt: BridgeReceipt; socket: Socket; finish: (r: BridgeResult) => void }>();
  const byPi = new Map<string, string>();
  const sockets = new Set<Socket>();
  let server: Server | undefined, starting: Promise<Descriptor> | undefined;
  let attached = true, retired = false, fenced = false;
  type Descriptor = { command: string; args: string[]; env: Record<string, string> };
  let descriptor: Descriptor | undefined;

  function match(inv: BridgeInvocation) {
    const r = records.get(key(inv.identity));
    if (!r || byPi.get(inv.piCallId) !== key(inv.identity) || r.receipt.piCallId !== inv.piCallId || r.receipt.name !== inv.name || canonical(r.receipt.arguments) !== canonical(inv.arguments)) throw new Error("Pending invocation identity mismatch");
    return r;
  }
  function handle(socket: Socket) {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      for (const r of records.values()) if (r.socket === socket && !r.receipt.states.includes("response_sent") && !r.receipt.states.includes("unknown")) { r.receipt.states.push("unknown"); fenced = true; }
    });
    acceptInvocation<BridgeResult>(socket, (line, finish) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { finish(errorResult("Malformed invocation")); return; }
      if (!secretMatches(secret, msg?.secret)) { finish(errorResult("Unauthorized invocation")); return; }
      if (retired || fenced || !attached || msg.sessionId !== sessionId || msg.generation !== generation) { finish(errorResult("Detached or stale bridge owner")); return; }
      if (msg.type !== "call" || msg.schemaHash !== schemaHash || typeof msg.connectionId !== "string" || !msg.connectionId || !((typeof msg.requestId === "string") || (typeof msg.requestId === "number" && Number.isFinite(msg.requestId)))) { finish(errorResult("Invalid invocation identity or schema")); return; }
      const tool = declared.get(msg.name);
      if (!tool || !msg.arguments || typeof msg.arguments !== "object" || Array.isArray(msg.arguments)) { finish(errorResult("Undeclared tool or invalid arguments")); return; }
      try {
        // Use Pi's authoritative validator, but reject coercion: the effective schema
        // and the model's actual arguments are immutable bridge inputs.
        const checked = validateToolArguments({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema } as any, { type: "toolCall", id: "validation", name: tool.name, arguments: msg.arguments });
        if (canonical(checked) !== canonical(msg.arguments)) throw new Error("Coercion not permitted");
      } catch { finish(errorResult("Tool arguments do not match declared schema")); return; }
      const identity: InvocationIdentity = { sessionId, generation, connectionId: msg.connectionId, requestId: msg.requestId };
      if (records.has(key(identity))) { finish(errorResult("Duplicate invocation identity")); return; }
      const inv: BridgeInvocation = { identity, piCallId: randomUUID(), name: tool.name, arguments: clone(msg.arguments), metadata: clone(msg.metadata) };
      const receipt: BridgeReceipt = { ...clone(inv), states: ["requested", "surfaced_to_pi"] };
      records.set(key(identity), { receipt, socket, finish });
      byPi.set(inv.piCallId, key(identity));
      try { options.onInvocation(clone(inv)); }
      catch { fenced = true; receipt.states.push("unknown"); finish(errorResult("Pi failed to surface invocation; outcome unknown")); }
    });
  }
  async function start(): Promise<Descriptor> {
    if (retired) throw new Error("Bridge retired");
    if (descriptor) return clone(descriptor);
    if (starting) return clone(await starting);
    starting = (async () => {
      const socketPath = runtime.runtimeFile("handoff.sock");
      const secretPath = runtime.runtimeFile("bridge.secret");
      const configPath = runtime.runtimeFile("bridge.json");
      const config = { socketPath, secretPath, sessionId, generation, tools, schemaHash };
      for (const [path, body] of [[secretPath, secret], [configPath, JSON.stringify(config)]]) {
        writeFileSync(path, body, { mode: 0o600, flag: "wx" });
        chmodSync(path, 0o600);
      }
      const srv = createServer(handle);
      server = srv;
      await new Promise<void>((resolve, reject) => { srv.once("error", reject); srv.listen(socketPath, () => { srv.removeListener("error", reject); resolve(); }); });
      chmodSync(socketPath, 0o600);
      srv.unref();
      if (retired) { await new Promise<void>(resolve => srv.close(() => resolve())); runtime.cleanupRuntimeDir(); throw new Error("Bridge retired during start"); }
      descriptor = { command: process.execPath, args: [fileURLToPath(new URL("./server.cjs", import.meta.url)), configPath], env: {} };
      return descriptor;
    })();
    try { return clone(await starting); } catch (e) { await retire(); throw e; }
  }
  function journalResult(input: JournaledBridgeResult): void {
    if (retired || fenced || !attached) throw new Error("Bridge not attached");
    const r = match(input);
    if (r.receipt.states.at(-1) !== "surfaced_to_pi" || !input.journalEntryId || !resultValid(input.result)) throw new Error("Invalid journaled result or settled invocation");
    const result = clone(input.result);
    r.receipt.journalEntryId = input.journalEntryId;
    r.receipt.resultHash = projectionHash(canonical(result));
    r.receipt.isError = result.isError === true;
    r.receipt.states.push("result_journaled");
    // Queued socket bytes are transport-only, never a host consumption receipt.
    r.socket.write(JSON.stringify({ type: "result", ...result }) + "\n", err => {
      if (err) { fenced = true; r.receipt.states.push("unknown"); return; }
      r.receipt.states.push("response_sent");
      r.socket.end();
    });
  }
  function markHostAccepted(inv: BridgeInvocation): void {
    const r = match(inv);
    if (retired || fenced || r.receipt.states.at(-1) !== "response_sent") throw new Error("No sent response to accept");
    r.receipt.states.push("host_accepted");
  }
  function verifyContent(inv: BridgeInvocation, observed: BridgeResult): boolean {
    const r = match(inv);
    if (retired || fenced || !["response_sent", "host_accepted"].includes(r.receipt.states.at(-1)!)) throw new Error("No sent response to verify");
    const equal = resultValid(observed) && projectionHash(canonical(observed)) === r.receipt.resultHash;
    r.receipt.states.push(equal ? "content_verified" : "mismatch");
    if (!equal) { fenced = true; attached = false; for (const socket of sockets) socket.destroy(); }
    return equal;
  }
  async function retire(): Promise<void> {
    retired = true; attached = false;
    for (const r of records.values()) if (!["content_verified", "mismatch", "unknown"].includes(r.receipt.states.at(-1)!)) r.receipt.states.push("unknown");
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    runtime.cleanupRuntimeDir();
  }
  return { start, journalResult, markHostAccepted, verifyContent, retire,
    setAttached(value: boolean) { if (retired || fenced) throw new Error("Bridge retired or fenced"); attached = value; },
    receipts: (): BridgeReceipt[] => clone([...records.values()].map(r => r.receipt)),
  };
}
