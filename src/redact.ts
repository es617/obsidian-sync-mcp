/**
 * Log redaction helpers.
 *
 * COUCHDB_URL may embed credentials as `user:pass@host`. Anything written to
 * the log goes through these so the password never lands in container logs.
 * Kept dependency-free so it is unit-testable in isolation.
 */

/** Replace the userinfo part of every URL in `text` (e.g. `http://u:p@h` -> `http://***@h`). */
export function redactCredentials(text: string): string {
    // Greedy up to the last "@" before the path, as URL parsers split userinfo,
    // so an unencoded "@" in the password is still fully covered.
    return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, "$1***@");
}

/**
 * One-line description of an error for logs: the message only, redacted.
 * With `verbose` (LOG_LEVEL=debug) the stack is kept, still redacted.
 * The cause chain is appended: fetch() reports "fetch failed" and keeps the
 * useful part (ECONNREFUSED, ENOTFOUND, ...) in `cause`.
 */
export function describeError(err: unknown, verbose = false): string {
    if (!(err instanceof Error)) return redactCredentials(String(err));
    let text = verbose && err.stack ? err.stack : `${err.name}: ${err.message}`;
    const causes: string[] = [];
    let cause: unknown = err.cause;
    for (let depth = 0; cause !== undefined && cause !== null && depth < 3; depth++) {
        if (cause instanceof Error) {
            causes.push(cause.message || String((cause as NodeJS.ErrnoException).code ?? cause.name));
            cause = cause.cause;
        } else {
            causes.push(String(cause));
            break;
        }
    }
    if (causes.length > 0) text += ` (cause: ${causes.join(" <- ")})`;
    return redactCredentials(text);
}
