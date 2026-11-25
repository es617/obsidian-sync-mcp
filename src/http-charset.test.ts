import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { declareUtf8Charset, withUtf8 } from "./http-charset.js";

describe("withUtf8", () => {
    it("adds charset=utf-8 to JSON and event streams that have none", () => {
        assert.equal(withUtf8("application/json"), "application/json; charset=utf-8");
        assert.equal(withUtf8("text/event-stream"), "text/event-stream; charset=utf-8");
        assert.equal(withUtf8("Application/JSON"), "Application/JSON; charset=utf-8");
    });

    it("leaves other types and an existing charset alone", () => {
        assert.equal(withUtf8("application/json; charset=latin1"), "application/json; charset=latin1");
        assert.equal(withUtf8("text/html"), "text/html");
        assert.equal(withUtf8("application/ld+json"), "application/ld+json");
        assert.equal(withUtf8("application/jsonx"), "application/jsonx");
    });
});

describe("declareUtf8Charset", () => {
    // Each route sets Content-Type in one of the ways Node allows.
    const routes: Record<string, (res: ServerResponse) => void> = {
        "/object": (res) => res.writeHead(200, { "Content-Type": "application/json" }).end("{}"),
        "/message": (res) => res.writeHead(400, "Bad Request", { "content-type": "application/json" }).end("{}"),
        "/flat-array": (res) => res.writeHead(200, ["Content-Type", "text/event-stream"]).end("data: x\n\n"),
        "/set-header": (res) => {
            res.setHeader("Content-Type", "text/event-stream");
            res.writeHead(200);
            res.end("data: x\n\n");
        },
        "/implicit": (res) => {
            res.setHeader("Content-Type", "application/json");
            res.end("{}");
        },
        "/has-charset": (res) => res.writeHead(200, { "Content-Type": "application/json; charset=latin1" }).end("{}"),
        "/html": (res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<p>"),
        "/none": (res) => res.writeHead(204).end(),
    };
    let server: Server;
    let base: string;

    before(async () => {
        declareUtf8Charset();
        declareUtf8Charset(); // a second call must not wrap twice
        server = createServer((req, res) => routes[req.url ?? ""]?.(res));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const contentType = async (path: string) => (await fetch(base + path)).headers.get("content-type");

    for (const path of ["/object", "/message", "/flat-array", "/set-header", "/implicit"]) {
        it(`declares charset=utf-8 when Content-Type is set via ${path.slice(1)}`, async () => {
            assert.match((await contentType(path)) ?? "", /^(application\/json|text\/event-stream); charset=utf-8$/);
        });
    }

    it("keeps an existing charset, other types and responses without a type unchanged", async () => {
        assert.equal(await contentType("/has-charset"), "application/json; charset=latin1");
        assert.equal(await contentType("/html"), "text/html");
        assert.equal(await contentType("/none"), null);
    });
});
