import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { UploadRegistry, mountAttachmentUpload, readBodyLimited, BodyTooLargeError, UPLOAD_ROUTE_PREFIX } from "./uploads.js";
import { memoryAttachments } from "./attachment-test-fixtures.js";

function setup(opts: { now?: () => number } = {}) {
    const registry = new UploadRegistry({ ttlMs: 1000, maxPending: 3, now: opts.now });
    const { vault, files } = memoryAttachments();
    const app = new Hono();
    mountAttachmentUpload(app, { registry, vault });
    const put = (token: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
        app.request(`${UPLOAD_ROUTE_PREFIX}${token}`, { method: "PUT", body, headers, duplex: "half" } as RequestInit);
    return { registry, files, put, app };
}

const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i % 256));

describe("UploadRegistry", () => {
    it("issues unguessable single-use tokens", () => {
        const r = new UploadRegistry();
        const a = r.create({ path: "a.png", overwrite: false, maxBytes: 10 });
        const b = r.create({ path: "a.png", overwrite: false, maxBytes: 10 });
        assert.notEqual(a.token, b.token);
        assert.ok(a.token.length >= 43);
        assert.equal(r.take(a.token)?.path, "a.png");
        assert.equal(r.take(a.token), null);
    });

    it("expires handles", () => {
        let now = 0;
        const r = new UploadRegistry({ ttlMs: 100, now: () => now });
        const h = r.create({ path: "a.png", overwrite: false, maxBytes: 10 });
        now = 100;
        assert.equal(r.take(h.token), null);
    });

    it("caps pending handles, and expired ones free their slot", () => {
        let now = 0;
        const r = new UploadRegistry({ ttlMs: 100, maxPending: 2, now: () => now });
        r.create({ path: "a.png", overwrite: false, maxBytes: 1 });
        r.create({ path: "b.png", overwrite: false, maxBytes: 1 });
        assert.throws(() => r.create({ path: "c.png", overwrite: false, maxBytes: 1 }), /Too many pending uploads/);
        now = 200;
        assert.doesNotThrow(() => r.create({ path: "c.png", overwrite: false, maxBytes: 1 }));
        assert.equal(r.pending, 1);
    });
});

describe("readBodyLimited", () => {
    it("reads a whole body under the limit", async () => {
        const body = new Response(bytes(10)).body;
        assert.deepEqual(await readBodyLimited(body, 10), bytes(10));
    });

    it("stops past the limit", async () => {
        const body = new Response(bytes(11)).body;
        await assert.rejects(() => readBodyLimited(body, 10), BodyTooLargeError);
    });
});

