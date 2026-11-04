import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
/** Ordered best-effort writer, no request awaits I/O, no body projection here.
 * Drivers own an allowlisted metadata projection before calling append.
 * Compatible with Claude's writer contract; Claude's behavior stays unchanged.
 */
export function metadataLedger(path: string) {
  let pending = Promise.resolve();
  return {
    append(row: Record<string, unknown>) {
      const line =
        JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n";
      pending = pending
        .then(async () => {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const f = await open(
            path,
            constants.O_WRONLY |
              constants.O_APPEND |
              constants.O_CREAT |
              constants.O_NONBLOCK,
            0o600,
          );
          try {
            await f.chmod(0o600);
            await f.write(line);
          } finally {
            await f.close();
          }
        })
        .catch(() => {});
    },
    flush: () => pending,
  };
}
