/**
 * Database existence check before the LiveSync library connects.
 *
 * PouchDB's HTTP adapter sends `PUT /<db>` when the database is missing, so
 * with admin credentials a typo in COUCHDB_DATABASE silently created a new,
 * empty database. This server never creates databases: it waits for the
 * database to appear (a fresh docker-compose setup has LiveSync create it on
 * first sync) and fails clearly on authentication errors.
 * Kept free of livesync-commonlib imports so it is unit-testable in isolation.
 */

export interface DatabaseTarget {
    url: string;
    database: string;
    username: string;
    password: string;
}

export interface WaitOptions {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    retryMs?: number;
    log?: (message: string) => void;
}

/** Database URL with any userinfo removed (credentials go in the header, as PouchDB sends them). */
export function databaseUrl(url: string, database: string): string {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return `${u.toString().replace(/\/+$/, "")}/${encodeURIComponent(database)}`;
}

/** Resolve once the database exists. Waits on 404; throws on any other non-2xx status. */
export async function waitForDatabase(target: DatabaseTarget, options: WaitOptions = {}): Promise<void> {
    const {
        fetchImpl = fetch,
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        retryMs = 10_000,
        log = console.warn,
    } = options;
    const url = databaseUrl(target.url, target.database);
    const token = Buffer.from(`${target.username}:${target.password}`).toString("base64");
    const headers = { Accept: "application/json", Authorization: `Basic ${token}` };

    for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(url, { headers });
        await res.body?.cancel();
        if (res.ok) return;
        if (res.status === 404) {
            // Log on the first miss, then about once a minute.
            if (attempt % Math.max(1, Math.round(60_000 / retryMs)) === 0) {
                log(
                    `CouchDB database "${target.database}" does not exist. Waiting for it to be created ` +
                    `(LiveSync creates it on first sync). If the name is wrong, fix COUCHDB_DATABASE. ` +
                    `This server never creates databases.`,
                );
            }
            await sleep(retryMs);
            continue;
        }
        if (res.status === 401 || res.status === 403) {
            throw new Error(
                `CouchDB refused access to database "${target.database}" (HTTP ${res.status}). ` +
                `Check COUCHDB_USER and COUCHDB_PASSWORD, and that the user is a member of the database.`,
            );
        }
        throw new Error(`CouchDB returned HTTP ${res.status} for database "${target.database}".`);
    }
}
