import type { Socket } from "node:net";

/** One newline-framed invocation per connection; reply once, or remain pending. */
export function acceptInvocation<Result>(socket: Socket, invoke: (line: string, finish: (result: Result) => void) => void): void {
  let buffer = "";
  let handled = false;
  let requested = false;
  const finish = (result: Result) => {
    if (handled) return;
    handled = true;
    try { socket.end(JSON.stringify({ type: "result", ...result }) + "\n"); } catch { /* peer gone */ }
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    if (handled || requested) return;
    buffer += chunk;
    const nl = buffer.indexOf("\n");
    if (nl === -1) return;
    const line = buffer.slice(0, nl);
    buffer = "";
    requested = true;
    invoke(line, finish);
  });
  socket.on("error", () => { handled = true; });
}
