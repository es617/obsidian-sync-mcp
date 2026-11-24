import { test, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";
import { registerTools, READ_NOTE_MAX_RESULT_SIZE_CHARS, SEARCH_MAX_TERMS, SEARCH_MAX_TERM_LENGTH, cleanSearchTerms } from "./tools.js";

function captureTools(): { name: string; _meta?: Record<string, unknown> }[] {
    const tools: { name: string; _meta?: Record<string, unknown> }[] = [];
    const server = { addTool: (tool: { name: string; _meta?: Record<string, unknown> }) => tools.push(tool) };
    registerTools(server as any, {} as any, {} as any, "vault");
    return tools;
}

test("read_note declares anthropic/maxResultSizeChars so Claude Code returns whole notes inline", () => {
    const readNote = captureTools().find((t) => t.name === "read_note");
    assert.ok(readNote, "read_note registered");
    assert.equal(readNote._meta?.["anthropic/maxResultSizeChars"], READ_NOTE_MAX_RESULT_SIZE_CHARS);
    assert.ok(READ_NOTE_MAX_RESULT_SIZE_CHARS > 50_000 && READ_NOTE_MAX_RESULT_SIZE_CHARS <= 500_000);
});

test("no other tool carries the annotation", () => {
    for (const tool of captureTools().filter((t) => t.name !== "read_note")) {
        assert.equal(tool._meta, undefined, `${tool.name} should not declare _meta`);
    }
});

test("search_notes is registered with a whole first sentence under 75 characters", () => {
    const tool = captureTools().find((t) => t.name === "search_notes") as any;
    assert.ok(tool, "search_notes registered");
    const firstLine = String(tool.description).split("\n")[0];
    assert.ok(firstLine.length < 75, `first line is ${firstLine.length} chars`);
    assert.ok(firstLine.endsWith("."), "first line ends with a period");
    assert.equal(tool._meta, undefined);
});

test("search_notes rejects more than SEARCH_MAX_TERMS terms at the schema", () => {
    const tool = captureTools().find((t) => t.name === "search_notes") as any;
    const terms = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    assert.equal(tool.parameters.safeParse({ terms: terms(SEARCH_MAX_TERMS) }).success, true);
    assert.equal(tool.parameters.safeParse({ terms: terms(SEARCH_MAX_TERMS + 1) }).success, false);
});

test("search_notes rejects a term longer than SEARCH_MAX_TERM_LENGTH at the schema", () => {
    const tool = captureTools().find((t) => t.name === "search_notes") as any;
    const term = (n: number) => "x".repeat(n);
    assert.equal(tool.parameters.safeParse({ terms: [term(SEARCH_MAX_TERM_LENGTH)] }).success, true);
    assert.equal(tool.parameters.safeParse({ terms: ["ok", term(SEARCH_MAX_TERM_LENGTH + 1)] }).success, false);
    assert.equal(tool.parameters.safeParse({ terms: [term(10_000)] }).success, false);
});

test("cleanSearchTerms cuts each term to SEARCH_MAX_TERM_LENGTH", () => {
    const clean = cleanSearchTerms([" " + "y".repeat(5_000_000) + " ", "short"]);
    assert.equal(clean.length, 2);
    assert.equal(clean[0].length, SEARCH_MAX_TERM_LENGTH);
    assert.equal(clean[1], "short");
});

test("cleanSearchTerms trims, drops empty terms and clamps to SEARCH_MAX_TERMS", () => {
    assert.deepEqual(cleanSearchTerms(undefined), []);
    assert.deepEqual(cleanSearchTerms([" a ", "", "  ", "b"]), ["a", "b"]);
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const clean = cleanSearchTerms(["", ...many]);
    assert.equal(clean.length, SEARCH_MAX_TERMS);
    assert.equal(clean[0], "t0", "empty terms are dropped before clamping");
});

describe("WRITE_FOLDERS permissions on note tools", () => {
    let dir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "tools-scope-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function setup(writeFolders: string) {
        const root = await mkdtemp(join(dir, "v-"));
        const vault = new LocalVault(root);
        const searchIndex = new SearchIndex();
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, searchIndex, "vault", false, parseWriteFolders(writeFolders));
        const call = (name: string, args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === name);
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { vault, call, tools };
    }

    it("create-only: write_note creates new notes but never overwrites", async () => {
        const { vault, call } = await setup("MCP,Raw:create");
        assert.match(await call("write_note", { path: "Raw/a.md", content: "v1" }), /Note saved: Raw\/a.md/);
        const again = await call("write_note", { path: "Raw/a.md", content: "v2" });
        assert.match(again, /Raw\/ allows only create, so 'Raw\/a.md' can't be changed\. The note already exists; choose a new path\./);
        assert.equal(await vault.readNote("Raw/a.md"), "v1");
    });

    it("create-only: edit, delete and move out are refused, before checking the note exists", async () => {
        const { vault, call } = await setup("MCP,Raw:create");
        await vault.writeNote("Raw/a.md", "v1");
        assert.match(await call("edit_note", { path: "Raw/a.md", content: "more" }), /can't be changed/);
        assert.match(await call("edit_note", { path: "Raw/missing.md", content: "more" }), /can't be changed/);
        assert.match(await call("delete_note", { path: "Raw/a.md" }), /can't be deleted or moved/);
        assert.match(await call("move_note", { from: "Raw/a.md", to: "MCP/a.md" }), /can't be deleted or moved/);
        assert.match(await call("move_note", { from: "Raw/a.md", to: "Raw/b.md" }), /can't be deleted or moved/);
        assert.equal(await vault.readNote("Raw/a.md"), "v1");
    });

    it("create-only: moving a note in is allowed, onto an existing note is not", async () => {
        const { vault, call } = await setup("MCP,Raw:create");
        await vault.writeNote("Raw/a.md", "raw");
        await vault.writeNote("MCP/a.md", "mcp");
        await vault.writeNote("MCP/b.md", "b");
        assert.match(await call("move_note", { from: "MCP/a.md", to: "Raw/a.md" }), /A note already exists at Raw\/a.md/);
        assert.equal(await vault.readNote("Raw/a.md"), "raw");
        assert.match(await call("move_note", { from: "MCP/b.md", to: "Raw/b.md" }), /Moved: MCP\/b.md → Raw\/b.md/);
        assert.equal(await vault.readNote("Raw/b.md"), "b");
    });

    it("create+update: everything but delete", async () => {
        const { vault, call } = await setup("Notes:create+update");
        assert.match(await call("write_note", { path: "Notes/a.md", content: "v1" }), /Note saved/);
        assert.match(await call("write_note", { path: "Notes/a.md", content: "v2" }), /Note saved/);
        assert.match(await call("edit_note", { path: "Notes/a.md", content: "v3" }), /Note edited/);
        assert.match(await call("delete_note", { path: "Notes/a.md" }), /Notes\/ allows only create\+update, so 'Notes\/a.md' can't be deleted or moved/);
        assert.equal(await vault.readNote("Notes/a.md"), "v2\nv3");
    });

    it("update-only: existing notes can be changed, new ones not created", async () => {
        const { vault, call } = await setup("Notes:update");
        await vault.writeNote("Notes/a.md", "v1");
        assert.match(await call("write_note", { path: "Notes/a.md", content: "v2" }), /Note saved/);
        assert.match(await call("write_note", { path: "Notes/new.md", content: "x" }), /allows only update, so 'Notes\/new.md' can't be created/);
        assert.equal(await vault.readNote("Notes/new.md"), null);
    });

    it("full write: move_note no longer replaces an existing destination", async () => {
        const { vault, call } = await setup("MCP");
        await vault.writeNote("MCP/a.md", "a");
        await vault.writeNote("MCP/b.md", "b");
        assert.match(await call("move_note", { from: "MCP/a.md", to: "MCP/b.md" }), /A note already exists at MCP\/b.md/);
        assert.equal(await vault.readNote("MCP/b.md"), "b");
    });

    it("outside every listed folder: today's message", async () => {
        const { call } = await setup("MCP,Raw:create");
        assert.equal(
            await call("write_note", { path: "daily/a.md", content: "x" }),
            "Write access denied: 'daily/a.md' is outside the writable folders (MCP/, Raw/ (create only)).",
        );
    });

    it("tool descriptions list the permissions", async () => {
        const { tools } = await setup("MCP,Raw:create");
        const desc = tools.find((t) => t.name === "write_note").description;
        assert.match(desc, /Writes are only allowed inside: MCP\/, Raw\/ \(create only\)\. create = add new files/);
    });
});
