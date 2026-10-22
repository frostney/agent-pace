import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

const LOCK_EX = 2;

type Flock = (fd: number, operation: number) => number;

let flock: Flock | null | undefined;

/**
 * flock(2) from the C library, the lock Python's fcntl.flock takes, so a watcher of either
 * version waits for the other. Null where the library cannot be loaded: readings then go
 * unlocked, which costs at most a duplicate request.
 */
function loadFlock(): Flock | null {
  if (flock !== undefined) {
    return flock;
  }
  // glibc, then musl, by the names their loaders know
  const libraries =
    process.platform === "darwin"
      ? ["libc.dylib"]
      : ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`, "libc.so"];
  flock = null;
  for (const library of libraries) {
    try {
      const { symbols } = dlopen(library, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      flock = (fd, operation) => symbols.flock(fd, operation);
      break;
    } catch {
      // the next name
    }
  }
  return flock;
}

/**
 * Runs `body` holding an exclusive lock on `path` (created, and truncated, as Python's
 * `open(path, "w")` did). Closing the file releases the lock.
 */
export async function withLock<T>(path: string, body: () => Promise<T> | T): Promise<T> {
  const fd = openSync(path, "w");
  try {
    loadFlock()?.(fd, LOCK_EX);
    return await body();
  } finally {
    closeSync(fd);
  }
}
