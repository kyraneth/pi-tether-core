#!/usr/bin/env node
"use strict";
// Schema-only MCP endpoint. No tool executors, vendor metadata parsing, retries,
// ambient MCP discovery or deadlines. One private broker is its only destination.
const fs = require("node:fs");
const net = require("node:net");
const readline = require("node:readline");
const { randomUUID, createHash } = require("node:crypto");
let config, secret;
try {
  config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  secret = fs.readFileSync(config.secretPath, "utf8");
  if (!Array.isArray(config.tools) || !config.socketPath || !secret || createHash("sha256").update(JSON.stringify(config.tools)).digest("hex") !== config.schemaHash) throw new Error();
} catch { process.exit(1); }
const connectionId = randomUUID();
const pending = new Map();
const seen = new Set();
const errorResult = text => ({ content: [{ type: "text", text }], isError: true });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
function proxy(msg) {
  const id = msg.id;
  const idKey = JSON.stringify(id);
  if (seen.has(idKey)) { send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Duplicate request id" } }); return; }
  seen.add(idKey);
  const params = msg.params || {};
  const socket = net.connect(config.socketPath);
  pending.set(idKey, socket);
  let settled = false, buffer = "";
  const finish = result => {
    if (settled) return;
    settled = true;
    pending.delete(idKey);
    send({ jsonrpc: "2.0", id, result });
    socket.destroy();
  };
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(JSON.stringify({
    type: "call", sessionId: config.sessionId, generation: config.generation,
    schemaHash: config.schemaHash, secret, connectionId, requestId: id,
    name: params.name, arguments: params.arguments === undefined ? {} : params.arguments,
    metadata: params._meta,
  }) + "\n"));
  socket.on("data", chunk => {
    buffer += chunk;
    const nl = buffer.indexOf("\n");
    if (nl < 0) return;
    try {
      const response = JSON.parse(buffer.slice(0, nl));
      if (response.type !== "result" || !Array.isArray(response.content)) throw new Error();
      const { type, ...result } = response;
      finish(result);
    } catch { finish(errorResult("Malformed broker response")); }
  });
  socket.on("error", () => finish(errorResult("Pi bridge unavailable; outcome unknown")));
  socket.on("close", () => finish(errorResult("Pi bridge closed; outcome unknown")));
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  let msg;
  try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
  if (!msg || msg.jsonrpc !== "2.0") { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }); return; }
  if (msg.method === "notifications/cancelled") {
    pending.get(JSON.stringify(msg.params?.requestId))?.destroy();
    return;
  }
  if (msg.id === undefined) return;
  if (!(typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id)))) { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid id" } }); return; }
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "pi-tether-tools", version: "0.1.0" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: config.tools } });
  else if (msg.method === "tools/call") proxy(msg);
  else if (msg.method === "ping") send({ jsonrpc: "2.0", id: msg.id, result: {} });
  else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported" } });
});
rl.on("close", () => { for (const socket of pending.values()) socket.destroy(); });
