/**
 * E2E test: starts server in local mode, tests all tools via MCP protocol.
 * Includes restart test to verify index persistence and mtime diff sync.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { request as httpRequest } from "node:http";

const PORT = 9877;
const BASE = `http://localhost:${PORT}/mcp`;
const AUTH = "ci-test-token";

const NODE_BIN = existsSync("/opt/homebrew/opt/node@22/bin/node")
    ? "/opt/homebrew/opt/node@22/bin/node"
    : "node";

let server: ChildProcess;
let vaultDir: string;
let sessionId: string;
let serverLogs: string;
let lastInitResult: any = null;

// --- Helpers ---

function parseSSE(raw: string): any {
    for (const line of raw.split("\n")) {
        if (line.startsWith("data: ")) {
            try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
    }
    try { return JSON.parse(raw); } catch {
        throw new Error(`Could not parse response: ${raw.slice(0, 200)}`);
    }
}

async function mcpCall(method: string, params: any, id = 1): Promise<any> {
    const resp = await fetch(BASE, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": `Bearer ${AUTH}`,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return parseSSE(await resp.text());
}

async function callTool(name: string, args: any = {}): Promise<string> {
    const resp = await mcpCall("tools/call", { name, arguments: args });
    const text = resp?.result?.content?.[0]?.text;
    assert.ok(text, `Tool ${name} returned no text content`);
    return text;
}

async function startServer(env: Record<string, string> = {}): Promise<void> {
    serverLogs = "";
    server = spawn(NODE_BIN, ["dist/main.js"], {
        env: { ...process.env, PORT: String(PORT), MCP_AUTH_TOKEN: AUTH, ...env },
        stdio: "pipe",
    });
    server.stdout?.on("data", (d) => { serverLogs += d.toString(); });
    server.stderr?.on("data", (d) => { serverLogs += d.toString(); });

    const start = Date.now();
    while (Date.now() - start < 10000) {
        try {
            const resp = await fetch(BASE, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${AUTH}` },
                body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } } }),
            });
            if (resp.ok) {
                sessionId = resp.headers.get("mcp-session-id") ?? "";
                lastInitResult = parseSSE(await resp.text());
                return;
            }
        } catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Server did not start in time");
}

async function stopServer(): Promise<string> {
    if (!server) return "";
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    const logs = serverLogs;
    return logs;
}

// --- Setup / Teardown ---

before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "vault-e2e-"));
    await mkdir(join(vaultDir, "daily"), { recursive: true });
    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await writeFile(join(vaultDir, "Welcome.md"), "---\ntitle: Welcome\ntags: [intro]\n---\n# Welcome\nHello world");
    await writeFile(join(vaultDir, "daily/2026-03-24.md"), "# Daily Note");
    await writeFile(join(vaultDir, "projects/test.md"), "See [[Welcome]]\n\n#project");

    await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault" });
});

after(async () => {
    await stopServer();
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

// --- Tool Tests ---

describe("E2E: Auth", () => {
    it("rejects unauthenticated requests", async () => {
        const resp = await fetch(BASE, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } } }),
        });
        assert.equal(resp.status, 401);
    });

    it("rejects a non-ASCII bearer token with a normal 401", async () => {
        // Same string length as the real header but more UTF-8 bytes; this used to
        // throw inside the token check and surface the crypto error in the response.
        const forged = `Bearer ${AUTH.slice(0, -1)}é`;
        const resp = await fetch(BASE, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": forged },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } } }),
        });
        assert.equal(resp.status, 401);
        assert.ok(resp.headers.get("www-authenticate")?.includes("resource_metadata="));
        assert.ok(!(await resp.text()).includes("byte length"));
    });
});

describe("E2E: search_notes", () => {
    it("opens with the index status line and returns a hit with a snippet, never the body", async () => {
        const text = await callTool("search_notes", { terms: ["hello"] });
        const lines = text.split("\n");
        assert.match(lines[0], /^Index: local vault, no sequence — \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+ \(\d{2}:\d{2}Z\); 3 of 3 notes with content\.$/);
        assert.equal(lines[1], '1 note matches "hello". Call read_note on a hit before relying on it.');
        assert.match(lines[2], /^- \S* \[Welcome\.md\]\(obsidian:\/\/open\?vault=TestVault&file=Welcome\)$/);
        assert.match(lines[3], /^  .*Hello world/);
        assert.ok(!text.includes("# Welcome\nHello"), "the note body is not returned");
    });

    it("OR-combines terms and searches case-insensitively", async () => {
        const text = await callTool("search_notes", { terms: ["DAILY NOTE", "[[welcome]]"] });
        assert.match(text.split("\n")[1], /^2 notes match/);
        assert.ok(text.includes("daily/2026-03-24.md"));
        assert.ok(text.includes("projects/test.md"));
    });

    it("honours folder and tag filters", async () => {
        const inFolder = await callTool("search_notes", { terms: ["daily", "welcome"], folder: "daily" });
        assert.match(inFolder.split("\n")[1], /^1 note matches/);
        const byTag = await callTool("search_notes", { terms: ["hello", "daily"], tag: "intro" });
        assert.match(byTag.split("\n")[1], /^1 note matches/);
        assert.ok(byTag.includes("Welcome.md"));
    });

    it("searches path and title first and lists such hits on top, marked", async () => {
        const text = await callTool("search_notes", { terms: ["welcome"] });
        const lines = text.split("\n");
        assert.match(lines[1], /^2 notes match "welcome"\. 1 hit by path or title listed first\./);
        assert.match(lines[2], /\[Welcome\.md\]/);
        assert.match(lines[3], /^  \[path\/title\] /, "Welcome.md matches by path (and title) and by body");
        assert.match(lines[4], /\[projects\/test\.md\]/);
        assert.match(lines[5], /^  [^\[]/, "projects/test.md is a content-only hit");
        const byFolderName = await callTool("search_notes", { terms: ["projects/"] });
        assert.match(byFolderName.split("\n")[3], /^  \[path\/title match\]$/);
    });

    it("says so on zero hits and rejects an empty query", async () => {
        const none = await callTool("search_notes", { terms: ["no-such-phrase"] });
        assert.equal(none.split("\n")[1], 'No notes match "no-such-phrase".');
        assert.equal(await callTool("search_notes", {}), "Give at least one term.");
        assert.equal(await callTool("search_notes", { terms: ["  "] }), "Give at least one term.");
    });
});

describe("E2E: list_notes", () => {
    it("lists all notes", async () => {
        const text = await callTool("list_notes");
        assert.ok(text.includes("Welcome.md"));
        assert.ok(text.includes("daily/2026-03-24.md"));
        assert.ok(text.includes("projects/test.md"));
    });

    it("filters by folder", async () => {
        const text = await callTool("list_notes", { folder: "daily" });
        assert.ok(text.includes("2026-03-24.md"));
        assert.ok(!text.includes("Welcome.md"));
    });

    it("sorts by modified with limit", async () => {
        const text = await callTool("list_notes", { sort_by: "modified", limit: 2 });
        assert.ok(text.startsWith("Showing 2 of 3 notes"), text);
    });

    // Regression tests for #19: a client must be able to tell a truncated or
    // filtered listing from a complete one, and a zero-hit filter must not
    // claim the vault is empty.
    it("starts with a status line that names what the limit cut", async () => {
        const text = await callTool("list_notes", { limit: 2 });
        const firstLine = text.split("\n")[0];
        assert.ok(firstLine.startsWith("Showing 2 of 3 notes"), firstLine);
        assert.ok(firstLine.includes("Omitted 1: (root) (1)"), firstLine);
    });

    it("states the total on a complete listing", async () => {
        const text = await callTool("list_notes");
        assert.equal(text.split("\n")[0], "3 notes (sorted by name).");
    });

    it("keeps the filter visible on a complete filtered listing", async () => {
        const text = await callTool("list_notes", { tag: "intro" });
        assert.equal(text.split("\n")[0], '1 note matches tag="intro" (vault has 3 notes, sorted by name).');
    });

    it("does not claim the vault is empty on a zero-hit filter", async () => {
        const text = await callTool("list_notes", { name: "no-such-note" });
        assert.equal(text, 'No notes match name="no-such-note" (vault has 3 notes).');
    });

    it("filters by tag", async () => {
        const text = await callTool("list_notes", { tag: "intro" });
        assert.ok(text.includes("Welcome.md"));
        assert.ok(!text.includes("projects/test.md"));
    });
});

describe("E2E: read_note", () => {
    it("reads content with deep link", async () => {
        const text = await callTool("read_note", { path: "Welcome.md" });
        assert.ok(text.includes("Hello world"));
        assert.ok(text.includes("obsidian://open"));
    });
});

describe("E2E: write_note", () => {
    it("creates a new note", async () => {
        const text = await callTool("write_note", { path: "ci-test.md", content: "# CI Test\nWritten by e2e" });
        assert.ok(text.includes("Note saved"));
        assert.ok(existsSync(join(vaultDir, "ci-test.md")));
    });
});

describe("E2E: edit_note", () => {
    it("appends content", async () => {
        const text = await callTool("edit_note", { path: "Welcome.md", content: "Appended line" });
        assert.ok(text.includes("Note edited"));
        const read = await callTool("read_note", { path: "Welcome.md" });
        assert.ok(read.includes("Appended line"));
    });

    it("prepends after frontmatter", async () => {
        const text = await callTool("edit_note", { path: "Welcome.md", content: "Prepended line", operation: "prepend" });
        assert.ok(text.includes("Note edited"));
        const read = await callTool("read_note", { path: "Welcome.md" });
        assert.ok(read.includes("Prepended line"));
    });

    it("replaces exact text", async () => {
        const text = await callTool("edit_note", { path: "Welcome.md", content: "Goodbye world", operation: "replace", old_text: "Hello world" });
        assert.ok(text.includes("Note edited"));
        const read = await callTool("read_note", { path: "Welcome.md" });
        assert.ok(read.includes("Goodbye world"));
        assert.ok(!read.includes("Hello world"));
    });
});

describe("E2E: list_folders", () => {
    it("lists all folders with counts", async () => {
        const text = await callTool("list_folders");
        assert.ok(text.includes("daily"));
        assert.ok(text.includes("projects"));
    });
});

describe("E2E: list_tags", () => {
    it("lists all tags with counts", async () => {
        const text = await callTool("list_tags");
        assert.ok(text.includes("intro"));
        assert.ok(text.includes("project"));
    });
});

describe("E2E: get_note_metadata", () => {
    it("returns frontmatter and tags", async () => {
        const text = await callTool("get_note_metadata", { path: "Welcome.md" });
        assert.ok(text.includes("intro"));
        assert.ok(text.includes("Backlinks"));
    });

    it("returns outgoing links", async () => {
        const text = await callTool("get_note_metadata", { path: "projects/test.md" });
        assert.ok(text.includes("Outgoing links"));
        assert.ok(text.includes("Welcome"));
    });

    it("returns backlinks", async () => {
        const text = await callTool("get_note_metadata", { path: "Welcome.md" });
        assert.ok(text.includes("projects/test.md"));
    });
});

describe("E2E: move_note", () => {
    it("moves a note across folders", async () => {
        const text = await callTool("move_note", { from: "ci-test.md", to: "archive/ci-test.md" });
        assert.ok(text.includes("Moved"));
        assert.ok(!existsSync(join(vaultDir, "ci-test.md")));
        assert.ok(existsSync(join(vaultDir, "archive/ci-test.md")));
    });
});

describe("E2E: delete_note", () => {
    it("does not claim to have deleted a note that does not exist", async () => {
        const text = await callTool("delete_note", { path: "archive/never-existed.md" });
        assert.equal(text, "Note not found: archive/never-existed.md");
    });

    it("deletes a note", async () => {
        const text = await callTool("delete_note", { path: "archive/ci-test.md" });
        assert.ok(text.includes("Deleted"));
        assert.ok(!existsSync(join(vaultDir, "archive/ci-test.md")));
    });
});

// Regression for #18: mcp-proxy 6.7.x crashed with a TypeError on any request
// speaking MCP protocol revision 2026-07-28+ (current Claude clients), while
// legacy-handshake requests — everything else in this suite — kept working.
// These requests must get a JSON-RPC error or a session, never a 500/crash.
describe("E2E: modern-protocol requests must not crash the server", () => {
    async function modernRequest(body: any, extraHeaders: Record<string, string> = {}) {
        const resp = await fetch(BASE, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": `Bearer ${AUTH}`,
                "MCP-Protocol-Version": "2026-07-28",
                ...extraHeaders,
            },
            body: JSON.stringify(body),
        });
        return parseSSE(await resp.text());
    }

    it("survives a modern server/discover request", async () => {
        const resp = await modernRequest({
            jsonrpc: "2.0", id: 90, method: "server/discover",
            params: {
                _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                },
                clientInfo: { name: "e2e-modern", version: "1.0" },
            },
        }, { "Mcp-Method": "server/discover" });
        assert.notEqual(resp?.error?.code, -32603, `internal server error: ${JSON.stringify(resp)}`);
    });

    it("survives an initialize claiming a modern protocol version", async () => {
        const resp = await modernRequest({
            jsonrpc: "2.0", id: 91, method: "initialize",
            params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "e2e-modern", version: "1.0" } },
        });
        assert.notEqual(resp?.error?.code, -32603, `internal server error: ${JSON.stringify(resp)}`);
    });

    it("still serves the legacy session afterwards", async () => {
        const text = await callTool("list_notes", {});
        assert.ok(text.length > 0);
    });
});

describe("E2E: attachments", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f, 0x80]);

    it("registers no attachment tools unless ATTACHMENTS_ENABLED=true", async () => {
        const list = await mcpCall("tools/list", {});
        const tools: string[] = (list?.result?.tools ?? []).map((t: any) => t.name);
        assert.ok(!tools.some((t) => t.includes("attachment")), tools.join(", "));
        const resp = await fetch(`http://localhost:${PORT}/attachments/upload/anything`, { method: "PUT", body: png });
        assert.equal(resp.status, 404);
    });

    it("uploads through a one-time URL and lands byte-exact in the vault", async () => {
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", ATTACHMENTS_ENABLED: "true", BASE_URL: `http://localhost:${PORT}`, ATTACHMENT_MAX_BYTES: "1000" });
        assert.ok(serverLogs.includes("Attachments enabled"), serverLogs);
        assert.ok(lastInitResult?.result?.instructions?.includes("create_attachment_upload"));

        const out = await callTool("create_attachment_upload", { path: "Attachments/shot.png", size: png.byteLength });
        const url = out.match(/http:\/\/localhost:\d+\/attachments\/upload\/[A-Za-z0-9_-]+/)?.[0];
        assert.ok(url, out);

        // POST is not accepted: nothing is written and the token stays valid.
        const post = await fetch(url, { method: "POST", body: png, headers: { Origin: "https://evil.example" } });
        assert.ok(post.status >= 400, `POST got ${post.status}`);
        assert.ok(!existsSync(join(vaultDir, "Attachments/shot.png")));

        // No Authorization header: the token in the URL is the credential.
        const resp = await fetch(url, { method: "PUT", body: png });
        assert.equal(resp.status, 201);
        assert.deepEqual(await resp.json(), { path: "Attachments/shot.png", size: png.byteLength, embed: "![[Attachments/shot.png]]" });
        assert.deepEqual(new Uint8Array(readFileSync(join(vaultDir, "Attachments/shot.png"))), png);

        const reuse = await fetch(url, { method: "PUT", body: png });
        assert.equal(reuse.status, 404, "the URL works once");

        await callTool("edit_note", { path: "Welcome.md", content: "![[Attachments/shot.png]]" });
        const meta = await callTool("get_attachment_metadata", { path: "Attachments/shot.png" });
        assert.ok(meta.includes(`Size: ${png.byteLength} bytes`), meta);
        assert.ok(meta.includes("Embedded or linked in: Welcome.md"), meta);
    });

    it("rejects an upload over ATTACHMENT_MAX_BYTES and writes nothing", async () => {
        const out = await callTool("create_attachment_upload", { path: "Attachments/big.pdf" });
        const url = out.match(/http:\/\/\S+\/attachments\/upload\/[A-Za-z0-9_-]+/)![0];
        const resp = await fetch(url, { method: "PUT", body: new Uint8Array(1001) });
        assert.equal(resp.status, 413);
        assert.ok(!existsSync(join(vaultDir, "Attachments/big.pdf")));
        // Refused from Content-Length alone, so the same URL takes a smaller file.
        const retry = await fetch(url, { method: "PUT", body: new Uint8Array(10).fill(7) });
        assert.equal(retry.status, 201);
        assert.equal(readFileSync(join(vaultDir, "Attachments/big.pdf")).byteLength, 10);
        await callTool("delete_attachment", { path: "Attachments/big.pdf" });
    });

    it("lets only one of two concurrent uploads to the same new path succeed", async () => {
        const urls: string[] = [];
        for (let i = 0; i < 2; i++) {
            const out = await callTool("create_attachment_upload", { path: "Attachments/race.png" });
            urls.push(out.match(/http:\/\/\S+\/attachments\/upload\/[A-Za-z0-9_-]+/)![0]);
        }
        const bodies = [new Uint8Array(900).fill(1), new Uint8Array(900).fill(2)];
        const responses = await Promise.all(urls.map((url, i) => fetch(url, { method: "PUT", body: bodies[i] })));
        const statuses = responses.map((r) => r.status).sort();
        assert.deepEqual(statuses, [201, 409]);
        const winner = bodies[responses.findIndex((r) => r.status === 201)];
        assert.deepEqual(new Uint8Array(readFileSync(join(vaultDir, "Attachments/race.png"))), winner);
        await callTool("delete_attachment", { path: "Attachments/race.png" });
    });

    it("writes small files inline, moves and deletes them, and keeps them out of note listings", async () => {
        const saved = await callTool("write_attachment", { path: "Attachments/tiny.png", content_base64: Buffer.from(png).toString("base64") });
        assert.ok(saved.startsWith("Attachment saved"), saved);
        assert.ok(!(await callTool("list_notes")).includes("tiny.png"));
        assert.ok((await callTool("move_attachment", { from: "Attachments/tiny.png", to: "Attachments/moved.png" })).startsWith("Moved"));
        assert.deepEqual(new Uint8Array(readFileSync(join(vaultDir, "Attachments/moved.png"))), png);
        assert.ok((await callTool("delete_attachment", { path: "Attachments/moved.png" })).startsWith("Deleted"));
        assert.ok(!existsSync(join(vaultDir, "Attachments/moved.png")));
    });

    it("list_attachments sees uploads, files present at startup, and files added or removed outside the server", async () => {
        // The upload from the earlier test is in the index straight away.
        let out = await callTool("list_attachments", {});
        assert.ok(out.includes("[Attachments/shot.png]") && out.includes("in Welcome.md"), out);

        // A file dropped in by another program (e.g. Obsidian) shows up via the watcher.
        await writeFile(join(vaultDir, "Attachments/dropped.pdf"), png);
        let found = false;
        for (let i = 0; i < 30 && !found; i++) {
            await new Promise((r) => setTimeout(r, 100));
            found = (await callTool("list_attachments", { extension: "pdf" })).includes("Attachments/dropped.pdf");
        }
        assert.ok(found, "watcher indexed the dropped file");
        assert.match(await callTool("list_attachments", { unreferenced: true }), /dropped\.pdf\]\(.*\) — unreferenced/);

        // And one deleted outside the server disappears.
        await unlink(join(vaultDir, "Attachments/dropped.pdf"));
        let gone = false;
        for (let i = 0; i < 30 && !gone; i++) {
            await new Promise((r) => setTimeout(r, 100));
            gone = !(await callTool("list_attachments", {})).includes("dropped.pdf");
        }
        assert.ok(gone, "watcher removed the deleted file");

        // After a restart the startup scan finds what is on disk.
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", ATTACHMENTS_ENABLED: "true", BASE_URL: `http://localhost:${PORT}`, ATTACHMENT_MAX_BYTES: "1000" });
        for (let i = 0; i < 30 && !out.includes("Attachment index built"); i++) {
            await new Promise((r) => setTimeout(r, 100));
            out = serverLogs;
        }
        assert.ok((await callTool("list_attachments", {})).includes("[Attachments/shot.png]"), "startup scan");
    });

    it("refuses notes and config files through the attachment tools", async () => {
        assert.match(await callTool("create_attachment_upload", { path: "Welcome.md" }), /Invalid attachment path/);
        assert.match(await callTool("write_attachment", { path: ".obsidian/plugins/x/main.js", content_base64: "AQID" }), /Invalid attachment path/);
    });

    it("exposes only the read tools and no upload route under READ_ONLY", async () => {
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", ATTACHMENTS_ENABLED: "true", READ_ONLY: "true" });
        const list = await mcpCall("tools/list", {});
        const tools: string[] = (list?.result?.tools ?? []).map((t: any) => t.name);
        assert.deepEqual(tools.filter((t) => t.includes("attachment")).sort(), ["get_attachment_metadata", "list_attachments"]);
        const resp = await fetch(`http://localhost:${PORT}/attachments/upload/anything`, { method: "PUT", body: png });
        assert.equal(resp.status, 404);
    });
});

// --- Restart Test ---

describe("E2E: READ_ONLY mode", () => {
    it("hides write tools and rejects write calls when READ_ONLY=true", async () => {
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", READ_ONLY: "true" });
        assert.ok(serverLogs.includes("READ_ONLY mode"), "should log READ_ONLY mode at startup");

        const list = await mcpCall("tools/list", {});
        const tools: string[] = (list?.result?.tools ?? []).map((t: any) => t.name);
        for (const w of ["write_note", "edit_note", "delete_note", "move_note"]) {
            assert.ok(!tools.includes(w), `${w} should not be registered in READ_ONLY mode`);
        }
        for (const r of ["read_note", "list_notes", "list_folders", "list_tags", "get_note_metadata"]) {
            assert.ok(tools.includes(r), `${r} should remain available in READ_ONLY mode`);
        }

        const resp = await mcpCall("tools/call", { name: "write_note", arguments: { path: "blocked.md", content: "x" } });
        assert.ok(resp?.error, "write_note call should return an error");
        assert.ok(!existsSync(join(vaultDir, "blocked.md")), "no file should be created when write is blocked");
    });
});

describe("E2E: WRITE_FOLDERS permissions", () => {
    it("Raw:create allows new notes but refuses overwrite, edit, delete and move", async () => {
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", WRITE_FOLDERS: "MCP,Raw:create" });
        assert.ok(serverLogs.includes("WRITE_FOLDERS: writes restricted to MCP/, Raw/ (create only)."), serverLogs);

        assert.match(await callTool("write_note", { path: "Raw/source.md", content: "original" }), /Note saved/);
        assert.match(await callTool("write_note", { path: "Raw/source.md", content: "changed" }), /allows only create.*already exists/);
        assert.match(await callTool("edit_note", { path: "Raw/source.md", content: "more" }), /can't be changed/);
        assert.match(await callTool("delete_note", { path: "Raw/source.md" }), /can't be deleted or moved/);
        assert.match(await callTool("move_note", { from: "Raw/source.md", to: "MCP/source.md" }), /can't be deleted or moved/);
        assert.equal(await readFile(join(vaultDir, "Raw/source.md"), "utf-8"), "original");

        assert.match(await callTool("write_note", { path: "MCP/draft.md", content: "draft" }), /Note saved/);
        assert.match(await callTool("move_note", { from: "MCP/draft.md", to: "Raw/draft.md" }), /Moved/);
        assert.match(await callTool("write_note", { path: "daily/x.md", content: "x" }), /outside the writable folders/);
    });

    it("an unknown permission stops the server at startup", async () => {
        await stopServer();
        const child = spawn(NODE_BIN, ["dist/main.js"], {
            env: { ...process.env, PORT: String(PORT), MCP_AUTH_TOKEN: AUTH, VAULT_PATH: vaultDir, WRITE_FOLDERS: "Raw:creat" },
            stdio: "pipe",
        });
        let stderr = "";
        child.stderr?.on("data", (d) => { stderr += d.toString(); });
        const code = await new Promise((r) => child.on("exit", r));
        assert.equal(code, 1);
        assert.match(stderr, /unknown permission 'creat'/);
    });

    /** Start the server with an invalid WRITE_FOLDERS; resolves with its exit code and stderr. */
    async function startupFailure(writeFolders: string): Promise<{ code: unknown; stderr: string }> {
        const child = spawn(NODE_BIN, ["dist/main.js"], {
            env: { ...process.env, PORT: String(PORT), MCP_AUTH_TOKEN: AUTH, VAULT_PATH: vaultDir, WRITE_FOLDERS: writeFolders },
            stdio: "pipe",
        });
        let stderr = "";
        child.stderr?.on("data", (d) => { stderr += d.toString(); });
        const code = await new Promise((r) => child.on("exit", r));
        return { code, stderr };
    }

    it("a folder listed twice, an entry without a folder, or an empty permission stops the server", async () => {
        for (const [raw, message] of [
            ["MCP,/MCP/:create", "WRITE_FOLDERS: 'MCP' is listed more than once."],
            [":create", "WRITE_FOLDERS: ':create' has no folder. Use '/' for the vault root."],
            ["Raw:", "WRITE_FOLDERS: unknown permission '' in 'Raw:'."],
            ["Raw:create+read", "WRITE_FOLDERS: unknown permission 'read' in 'Raw:create+read'."],
        ]) {
            const { code, stderr } = await startupFailure(raw);
            assert.equal(code, 1, raw);
            assert.ok(stderr.includes(message), `${raw}: ${stderr}`);
            assert.ok(!stderr.includes("    at "), `${raw}: no stack trace`);
        }
    });

    describe("permission matrix (own vault)", () => {
        let permVault: string;
        before(async () => {
            permVault = await mkdtemp(join(tmpdir(), "vault-e2e-perm-"));
            for (const [p, c] of Object.entries({
                "Raw/existing.md": "raw original",
                "Notes/existing.md": "notes original",
                "Live/existing.md": "live original",
                "Trash/old.md": "old",
                "Trash/older.md": "older",
                "MCP/free.md": "free",
                "root.md": "root original",
            })) {
                await mkdir(join(permVault, p, ".."), { recursive: true });
                await writeFile(join(permVault, p), c);
            }
            await stopServer();
            await startServer({
                VAULT_PATH: permVault,
                VAULT_NAME: "PermVault",
                WRITE_FOLDERS: "/:create,MCP,Raw:create,Raw/scratch,Notes:create+update,Live:update,Trash:delete",
                ATTACHMENTS_ENABLED: "true",
                BASE_URL: `http://localhost:${PORT}`,
            });
        });
        after(async () => {
            await stopServer();
            await rm(permVault, { recursive: true, force: true });
        });
        const read = (p: string) => readFile(join(permVault, p), "utf-8");

        it("logs the scope and puts it in every write tool's description", async () => {
            assert.ok(serverLogs.includes(
                "WRITE_FOLDERS: writes restricted to / (create only), MCP/, Raw/ (create only), Raw/scratch/, Notes/ (create+update only), Live/ (update only), Trash/ (delete only).",
            ), serverLogs);
            const list = await mcpCall("tools/list", {});
            const tools: any[] = list?.result?.tools ?? [];
            for (const name of ["write_note", "edit_note", "delete_note", "move_note", "write_attachment", "create_attachment_upload", "delete_attachment", "move_attachment"]) {
                const desc: string = tools.find((t) => t.name === name)?.description ?? "";
                assert.match(desc, /Writes are only allowed inside: \/ \(create only\), MCP\/, Raw\/ \(create only\).*the most specific folder applies\./, name);
            }
            for (const name of ["read_note", "search_notes", "list_attachments"]) {
                assert.doesNotMatch(tools.find((t) => t.name === name)?.description ?? "", /Writes are only allowed/, name);
            }
        });

        it("root '/' rule: create-only at the root and in unlisted folders", async () => {
            assert.match(await callTool("write_note", { path: "new-root.md", content: "n" }), /^Note saved/);
            assert.match(await callTool("write_note", { path: "Unlisted/deep/n.md", content: "n" }), /^Note saved/);
            assert.equal(
                await callTool("write_note", { path: "root.md", content: "x" }),
                "Write access denied: / allows only create, so 'root.md' can't be changed. The note already exists; choose a new path.",
            );
            assert.match(await callTool("edit_note", { path: "root.md", content: "x" }), /can't be changed/);
            assert.match(await callTool("delete_note", { path: "root.md" }), /can't be deleted or moved/);
            assert.equal(await read("root.md"), "root original");
        });

        it("create-only: refusals don't reveal whether a note exists", async () => {
            for (const tool of ["edit_note", "delete_note"]) {
                const a = await callTool(tool, { path: "Raw/existing.md", content: "x" });
                const b = await callTool(tool, { path: "Raw/absent.md", content: "x" });
                assert.equal(a.replace("existing", "X"), b.replace("absent", "X"), tool);
            }
            assert.equal(await read("Raw/existing.md"), "raw original");
        });

        it("nested: Raw/scratch is fully writable inside create-only Raw", async () => {
            assert.match(await callTool("write_note", { path: "Raw/scratch/s.md", content: "1" }), /^Note saved/);
            assert.match(await callTool("write_note", { path: "Raw/scratch/s.md", content: "2" }), /^Note saved/);
            assert.match(await callTool("edit_note", { path: "Raw/scratch/s.md", content: "3" }), /^Note edited/);
            assert.match(await callTool("move_note", { from: "Raw/scratch/s.md", to: "Raw/promoted.md" }), /^Moved/);
            assert.match(await callTool("move_note", { from: "Raw/promoted.md", to: "Raw/scratch/back.md" }), /Raw\/ allows only create/);
            assert.equal(await read("Raw/promoted.md"), "2\n3");
        });

        it("case variant of a create-only folder gets create only", async () => {
            assert.match(await callTool("write_note", { path: "raw/lower.md", content: "l" }), /^Note saved/);
            assert.match(await callTool("write_note", { path: "raw/lower.md", content: "x" }), /Raw\/ allows only create, so 'raw\/lower.md' can't be changed/);
            assert.match(await callTool("delete_note", { path: "RAW/existing.md" }), /Raw\/ allows only create/);
        });

        it("create+update: no delete, no move out", async () => {
            assert.match(await callTool("write_note", { path: "Notes/existing.md", content: "v2" }), /^Note saved/);
            assert.match(await callTool("edit_note", { path: "Notes/existing.md", content: "v3" }), /^Note edited/);
            assert.match(await callTool("delete_note", { path: "Notes/existing.md" }), /Notes\/ allows only create\+update, so 'Notes\/existing.md' can't be deleted or moved/);
            assert.match(await callTool("move_note", { from: "Notes/existing.md", to: "MCP/n.md" }), /can't be deleted or moved/);
            assert.equal(await read("Notes/existing.md"), "v2\nv3");
        });

        it("update-only: edits existing notes; no new ones", async () => {
            assert.match(await callTool("edit_note", { path: "Live/existing.md", content: "edited" }), /^Note edited/);
            assert.match(await callTool("write_note", { path: "Live/existing.md", content: "replaced" }), /^Note saved/);
            assert.equal(await callTool("write_note", { path: "Live/new.md", content: "x" }), "Write access denied: Live/ allows only update, so 'Live/new.md' can't be created.");
            assert.match(await callTool("move_note", { from: "MCP/free.md", to: "Live/free.md" }), /can't be created/);
            assert.equal(await read("Live/existing.md"), "replaced");
            assert.ok(!existsSync(join(permVault, "Live/new.md")));
        });

        it("delete-only: delete and move out; nothing written there", async () => {
            assert.equal(await callTool("delete_note", { path: "Trash/old.md" }), "Deleted: Trash/old.md");
            assert.match(await callTool("move_note", { from: "Trash/older.md", to: "MCP/older.md" }), /^Moved/);
            assert.match(await callTool("write_note", { path: "Trash/x.md", content: "x" }), /Trash\/ allows only delete, so 'Trash\/x.md' can't be created/);
            assert.equal(await read("MCP/older.md"), "older");
            assert.ok(!existsSync(join(permVault, "Trash/older.md")));
        });

        it("move_note never replaces an existing note, even in a full-write folder", async () => {
            await callTool("write_note", { path: "MCP/a.md", content: "a" });
            await callTool("write_note", { path: "MCP/b.md", content: "b" });
            assert.equal(await callTool("move_note", { from: "MCP/a.md", to: "MCP/b.md" }), "A note already exists at MCP/b.md. Choose another path.");
            assert.equal(await callTool("move_note", { from: "MCP/a.md", to: "Raw/existing.md" }), "A note already exists at Raw/existing.md. Choose another path.");
            assert.equal(await read("MCP/a.md"), "a");
            assert.equal(await read("MCP/b.md"), "b");
            assert.equal(await read("Raw/existing.md"), "raw original");
        });

        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
        const urlOf = (out: string) => {
            const url = out.match(/http:\/\/localhost:\d+\/attachments\/upload\/[A-Za-z0-9_-]+/)?.[0];
            assert.ok(url, out);
            return url;
        };

        it("upload URL into a create-only folder: first upload lands, a stale URL gets 409, overwrite is refused", async () => {
            const first = urlOf(await callTool("create_attachment_upload", { path: "Raw/shot.png", size: png.byteLength }));
            const stale = urlOf(await callTool("create_attachment_upload", { path: "Raw/shot.png" }));
            const resp = await fetch(first, { method: "PUT", body: png });
            assert.equal(resp.status, 201);
            assert.deepEqual(await resp.json(), { path: "Raw/shot.png", size: png.byteLength, embed: "![[Raw/shot.png]]" });
            const late = await fetch(stale, { method: "PUT", body: new Uint8Array([9, 9]) });
            assert.equal(late.status, 409);
            assert.deepEqual(new Uint8Array(readFileSync(join(permVault, "Raw/shot.png"))), png);

            assert.equal(await callTool("create_attachment_upload", { path: "Raw/shot.png" }), "Attachment already exists: Raw/shot.png. Choose another path.");
            assert.equal(await callTool("create_attachment_upload", { path: "Raw/shot.png", overwrite: true }), "Write access denied: Raw/ allows only create, so 'Raw/shot.png' can't be changed.");
            assert.match(await callTool("write_attachment", { path: "Raw/shot.png", content_base64: Buffer.from([1]).toString("base64"), overwrite: true }), /can't be changed/);
            assert.match(await callTool("delete_attachment", { path: "Raw/shot.png" }), /can't be deleted or moved/);
            assert.match(await callTool("move_attachment", { from: "Raw/shot.png", to: "MCP/shot.png" }), /can't be deleted or moved/);
            assert.deepEqual(new Uint8Array(readFileSync(join(permVault, "Raw/shot.png"))), png);
        });

        it("upload URL with overwrite in a create+update folder replaces the file", async () => {
            const url1 = urlOf(await callTool("create_attachment_upload", { path: "Notes/pic.png" }));
            assert.equal((await fetch(url1, { method: "PUT", body: png })).status, 201);
            const url2 = urlOf(await callTool("create_attachment_upload", { path: "Notes/pic.png", overwrite: true }));
            assert.equal((await fetch(url2, { method: "PUT", body: new Uint8Array([7, 7, 7]) })).status, 201);
            assert.deepEqual(new Uint8Array(readFileSync(join(permVault, "Notes/pic.png"))), new Uint8Array([7, 7, 7]));
            assert.match(await callTool("delete_attachment", { path: "Notes/pic.png" }), /allows only create\+update/);
        });

        it("move_attachment into, out of and within restricted folders", async () => {
            const b64 = Buffer.from(png).toString("base64");
            assert.match(await callTool("write_attachment", { path: "MCP/m.png", content_base64: b64 }), /^Attachment saved/);
            assert.match(await callTool("move_attachment", { from: "MCP/m.png", to: "Raw/shot.png" }), /already exists: Raw\/shot.png\. Choose another path/);
            assert.match(await callTool("move_attachment", { from: "MCP/m.png", to: "Raw/m.png" }), /^Moved/);
            assert.match(await callTool("move_attachment", { from: "Raw/m.png", to: "Raw/m2.png" }), /can't be deleted or moved/);
            assert.match(await callTool("move_attachment", { from: "Raw/scratch/none.png", to: "Live/x.png" }), /Live\/ allows only update, so 'Live\/x.png' can't be created/);
            assert.ok(existsSync(join(permVault, "Raw/m.png")) && !existsSync(join(permVault, "MCP/m.png")));
        });
    });

    it("unset WRITE_FOLDERS: writes anywhere, but move_note still won't replace a note", async () => {
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault" });
        assert.ok(!serverLogs.includes("WRITE_FOLDERS"), serverLogs);
        const list = await mcpCall("tools/list", {});
        for (const t of list?.result?.tools ?? []) assert.doesNotMatch(t.description ?? "", /Writes are only allowed/, t.name);
        assert.match(await callTool("write_note", { path: "anywhere/u1.md", content: "1" }), /^Note saved/);
        assert.match(await callTool("write_note", { path: "anywhere/u1.md", content: "1b" }), /^Note saved/);
        assert.match(await callTool("write_note", { path: "anywhere/u2.md", content: "2" }), /^Note saved/);
        assert.equal(await callTool("move_note", { from: "anywhere/u1.md", to: "anywhere/u2.md" }), "A note already exists at anywhere/u2.md. Choose another path.");
        assert.equal(await readFile(join(vaultDir, "anywhere/u2.md"), "utf-8"), "2");
        assert.match(await callTool("move_note", { from: "anywhere/u1.md", to: "elsewhere/u1.md" }), /^Moved/);
        assert.match(await callTool("delete_note", { path: "elsewhere/u1.md" }), /^Deleted/);
        assert.match(await callTool("delete_note", { path: "anywhere/u2.md" }), /^Deleted/);
    });
});

describe("E2E: MCP_INSTRUCTIONS", () => {
    it("appends env-var contents to the instructions string", async () => {
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", MCP_INSTRUCTIONS: "inline-rule-XYZ" });
        const instr: string = lastInitResult?.result?.instructions ?? "";
        assert.ok(instr.includes("Access and manage an Obsidian vault"), "base instructions still present");
        assert.ok(instr.includes("inline-rule-XYZ"), "inline env contents appended");
    });

    it("file wins when both MCP_INSTRUCTIONS and MCP_INSTRUCTIONS_FILE are set", async () => {
        await stopServer();
        const instructionsFile = join(vaultDir, "agent-rules.md");
        await writeFile(instructionsFile, "file-rule-ABC\nfile-rule-DEF");
        await startServer({
            VAULT_PATH: vaultDir,
            VAULT_NAME: "TestVault",
            MCP_INSTRUCTIONS: "inline-rule-XYZ",
            MCP_INSTRUCTIONS_FILE: instructionsFile,
        });
        const instr: string = lastInitResult?.result?.instructions ?? "";
        assert.ok(instr.includes("Access and manage an Obsidian vault"), "base instructions still present");
        assert.ok(instr.includes("file-rule-ABC"), "file contents appended");
        assert.ok(instr.includes("file-rule-DEF"), "file contents appended (multiline)");
        assert.ok(!instr.includes("inline-rule-XYZ"), "inline env ignored when file is set");
        assert.ok(serverLogs.includes("ignoring MCP_INSTRUCTIONS env var"), "should warn about precedence");
    });
});

describe("E2E: cold restart with persisted index", () => {
    it("picks up changes and removes stale entries after restart", async () => {
        // Stop server (triggers saveToDisk)
        const firstLogs = await stopServer();
        assert.ok(firstLogs.includes("Search index saved"), "Should save index on shutdown");

        // Modify vault while server is down (simulates Obsidian edits)
        await writeFile(join(vaultDir, "new-while-down.md"), "# Created while MCP was down\nfreshcontent");
        await writeFile(join(vaultDir, "daily/2026-03-24.md"), "# Daily Note\nUpdated while down uniqueword");
        await unlink(join(vaultDir, "projects/test.md")); // delete a note

        // Restart server
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault" });

        // The server accepts connections while the index rebuild runs in the
        // background — wait for the rebuild to finish before asserting.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !serverLogs.includes("Search index built")) {
            await new Promise((r) => setTimeout(r, 50));
        }
        const restartLogs = serverLogs;

        // Should rebuild search index from vault files
        assert.ok(
            restartLogs.includes("Search index built") || restartLogs.includes("Search metadata loaded"),
            "Should rebuild index on restart",
        );

        // New note should be listed
        const listNew = await callTool("list_notes", { name: "new-while-down" });
        assert.ok(listNew.includes("new-while-down.md"), "New note should be found");

        // Updated note should be listed
        const list = await callTool("list_notes");
        assert.ok(list.includes("daily/2026-03-24.md"), "Updated note should be found");

        // Deleted note should be gone
        assert.ok(!list.includes("projects/test.md"), "Deleted note should not appear");
    });
});

// Runs last: replaces the shared auth server with a no-auth instance to exercise
// the Host-header allowlist. Uses raw http.request because fetch() forbids
// setting the Host header — which is exactly what a DNS-rebinding browser sends.
describe("E2E: no-auth Host allowlist (DNS-rebinding)", () => {
    function initializeWithHost(hostHeader: string, originHeader?: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "initialize",
                params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "poc", version: "1.0" } },
            });
            const headers: Record<string, string | number> = {
                "Host": hostHeader,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Content-Length": Buffer.byteLength(body),
            };
            if (originHeader) headers["Origin"] = originHeader;
            const req = httpRequest(
                { host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", headers },
                (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
            );
            req.on("error", reject);
            req.end(body);
        });
    }

    before(async () => {
        await stopServer();
        // Empty MCP_AUTH_TOKEN => no-auth mode, which enables the Host allowlist.
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", MCP_AUTH_TOKEN: "" });
    });

    it("rejects a forged (DNS-rebound) Host", async () => {
        assert.equal(await initializeWithHost("attacker.example"), 403);
    });

    it("rejects userinfo/path smuggling in Host", async () => {
        assert.equal(await initializeWithHost("attacker.example@127.0.0.1"), 403);
    });

    it("allows a genuine local Host", async () => {
        assert.equal(await initializeWithHost(`127.0.0.1:${PORT}`), 200);
    });

    it("rejects a cross-origin browser request with a loopback Host (wildcard-CORS bypass)", async () => {
        // The direct fetch('http://127.0.0.1/mcp') attack: real Host, attacker Origin.
        assert.equal(await initializeWithHost(`127.0.0.1:${PORT}`, "http://attacker.example"), 403);
    });

    it("allows a local browser Origin (e.g. MCP Inspector on localhost)", async () => {
        assert.equal(await initializeWithHost(`127.0.0.1:${PORT}`, `http://localhost:${PORT}`), 200);
    });

    it("honors MCP_ALLOWED_HOSTS", async () => {
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", MCP_AUTH_TOKEN: "", MCP_ALLOWED_HOSTS: "myhost.local" });
        assert.equal(await initializeWithHost("myhost.local"), 200);
        assert.equal(await initializeWithHost("attacker.example"), 403);
    });
});
