# Technical details

Small, instance-owned building blocks for **Pi tethers**: adapters that connect Pi to an official coding client's session. The adapter owns client startup, authentication and vendor policy. This library supplies shared request, transport and lifecycle primitives; it does not connect to a model by itself.

## Install and develop

Requires Node.js 22.12+ (22.x) or 24+, matching the standalone test toolchain's supported Node versions. Source modules are TypeScript, intended for Pi's TypeScript loader or a compatible loader/bundler; this is not a compiled JavaScript distribution.

From a checkout:

```sh
npm ci
npm test
npm run --silent export-manifest > /tmp/tether-export.json
node scripts/public-tree.mjs /tmp/tether-export.json
npm pack --dry-run --json
```

Adapters depend on `pi-tether-core` and import its named subpaths. Pi supplies `@earendil-works/pi-ai` at runtime; it is a peer dependency, not bundled. A standalone checkout installs the tested peer version as a development dependency. No sibling repository or workspace is required.

This package advertises `pi-package` metadata but declares **no extensions**. Installing it into Pi alone registers no provider or tool. Use an engine adapter for that.

## Start with pure helpers

```ts
import { requestSignature, projectionHash, matchesPrefix } from "pi-tether-core/request";
import { selectSystemPrompt } from "pi-tether-core/system-prompt";

const signature = requestSignature(["model-name", { temperature: 0 }]);
const messages = [{ role: "user", content: "Hello" }];
const checkpoint = { length: messages.length, hash: projectionHash(messages) };
const unchanged = matchesPrefix(messages, checkpoint, projectionHash);

const prompt = selectSystemPrompt(
  { promptModes: ["replace"], instructionMechanisms: ["client-config"] },
  "replace",
  "Follow these exact instructions.\n",
  "client-config",
);
```

Request hashes describe serialized input, not semantic equivalence. The system-prompt gate preserves exact instruction bytes and refuses unsupported modes or mechanisms; it never silently substitutes append for replace. An adapter must qualify its capabilities against the actual client version **before submission**.

## MCP bridge: declarations out, journaled results back

The Model Context Protocol (MCP) lets a client discover tools and request calls. This bridge advertises only the ordered tool declarations you pass in. It does not discover ambient servers or execute tools. Each bridge owns its sockets, authentication and receipt state.

```ts
import { createMcpBridge } from "pi-tether-core/mcp/bridge";

const bridge = createMcpBridge({
  sessionId: "session-example",
  generation: "binding-generation",
  tools: [{
    name: "lookup",
    description: "Look up a record",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  }],
  onInvocation(invocation) {
    // Surface invocation as a normal Pi toolCall. Do not execute it here.
    // Retain its full identity for delivery after Pi's journal commits.
  },
});

try {
  const descriptor = await bridge.start();
  // Pass descriptor.command, args and env to the official client's MCP config.
  // Keep the bridge alive for that binding's lifetime.
} finally {
  await bridge.retire();
}
```

After Pi has run its normal guards, tool execution and result transforms, **and committed the result to its native journal**, the adapter calls:

```ts
bridge.journalResult({
  ...invocation, // the exact identity received in onInvocation
  journalEntryId: committedEntry.id,
  result: committedResult, // { content: [...], isError?: boolean }
});
```

This second snippet belongs inside the adapter's journal-commit handler; the application supplies those three variables. `journalResult` is a trusted adapter boundary, not an independent journal reader. A nonempty entry ID alone cannot prove that a journal write happened.

Authentication, generation, declaration hash and invocation identity are checked before surfacing a call. By default, arguments that violate the schema or need coercion are rejected rather than rewritten. Qualified adapters can set `argumentValidation: "pi"`: object arguments then reach Pi unchanged, Pi owns validation/coercion, and the adapter delivers Pi's journaled validation error or execution result through the same receipt path. Tool identity, exact original arguments and result verification remain mandatory in either mode. Parallel calls with identical arguments remain distinct. MCP metadata stays opaque; vendor IDs are for the adapter to interpret.

Receipts progress through `requested`, `surfaced_to_pi`, `result_journaled` and `response_sent`. Sending socket bytes is **not** proof that a client accepted or consumed the content. Only call `markHostAccepted` or `verifyContent` when the adapter has corresponding evidence. Mismatches and uncertain interrupted calls fence the binding; there is no automatic replay. Detach preserves pending requests; it is not cancellation. Always retire the bridge when its binding ends.

Private runtime directories use mode 0700; config, authentication file and socket use 0600. The child command line carries a config path, not authentication bytes. The MCP transport uses Unix-domain sockets and is tested on Linux; Windows support and live vendor compatibility are not claimed.

## Module map

| Subpath | Responsibility |
| --- | --- |
| `request` | Request signatures, projection hashes and prefix checks |
| `system-prompt` | Explicit prompt-mode capability selection |
| `mcp/bridge` | Declaration-only MCP child/broker and delivery receipts |
| `runtime` | Private per-instance runtime directories and cleanup |
| `security` | Constant-time local authentication comparison |
| `socket-transport` | Single-invocation newline transport |
| `lifecycle` | Revision fence for asynchronous lifecycle work |
| `metadata-ledger` | Append-only diagnostic metadata, never session authority |
| `pi-context` | Pi legacy/transcript message conversion using the host's context APIs |
| `pi-stream` | Error/abort stream completion |
| `register` | Pi API dispatch registration |

The packaged `src/mcp/server.cjs` is a child entry point, not an extension and not a public import subpath. Importing modules launches no client and creates no bridge until you ask for one.

## Verification and distribution boundary

`npm test` runs standalone tests, including the real stdio child → private socket → bridge roundtrip, negative authentication/schema/identity cases, cancellation fencing and prompt-mode checks. The journal callback is a fixture: these tests do not establish a real Pi journal commit, vendor acceptance, subscription permissions, performance or cache equivalence.

`node scripts/export-manifest.mjs` lists explicitly allowed public files from Git's index, with exact byte sizes and SHA-256 hashes. Stage changes before generating it. `node scripts/public-tree.mjs manifest.json` verifies and scans those exact bytes (including filenames), refusing changed, missing or additional manifest entries. It reports only file and rule identifiers, never matched content. This is a review aid, not a guarantee that arbitrary sensitive material can be detected.

The public source export includes source, tests and release-check scripts. The npm `files` allowlist is narrower: source, README, technical details, diagram assets and MIT license (plus npm's mandatory package metadata). Tests, development scripts and private history are not shipped in the npm archive. Release preparation must also scan the actual packed bytes and compare its paths to the allowlist; a successful dry run alone is not a release approval.

## License

[MIT](LICENSE).
