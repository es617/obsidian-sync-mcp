/**
 * E2E test: starts server in local mode, tests all tools via MCP protocol.
 * Includes restart test to verify index persistence and mtime diff sync.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
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
        assert.ok(text.includes("more"));
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
    it("deletes a note", async () => {
        const text = await callTool("delete_note", { path: "archive/ci-test.md" });
        assert.ok(text.includes("Deleted"));
        assert.ok(!existsSync(join(vaultDir, "archive/ci-test.md")));
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
        // Stop server (closes SQLite and flushes auth state)
        const firstLogs = await stopServer();
        assert.ok(firstLogs.includes("Shutting down..."), "Should shut down cleanly");

        // Modify vault while server is down (simulates Obsidian edits)
        await writeFile(join(vaultDir, "new-while-down.md"), "# Created while MCP was down\nfreshcontent");
        await writeFile(join(vaultDir, "daily/2026-03-24.md"), "# Daily Note\nUpdated while down uniqueword");
        await unlink(join(vaultDir, "projects/test.md")); // delete a note

        // Restart server
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault" });

        // The server accepts connections while index reconciliation runs in the
        // background — wait for the incremental update to finish before asserting.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !serverLogs.includes("Search index updated")) {
            await new Promise((r) => setTimeout(r, 50));
        }
        const restartLogs = serverLogs;

        // Only the two new/changed bodies should be read; the removed path is
        // reconciled from the persisted path set.
        assert.ok(
            restartLogs.includes("Updating search index (2 changed") && restartLogs.includes("1 deleted"),
            `Should incrementally reconcile two changed notes and one deletion\n${restartLogs}`,
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
