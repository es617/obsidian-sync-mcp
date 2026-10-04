import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactCredentials, describeError, describeLogMessage } from "./redact.js";

describe("redactCredentials", () => {
    it("removes user and password from a URL", () => {
        assert.equal(redactCredentials("http://admin:s3cret@couchdb:5984"), "http://***@couchdb:5984");
    });

    it("removes a username-only userinfo", () => {
        assert.equal(redactCredentials("https://admin@db.example.com/obsidian"), "https://***@db.example.com/obsidian");
    });

    it("redacts every URL inside a longer message", () => {
        const msg = "request to http://a:b@h1/db failed, retry https://c:d@h2/db";
        assert.equal(redactCredentials(msg), "request to http://***@h1/db failed, retry https://***@h2/db");
    });

    it("handles passwords containing reserved characters", () => {
        assert.equal(redactCredentials("http://admin:p%40ss:w0rd@host:5984/"), "http://***@host:5984/");
    });

    it("redacts up to the last @ when the password contains a raw @", () => {
        assert.equal(redactCredentials("http://admin:p@ss@host:5984"), "http://***@host:5984");
    });

    it("leaves URLs without credentials untouched", () => {
        assert.equal(redactCredentials("http://couchdb:5984/obsidian"), "http://couchdb:5984/obsidian");
    });

    it("does not treat an @ in the path or query as userinfo", () => {
        assert.equal(redactCredentials("http://host/notes/a@b.md"), "http://host/notes/a@b.md");
        assert.equal(redactCredentials("http://host/?q=a@b"), "http://host/?q=a@b");
    });
});

describe("describeError", () => {
    it("returns name and message, redacted", () => {
        const err = new Error("request to http://u:p@h/db failed");
        assert.equal(describeError(err), "Error: request to http://***@h/db failed");
    });

    it("keeps the stack only when verbose", () => {
        const err = new Error("boom");
        assert.ok(!describeError(err).includes("\n"));
        assert.ok(describeError(err, true).includes("at "));
    });

    it("appends the cause, as fetch() reports it", () => {
        const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5984"), { code: "ECONNREFUSED" });
        const err = new TypeError("fetch failed", { cause });
        assert.equal(describeError(err), "TypeError: fetch failed (cause: connect ECONNREFUSED 127.0.0.1:5984)");
    });

    it("follows a nested cause chain and redacts it", () => {
        const inner = new Error("getaddrinfo ENOTFOUND http://u:p@db");
        const err = new Error("outer", { cause: new Error("middle", { cause: inner }) });
        assert.equal(describeError(err), "Error: outer (cause: middle <- getaddrinfo ENOTFOUND http://***@db)");
    });

    it("uses the code when a cause has no message, and stringifies non-Error causes", () => {
        const noMessage = Object.assign(new Error(""), { code: "ETIMEDOUT" });
        assert.equal(describeError(new Error("x", { cause: noMessage })), "Error: x (cause: ETIMEDOUT)");
        assert.equal(describeError(new Error("x", { cause: "socket hang up" })), "Error: x (cause: socket hang up)");
    });

    it("stringifies non-Error values", () => {
        assert.equal(describeError("http://u:p@h"), "http://***@h");
        assert.equal(describeError(42), "42");
    });
});

describe("describeLogMessage", () => {
    it("redacts strings", () => {
        assert.equal(describeLogMessage("GET http://u:p@h/db"), "GET http://***@h/db");
    });

    it("redacts an Error and its cause chain, as the library logs it with Logger(ex)", () => {
        const err = new TypeError("fetch failed", {
            cause: new Error("request to http://admin:pass@host/db failed, reason: ECONNREFUSED"),
        });
        const out = describeLogMessage(err);
        assert.equal(out, "TypeError: fetch failed (cause: request to http://***@host/db failed, reason: ECONNREFUSED)");
        assert.ok(!describeLogMessage(err, true).includes("pass"));
    });

    it("redacts plain objects, including nested errors", () => {
        const out = describeLogMessage({ url: "http://admin:pass@host/db", error: new Error("at http://admin:pass@host") });
        assert.ok(out.includes("http://***@host/db"));
        assert.ok(!out.includes("pass"));
    });

    it("does not throw on circular references or BigInt", () => {
        const obj: Record<string, unknown> = { url: "http://u:p@h", n: 1n };
        obj.self = obj;
        const out = describeLogMessage(obj);
        assert.ok(out.includes("http://***@h"));
        assert.ok(out.includes("[Circular"));
    });

    it("renders other values as console.log would", () => {
        assert.equal(describeLogMessage(42), "42");
        assert.equal(describeLogMessage(undefined), "undefined");
        assert.equal(describeLogMessage(null), "null");
    });
});
