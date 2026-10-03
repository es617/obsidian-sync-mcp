import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactCredentials, describeError } from "./redact.js";

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

    it("stringifies non-Error values", () => {
        assert.equal(describeError("http://u:p@h"), "http://***@h");
        assert.equal(describeError(42), "42");
    });
});
