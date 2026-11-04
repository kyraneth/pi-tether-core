/** Instance-owned private runtime directories. */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Owner-only permissions for every file staged inside the runtime directory. */
export const RUNTIME_FILE_MODE = 0o600;

export const HANDOFF_SOCKET_NAME = "handoff.sock";

export function createRuntimeDirectory(prefix: string) {
let dir: string | undefined;

function privateDir(base: string): string {
  const path = mkdtempSync(join(base, prefix));
  // mkdtemp applies the inherited umask, which can remove owner search access.
  chmodSync(path, 0o700);
  return path;
}

function socketFits(base: string): boolean {
  // sockaddr_un.sun_path is 108 bytes on Linux (unix(7)) and 104 on macOS
  // (XNU bsd/sys/un.h). Leave one byte for NUL; count UTF-8 bytes, not JS chars.
  // https://man7.org/linux/man-pages/man7/unix.7.html
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h
  const sunPathBytes = process.platform === "darwin" ? 104 : 108;
  // Node mkdtemp appends six random characters to the prefix.
  return (
    Buffer.byteLength(join(base, `${prefix}XXXXXX`, HANDOFF_SOCKET_NAME)) <
    sunPathBytes
  );
}

/** The private directory for this process, created on first use (mode 0700). */
function runtimeDir(): string {
  if (!dir) {
    const base = tmpdir();
    if (process.platform === "win32" || socketFits(base))
      dir = privateDir(base);
    else {
      const xdg = process.env.XDG_RUNTIME_DIR;
      if (xdg && socketFits(xdg)) {
        // Atomic creation proves writability (including search permission),
        // unlike an access check followed by a separate creation. A stale,
        // missing or unwritable XDG base must not disable tool handoffs.
        try {
          dir = privateDir(xdg);
        } catch {
          /* fall back to /tmp */
        }
      }
      dir ??= privateDir("/tmp");
    }
  }
  return dir;
}

/** The cached directory, without allocating during shutdown cleanup. */
function existingRuntimeDir(): string | undefined {
  return dir;
}

/** Path to `name` inside the private directory. */
function runtimeFile(name: string): string {
  return join(runtimeDir(), name);
}

/**
 * Remove the directory and everything in it. Registered on `process.on("exit")`,
 * so it must stay synchronous. A SIGKILLed process still leaks the directory —
 * but it leaks a `0700` directory no other user can open.
 */
function cleanupRuntimeDir(): void {
  if (!dir) return;
  const path = dir;
  dir = undefined;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* already gone, or not ours to remove */
  }
}

/** Test seam: forget the current directory without removing it. */
function resetRuntimeDirForTests(): void {
  dir = undefined;
}

return { runtimeDir, existingRuntimeDir, runtimeFile, cleanupRuntimeDir, resetRuntimeDirForTests };
}
