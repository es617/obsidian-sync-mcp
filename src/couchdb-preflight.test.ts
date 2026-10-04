import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { databaseUrl, checkDatabase, type DatabaseTarget } from "./couchdb-preflight.js";

const target: DatabaseTarget = { url: "http://couchdb:5984", database: "obsidian", username: "admin", password: "pw" };

/**
 * A fetch stub that answers with the given status (an Error is thrown instead,
 * like a network failure) and records each request.
 */
function stubFetch(status: number | Error) {
    const requests: { url: string; method: string | undefined; auth: string | undefined; signal: AbortSignal | null | undefined }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        requests.push({ url, method: init?.method, auth: headers?.Authorization, signal: init?.signal });
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

    it("puts the name in the path, before a query string, and drops a fragment", () => {
        assert.equal(databaseUrl("http://couchdb:5984/?x=1", "obsidian"), "http://couchdb:5984/obsidian?x=1");
        assert.equal(databaseUrl("http://couchdb:5984/couch#frag", "obsidian"), "http://couchdb:5984/couch/obsidian");
    });
});

describe("checkDatabase", () => {
    it("resolves when the database exists, with one GET carrying basic auth", async () => {
        const { fetchImpl, requests } = stubFetch(200);
        await checkDatabase(target, { fetchImpl });
        assert.equal(requests.length, 1);
        assert.equal(requests[0].method, undefined, "GET, never PUT");
        assert.equal(requests[0].url, "http://couchdb:5984/obsidian");
        assert.equal(requests[0].auth, `Basic ${Buffer.from("admin:pw").toString("base64")}`);
        assert.ok(requests[0].signal instanceof AbortSignal, "has a timeout");
    });

    it("fails fast when the database does not exist, without creating it", async () => {
        const { fetchImpl, requests } = stubFetch(404);
        await assert.rejects(checkDatabase(target, { fetchImpl }), (err: Error) => {
            assert.ok(err.message.includes('"obsidian" does not exist'));
            assert.ok(err.message.includes("never creates databases"));
            assert.ok(err.message.includes("COUCHDB_DATABASE"));
            return true;
        });
        assert.equal(requests.length, 1);
    });

    it("rejects an empty database name without a request", async () => {
        const { fetchImpl, requests } = stubFetch(200);
        await assert.rejects(checkDatabase({ ...target, database: "" }, { fetchImpl }), /COUCHDB_DATABASE is empty/);
        assert.equal(requests.length, 0);
    });

    it("throws a credentials hint on 401 and 403", async () => {
        for (const status of [401, 403]) {
            const { fetchImpl } = stubFetch(status);
            await assert.rejects(checkDatabase(target, { fetchImpl }), (err: Error) => {
                assert.ok(err.message.includes(`HTTP ${status}`));
                assert.ok(err.message.includes("COUCHDB_USER"));
                assert.ok(!err.message.includes("pw"), "never echoes the password");
                return true;
            });
        }
    });

    it("fails fast when CouchDB is unreachable, naming the cause", async () => {
        const { fetchImpl } = stubFetch(refused());
        await assert.rejects(checkDatabase(target, { fetchImpl }), (err: Error) => {
            assert.ok(err.message.includes("Cannot reach CouchDB at http://couchdb:5984/obsidian"));
            assert.ok(err.message.includes("connect ECONNREFUSED 127.0.0.1:5984"));
            return true;
        });
    });

    it("says so when CouchDB does not answer in time", async () => {
        const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
        const { fetchImpl } = stubFetch(timeout);
        await assert.rejects(checkDatabase(target, { fetchImpl }), /no response \(timed out\)/);
    });

    it("names the URL, without credentials, in errors", async () => {
        const { fetchImpl } = stubFetch(403);
        const withCreds = { ...target, url: "http://admin:pw@couchdb:5984" };
        await assert.rejects(checkDatabase(withCreds, { fetchImpl }), (err: Error) => {
            assert.ok(err.message.includes("CouchDB at http://couchdb:5984/obsidian"));
            assert.ok(!err.message.includes("pw@"));
            return true;
        });
    });

    it("throws on other errors", async () => {
        const { fetchImpl } = stubFetch(500);
        await assert.rejects(checkDatabase(target, { fetchImpl }), /HTTP 500/);
    });
});