describe("upload route", () => {
    it("writes the raw bytes to the handle's path and returns the embed", async () => {
        const { registry, files, put } = setup();
        const h = registry.create({ path: "Attachments/s.png", overwrite: false, maxBytes: 100 });
        const res = await put(h.token, bytes(50));
        assert.equal(res.status, 201);
        assert.deepEqual(await res.json(), { path: "Attachments/s.png", size: 50, embed: "![[Attachments/s.png]]" });
        assert.deepEqual(files.get("Attachments/s.png")?.data, bytes(50));
    });

    it("accepts PUT only, and a POST leaves the token usable", async () => {
        const { registry, app, files, put } = setup();
        const h = registry.create({ path: "a.png", overwrite: false, maxBytes: 100 });
        const res = await app.request(`${UPLOAD_ROUTE_PREFIX}${h.token}`, { method: "POST", body: bytes(3) });
        assert.equal(res.status, 404);
        assert.equal(files.size, 0);
        assert.equal((await put(h.token, bytes(3))).status, 201);
    });

    it("returns a generic 500 and reports the backend error to onError", async () => {
        const registry = new UploadRegistry();
        const errors: Array<[string, unknown]> = [];
        const vault = { writeAttachment: async () => { throw new Error("connect ECONNREFUSED http://admin:secret@couchdb.internal:5984"); } } as any;
        const app = new Hono();
        mountAttachmentUpload(app, { registry, vault, onError: (path, err) => errors.push([path, err]) });
        const h = registry.create({ path: "a.png", overwrite: false, maxBytes: 100 });
        const res = await app.request(`${UPLOAD_ROUTE_PREFIX}${h.token}`, { method: "PUT", body: bytes(3), duplex: "half" } as RequestInit);
        assert.equal(res.status, 500);
        const body = await res.text();
        assert.ok(!body.includes("couchdb.internal") && !body.includes("ECONNREFUSED"), body);
        assert.deepEqual(JSON.parse(body), { error: "Failed to write attachment: a.png" });
        assert.equal(errors.length, 1);
        assert.equal(errors[0][0], "a.png");
        assert.match((errors[0][1] as Error).message, /ECONNREFUSED/);
    });

    it("rejects unknown and reused tokens", async () => {
        const { registry, put } = setup();
        assert.equal((await put("nope", bytes(1))).status, 404);
        const h = registry.create({ path: "a.png", overwrite: false, maxBytes: 100 });
        assert.equal((await put(h.token, bytes(1))).status, 201);
        assert.equal((await put(h.token, bytes(1))).status, 404);
    });

    it("rejects expired tokens", async () => {
        let now = 0;
        const { registry, put, files } = setup({ now: () => now });
        const h = registry.create({ path: "a.png", overwrite: false, maxBytes: 100 });
        now = 5000;
        assert.equal((await put(h.token, bytes(1))).status, 404);
        assert.equal(files.size, 0);
    });

    it("rejects bodies over the limit, by header or by stream", async () => {
        const { registry, put, files } = setup();
        const h1 = registry.create({ path: "a.png", overwrite: false, maxBytes: 10 });
        // app.request doesn't add Content-Length the way fetch does, so set it.
        assert.equal((await put(h1.token, bytes(11), { "content-length": "11" })).status, 413);
        // A chunked stream with no content-length is cut off while reading.
        const h2 = registry.create({ path: "b.png", overwrite: false, maxBytes: 10 });
        const stream = new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(bytes(6)); c.enqueue(bytes(6)); c.close(); },
        });
        assert.equal((await put(h2.token, stream)).status, 413);
        assert.equal(files.size, 0);
    });

    it("keeps the URL usable after a 413 from the header, but not once the body was read", async () => {
        const { registry, put, files } = setup();
        const h = registry.create({ path: "a.png", overwrite: false, maxBytes: 10 });
        assert.equal((await put(h.token, bytes(11), { "content-length": "11" })).status, 413);
        assert.equal((await put(h.token, bytes(5))).status, 201, "retry with a smaller file");
        assert.equal(files.get("a.png")?.data.byteLength, 5);
        assert.equal((await put(h.token, bytes(5))).status, 404, "then used up");

        const s = registry.create({ path: "s.png", overwrite: false, maxBytes: 10 });
        const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes(6)); c.enqueue(bytes(6)); c.close(); } });
        assert.equal((await put(s.token, stream)).status, 413);
        assert.equal((await put(s.token, bytes(5))).status, 404, "a body cut off while reading uses the URL up");
    });

    it("rejects an empty body and a size mismatch", async () => {
        const { registry, put, files } = setup();
        const h1 = registry.create({ path: "a.png", overwrite: false, maxBytes: 10 });
        assert.equal((await put(h1.token, null)).status, 400);
        const h2 = registry.create({ path: "a.png", overwrite: false, maxBytes: 10, expectedSize: 5 });
        assert.equal((await put(h2.token, bytes(4))).status, 400);
        assert.equal(files.size, 0);
    });

    it("refuses to overwrite unless the handle allows it", async () => {
        const { registry, put, files } = setup();
        const first = registry.create({ path: "a.png", overwrite: false, maxBytes: 10 });
        const second = registry.create({ path: "a.png", overwrite: false, maxBytes: 10 });
        assert.equal((await put(first.token, bytes(2))).status, 201);
        assert.equal((await put(second.token, bytes(3))).status, 409);
        assert.equal(files.get("a.png")?.data.byteLength, 2);
        const replace = registry.create({ path: "a.png", overwrite: true, maxBytes: 10 });
        assert.equal((await put(replace.token, bytes(3))).status, 201);
        assert.equal(files.get("a.png")?.data.byteLength, 3);
    });
});
