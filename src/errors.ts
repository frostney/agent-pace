/** Ends the command, as Python's sys.exit: a message goes to stderr with status 1. */
export class ExitError extends Error {
  readonly status: number;

  constructor(messageOrStatus: string | number) {
    super(typeof messageOrStatus === "string" ? messageOrStatus : "");
    this.status = typeof messageOrStatus === "number" ? messageOrStatus : 1;
  }
}

/** The usage endpoint asked us to slow down. */
export class RateLimited extends Error {
  constructor(readonly retryAfter: string | null) {
    super("the usage endpoint is rate limiting");
  }
}

/**
 * A failed network read, in urllib's frames ("<urlopen error ...>", "HTTP Error 500: ...",
 * "timed out"). Inside a frame, a refused connection and an unknown host read as Python's did;
 * other failures carry Bun's own message.
 */
export class NetworkError extends Error {}

/** A file or process the operating system refused, worded as Python's OSError. */
export class OsError extends Error {}

/** Node's system error, as `[Errno 2] No such file or directory: '/path'`. */
function systemErrorText(error: NodeJS.ErrnoException): string {
  const described = /^[A-Z0-9_]+: (.*?)(?:, \w+(?: '.*')?)?$/.exec(error.message)?.[1];
  const reason = described ? described[0]?.toUpperCase() + described.slice(1) : error.message;
  const errno = typeof error.errno === "number" ? ` ${Math.abs(error.errno)}` : "";
  const path = error.path === undefined ? "" : `: '${error.path}'`;
  return `[Errno${errno}] ${reason}${path}`;
}

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/**
 * The text Python printed for the errors a reading survives (network failures and OSError),
 * or null for anything else, which ends the command as it did in Python.
 */
export function survivableErrorText(error: unknown): string | null {
  if (error instanceof NetworkError || error instanceof OsError) {
    return error.message;
  }
  if (isSystemError(error)) {
    return systemErrorText(error);
  }
  return null;
}
