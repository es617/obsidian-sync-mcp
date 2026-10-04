/**
 * Database existence check before the LiveSync library connects.
 *
 * PouchDB's HTTP adapter sends `PUT /<db>` when the database is missing, so
 * with admin credentials a typo in COUCHDB_DATABASE silently created a new,
 * empty database. This server never creates databases: a missing database,
 * an unreachable CouchDB or an authentication error fails startup with a
 * clear message.
 * Kept free of livesync-commonlib imports so it is unit-testable in isolation.
 */

export interface DatabaseTarget {
    url: string;
    database: string;
    username: string;
    password: string;
}

export interface CheckOptions {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

/**
 * Database URL with any userinfo removed (credentials go in the header, as PouchDB sends them).
 * The name goes into the path, so a query string in the base URL stays after it; a fragment is dropped.
 */
export function databaseUrl(url: string, database: string): string {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.hash = "";
    u.pathname = `${u.pathname.replace(/\/+$/, "")}/${encodeURIComponent(database)}`;
    return u.toString();
}

/** Short reason for a failed request: fetch() keeps the useful part (ECONNREFUSED, ...) in `cause`. */
function networkReason(err: unknown): string {
    if (err instanceof Error) {
        if (err.name === "TimeoutError") return "no response (timed out)";
        const cause = err.cause;
        if (cause instanceof Error) return cause.message || String((cause as NodeJS.ErrnoException).code ?? cause.name);
        return err.message;
    }
    return String(err);
}

/** Resolve if the database exists; throw a readable error otherwise. Never creates anything. */
export async function checkDatabase(target: DatabaseTarget, options: CheckOptions = {}): Promise<void> {
    const { fetchImpl = fetch, timeoutMs = 10_000 } = options;
    if (!target.database) {
        throw new Error("COUCHDB_DATABASE is empty. Set it to the name of your LiveSync database.");
    }
    const url = databaseUrl(target.url, target.database);
    const token = Buffer.from(`${target.username}:${target.password}`).toString("base64");
    const headers = { Accept: "application/json", Authorization: `Basic ${token}` };

    let res: Response;
    try {
        res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        throw new Error(`Cannot reach CouchDB at ${url}: ${networkReason(err)}.`);
    }
    await res.body?.cancel();
    if (res.ok) return;
    if (res.status === 404) {
        throw new Error(
            `CouchDB database "${target.database}" does not exist at ${url}. ` +
            `This server never creates databases; check COUCHDB_DATABASE.`,
        );
    }
    if (res.status === 401 || res.status === 403) {
        throw new Error(
            `CouchDB at ${url} refused access to database "${target.database}" (HTTP ${res.status}). ` +
            `Check COUCHDB_USER and COUCHDB_PASSWORD, and that the user is a member of the database.`,
        );
    }
    throw new Error(`CouchDB at ${url} returned HTTP ${res.status} for database "${target.database}".`);
}
