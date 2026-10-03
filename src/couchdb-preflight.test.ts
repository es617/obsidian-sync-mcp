import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { databaseUrl, waitForDatabase, type DatabaseTarget } from "./couchdb-preflight.js";

const target: DatabaseTarget = { url: "http://couchdb:5984", database: "obsidian", username: "admin", password: "pw" };

/**
 * A fetch stub that answers with the given statuses in order (an Error entry is
 * thrown instead, like a network failure) and records each request.
 */
function stubFetch(statuses: (number | Error)[]) {
    const requests: { url: string; auth: string | undefined; signal: AbortSignal | null | undefined }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        requests.push({ url, auth: headers?.Authorization, signal: init?.signal });
        const status = statuses.shift();
        if (status === undefined) throw new Error("unexpected extra request");
        if (status instanceof Error) throw status;
        return new Response("{}", { status });
    }) as unknown as typeof fetch;
    return { fetchImpl, requests };
}

/** What Node's fetch throws when the connection is refused. */
function refused() {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5984"), { code: "ECONNREFUSED" });
    return new TypeError("fetch failed", { cause });
}

const noSleep = async () => {};

describe("databaseUrl", () => {
    it("joins base URL and database name", () => {
        assert.equal(databaseUrl("http://couchdb:5984", "obsidian"), "http://couchdb:5984/obsidian");
    });

    it("drops trailing slashes and keeps a path prefix", () => {
        assert.equal(databaseUrl("https://host/couch/", "obsidian"), "https://host/couch/obsidian");
    });

    it("strips credentials embedded in the URL", () => {
        assert.equal(databaseUrl("http://admin:pw@couchdb:5984", "obsidian"), "http://couchdb:5984/obsidian");
    });

    it("encodes the database name", () => {
        assert.equal(databaseUrl("http://couchdb:5984", "team/notes"), "http://couchdb:5984/team%2Fnotes");
    });
});

describe("waitForDatabase", () => {
    it("resolves immediately when the database exists, sending basic auth", async () => {
        const { fetchImpl, requests } = stubFetch([200]);
        await waitForDatabase(target, { fetchImpl, sleep: noSleep });
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, "http://couchdb:5984/obsidian");
        assert.equal(requests[0].auth, `Basic ${Buffer.from("admin:pw").toString("base64")}`);
    });

    it("waits through 404s without creating anything, then resolves", async () => {
        const { fetchImpl, requests } = stubFetch([404, 404, 200]);
        const logs: string[] = [];
        const sleeps: number[] = [];
        await waitForDatabase(target, {
            fetchImpl,
            sleep: async (ms) => { sleeps.push(ms); },
            retryMs: 10_000,
            log: (m) => logs.push(m),
        });
        assert.equal(requests.length, 3);
        assert.deepEqual(sleeps, [10_000, 10_000]);
        assert.equal(logs.length, 1, "logs on the first miss only");
        assert.ok(logs[0].includes('"obsidian" does not exist'));
    });

    it("logs about once a minute while waiting", async () => {
        const { fetchImpl } = stubFetch([...Array(13).fill(404), 200]);
        const logs: string[] = [];
        await waitForDatabase(target, { fetchImpl, sleep: noSleep, retryMs: 10_000, log: (m) => logs.push(m) });
        assert.equal(logs.length, 3); // attempts 0, 6 and 12
    });

    it("throws a credentials hint on 401 and 403", async () => {
        for (const status of [401, 403]) {
            const { fetchImpl } = stubFetch([status]);
            await assert.rejects(waitForDatabase(target, { fetchImpl, sleep: noSleep }), (err: Error) => {
                assert.ok(err.message.includes(`HTTP ${status}`));
                assert.ok(err.message.includes("COUCHDB_USER"));
                assert.ok(!err.message.includes("pw"), "never echoes the password");
                return true;
            });
        }
    });

    it("passes a timeout signal on every request", async () => {
        const { fetchImpl, requests } = stubFetch([200]);
        await waitForDatabase(target, { fetchImpl, sleep: noSleep });
        assert.ok(requests[0].signal instanceof AbortSignal);
    });

    it("retries while CouchDB is unreachable, logging the cause, then resolves", async () => {
        const { fetchImpl, requests } = stubFetch([refused(), refused(), 200]);
        const logs: string[] = [];
        await waitForDatabase(target, { fetchImpl, sleep: noSleep, log: (m) => logs.push(m) });
        assert.equal(requests.length, 3);
        assert.equal(logs.length, 1);
        assert.ok(logs[0].includes("Cannot reach CouchDB at http://couchdb:5984/obsidian"));
        assert.ok(logs[0].includes("connect ECONNREFUSED 127.0.0.1:5984"));
    });

    it("retries after a timeout and says so", async () => {
        const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
        const { fetchImpl } = stubFetch([timeout, 200]);
        const logs: string[] = [];
        await waitForDatabase(target, { fetchImpl, sleep: noSleep, log: (m) => logs.push(m) });
        assert.ok(logs[0].includes("no response (timed out)"));
    });

    it("names the URL, without credentials, in errors", async () => {
        const { fetchImpl } = stubFetch([403]);
        const withCreds = { ...target, url: "http://admin:pw@couchdb:5984" };
        await assert.rejects(waitForDatabase(withCreds, { fetchImpl, sleep: noSleep }), (err: Error) => {
            assert.ok(err.message.includes("CouchDB at http://couchdb:5984/obsidian"));
            assert.ok(!err.message.includes("pw@"));
            return true;
        });
    });

    it("throws on other errors", async () => {
        const { fetchImpl } = stubFetch([500]);
        await assert.rejects(waitForDatabase(target, { fetchImpl, sleep: noSleep }), /HTTP 500/);
    });
});
