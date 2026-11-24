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

describe("WRITE_FOLDERS: every note tool under every permission set", () => {
    let dir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "tools-matrix-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function setup(writeFolders: string | null, readOnly = false) {
        const root = await mkdtemp(join(dir, "v-"));
        const vault = new LocalVault(root);
        const searchIndex = new SearchIndex();
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, searchIndex, "vault", readOnly, writeFolders === null ? null : parseWriteFolders(writeFolders));
        const call = (name: string, args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === name);
            assert.ok(tool, `${name} registered`);
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { vault, call, tools, searchIndex };
    }

    it("unset: every write works as before, and descriptions carry no scope note", async () => {
        const { vault, call, tools } = await setup(null);
        assert.match(await call("write_note", { path: "any/a.md", content: "v1" }), /^Note saved: any\/a.md/);
        assert.match(await call("write_note", { path: "any/a.md", content: "v2" }), /^Note saved/);
        assert.match(await call("edit_note", { path: "any/a.md", content: "v3" }), /^Note edited \(append\)/);
        assert.match(await call("move_note", { from: "any/a.md", to: "other/a.md" }), /^Moved: any\/a.md → other\/a.md/);
        assert.match(await call("delete_note", { path: "other/a.md" }), /^Deleted: other\/a.md$/);
        assert.equal(await vault.readNote("other/a.md"), null);
        for (const t of tools) assert.doesNotMatch(String(t.description), /Writes are only allowed/, t.name);
    });

    it("unset: an empty WRITE_FOLDERS is unrestricted too", async () => {
        const { call } = await setup(" , ");
        assert.match(await call("write_note", { path: "x.md", content: "x" }), /^Note saved/);
    });

    it("READ_ONLY wins over WRITE_FOLDERS: no write tools at all", async () => {
        const { tools } = await setup("MCP", true);
        const names = tools.map((t) => t.name);
        for (const w of ["write_note", "edit_note", "delete_note", "move_note"]) assert.ok(!names.includes(w), w);
    });

    it("create-only: refusals read the same whether or not the note exists", async () => {
        const { vault, call } = await setup("MCP,Raw:create");
        await vault.writeNote("Raw/exists.md", "x");
        const pairs: [string, (p: string) => any][] = [
            ["edit_note", (p) => ({ path: p, content: "y" })],
            ["delete_note", (p) => ({ path: p })],
            ["move_note", (p) => ({ from: p, to: "MCP/moved.md" })],
        ];
        for (const [tool, args] of pairs) {
            const a = await call(tool, args("Raw/exists.md"));
            const b = await call(tool, args("Raw/missing.md"));
            assert.equal(a.replace("exists", "X"), b.replace("missing", "X"), tool);
        }
        assert.equal(await vault.readNote("Raw/exists.md"), "x");
    });

    it("create-only: exact refusal messages", async () => {
        const { vault, call } = await setup("MCP,Raw:create");
        await vault.writeNote("Raw/a.md", "a");
        assert.equal(
            await call("write_note", { path: "Raw/a.md", content: "b" }),
            "Write access denied: Raw/ allows only create, so 'Raw/a.md' can't be changed. The note already exists; choose a new path.",
        );
        assert.equal(await call("edit_note", { path: "Raw/a.md", content: "b" }), "Write access denied: Raw/ allows only create, so 'Raw/a.md' can't be changed.");
        assert.equal(await call("delete_note", { path: "Raw/a.md" }), "Write access denied: Raw/ allows only create, so 'Raw/a.md' can't be deleted or moved.");
        assert.equal(await call("move_note", { from: "Raw/a.md", to: "MCP/a.md" }), "Write access denied: Raw/ allows only create, so 'Raw/a.md' can't be deleted or moved.");
    });

    it("create-only: a new note is indexed and gets a deep link", async () => {
        const { call, searchIndex } = await setup("Raw:create");
        const out = await call("write_note", { path: "Raw/new.md", content: "hello zebra" });
        assert.match(out, /^Note saved: Raw\/new.md\n\[Open in Obsidian\]\(obsidian:/);
        assert.equal(searchIndex.getContent("Raw/new.md"), "hello zebra");
    });

    it("create+update: write, overwrite, edit and move in; delete and move out refused", async () => {
        const { vault, call } = await setup("MCP,Notes:create+update");
        assert.match(await call("write_note", { path: "Notes/a.md", content: "v1" }), /^Note saved/);
        assert.match(await call("write_note", { path: "Notes/a.md", content: "v2" }), /^Note saved/);
        assert.match(await call("edit_note", { path: "Notes/a.md", operation: "replace", old_text: "v2", content: "v3" }), /^Note edited \(replace\)/);
        await vault.writeNote("MCP/m.md", "m");
        assert.match(await call("move_note", { from: "MCP/m.md", to: "Notes/m.md" }), /^Moved/);
        assert.match(await call("move_note", { from: "Notes/m.md", to: "MCP/m.md" }), /Notes\/ allows only create\+update, so 'Notes\/m.md' can't be deleted or moved/);
        assert.match(await call("move_note", { from: "Notes/a.md", to: "Notes/b.md" }), /can't be deleted or moved/, "a rename deletes too");
        assert.equal(await vault.readNote("Notes/a.md"), "v3");
    });

    it("update-only: edit and overwrite existing; create, delete and move refused", async () => {
        const { vault, call } = await setup("MCP,Live:update");
        await vault.writeNote("Live/a.md", "v1");
        await vault.writeNote("MCP/m.md", "m");
        assert.match(await call("edit_note", { path: "Live/a.md", content: "v2" }), /^Note edited/);
        assert.match(await call("write_note", { path: "Live/a.md", content: "v3" }), /^Note saved/);
        assert.equal(await call("write_note", { path: "Live/b.md", content: "x" }), "Write access denied: Live/ allows only update, so 'Live/b.md' can't be created.");
        assert.equal(await call("edit_note", { path: "Live/missing.md", content: "x" }), "Note not found: Live/missing.md");
        assert.match(await call("delete_note", { path: "Live/a.md" }), /allows only update, so 'Live\/a.md' can't be deleted or moved/);
        assert.match(await call("move_note", { from: "MCP/m.md", to: "Live/m.md" }), /allows only update, so 'Live\/m.md' can't be created/);
        assert.equal(await vault.readNote("Live/a.md"), "v3");
        assert.equal(await vault.readNote("Live/b.md"), null);
        assert.equal(await vault.readNote("MCP/m.md"), "m");
    });

    it("delete-only: delete and move out work; anything that writes there is refused", async () => {
        const { vault, call } = await setup("MCP,Trash:delete");
        await vault.writeNote("Trash/a.md", "a");
        await vault.writeNote("Trash/b.md", "b");
        await vault.writeNote("MCP/m.md", "m");
        assert.equal(await call("write_note", { path: "Trash/a.md", content: "x" }), "Write access denied: Trash/ allows only delete, so 'Trash/a.md' can't be created.");
        assert.match(await call("edit_note", { path: "Trash/a.md", content: "x" }), /allows only delete, so 'Trash\/a.md' can't be changed/);
        assert.match(await call("move_note", { from: "MCP/m.md", to: "Trash/m.md" }), /can't be created/);
        assert.match(await call("move_note", { from: "Trash/a.md", to: "Trash/c.md" }), /'Trash\/c.md' can't be created/, "a rename within needs create");
        assert.match(await call("move_note", { from: "Trash/a.md", to: "MCP/a.md" }), /^Moved: Trash\/a.md → MCP\/a.md/);
        assert.equal(await call("delete_note", { path: "Trash/b.md" }), "Deleted: Trash/b.md");
        assert.equal(await call("delete_note", { path: "Trash/b.md" }), "Note not found: Trash/b.md");
        assert.equal(await vault.readNote("MCP/a.md"), "a");
    });

    it("root rule '/': covers root-level notes and every unlisted folder", async () => {
        const { vault, call } = await setup("/:create,MCP");
        assert.match(await call("write_note", { path: "root.md", content: "r" }), /^Note saved/);
        assert.match(await call("write_note", { path: "deep/er/x.md", content: "x" }), /^Note saved/);
        assert.equal(
            await call("write_note", { path: "root.md", content: "r2" }),
            "Write access denied: / allows only create, so 'root.md' can't be changed. The note already exists; choose a new path.",
        );
        assert.match(await call("delete_note", { path: "deep/er/x.md" }), /^Write access denied: \/ allows only create/);
        assert.match(await call("move_note", { from: "root.md", to: "MCP/root.md" }), /'root.md' can't be deleted or moved/);
        assert.match(await call("move_note", { from: "MCP/none.md", to: "x.md" }), /^Failed to move/, "MCP → root passes the check");
        assert.equal(await vault.readNote("root.md"), "r");
    });

    it("nested: the most specific folder applies, both ways", async () => {
        const { vault, call } = await setup("Raw:create,Raw/scratch");
        await vault.writeNote("Raw/a.md", "a");
        assert.match(await call("write_note", { path: "Raw/scratch/s.md", content: "1" }), /^Note saved/);
        assert.match(await call("write_note", { path: "Raw/scratch/s.md", content: "2" }), /^Note saved/);
        assert.match(await call("edit_note", { path: "Raw/scratch/s.md", content: "3" }), /^Note edited/);
        assert.match(await call("move_note", { from: "Raw/scratch/s.md", to: "Raw/s.md" }), /^Moved/, "scratch → Raw: delete in scratch, create in Raw");
        assert.match(await call("move_note", { from: "Raw/a.md", to: "Raw/scratch/a.md" }), /Raw\/ allows only create, so 'Raw\/a.md' can't be deleted or moved/);
        assert.match(await call("edit_note", { path: "Raw/s.md", content: "4" }), /Raw\/ allows only create/);
        assert.equal(await vault.readNote("Raw/s.md"), "2\n3");
        assert.match(await call("write_note", { path: "Rawx/a.md", content: "x" }), /outside the writable folders/);
    });

    it("case variants: another spelling of a create-only folder gets create only", async () => {
        const { vault, call } = await setup("/,Raw:create");
        await vault.writeNote("Raw/a.md", "a");
        await vault.writeNote("raw/b.md", "b");
        assert.match(await call("write_note", { path: "raw/new.md", content: "n" }), /^Note saved/);
        assert.match(await call("write_note", { path: "raw/b.md", content: "x" }), /Raw\/ allows only create, so 'raw\/b.md' can't be changed\. The note already exists/);
        assert.match(await call("edit_note", { path: "RAW/a.md", content: "x" }), /Raw\/ allows only create, so 'RAW\/a.md' can't be changed/);
        assert.match(await call("delete_note", { path: "raw/b.md" }), /can't be deleted or moved/);
        assert.match(await call("move_note", { from: "raw/b.md", to: "Other/b.md" }), /can't be deleted or moved/);
        assert.match(await call("move_note", { from: "Raw/a.md", to: "raw/a.md" }), /can't be deleted or moved/, "a case-only rename deletes too");
        assert.equal(await vault.readNote("raw/b.md"), "b");
        assert.equal(await vault.readNote("Raw/a.md"), "a");
    });

    it("move_note: the source is checked before the destination, each named in its refusal", async () => {
        const { call } = await setup("MCP,Raw:create");
        assert.equal(
            await call("move_note", { from: "daily/a.md", to: "elsewhere/a.md" }),
            "Write access denied: 'daily/a.md' is outside the writable folders (MCP/, Raw/ (create only)).",
        );
        assert.equal(
            await call("move_note", { from: "MCP/a.md", to: "daily/a.md" }),
            "Write access denied: 'daily/a.md' is outside the writable folders (MCP/, Raw/ (create only)).",
        );
    });

    it("move_note: within, into and out of a full-write folder; never onto an existing note", async () => {
        const { vault, call, searchIndex } = await setup("MCP,Raw:create");
        await vault.writeNote("MCP/a.md", "alpha kiwi");
        await vault.writeNote("MCP/b.md", "b");
        searchIndex.update("MCP/a.md", "alpha kiwi");
        assert.match(await call("move_note", { from: "MCP/a.md", to: "MCP/sub/a.md" }), /^Moved/);
        assert.equal(await call("move_note", { from: "MCP/sub/a.md", to: "MCP/b.md" }), "A note already exists at MCP/b.md. Choose another path.");
        assert.equal(await vault.readNote("MCP/sub/a.md"), "alpha kiwi", "refused move keeps the source");
        assert.equal(await vault.readNote("MCP/b.md"), "b");
        assert.equal(searchIndex.getContent("MCP/sub/a.md"), "alpha kiwi", "index unchanged by the refusal");
        assert.match(await call("move_note", { from: "MCP/sub/a.md", to: "Raw/a.md" }), /^Moved/);
        assert.deepEqual(searchIndex.listPaths(), ["Raw/a.md"]);
        assert.equal(searchIndex.getContent("MCP/sub/a.md"), null);
        assert.equal(searchIndex.getContent("Raw/a.md"), "alpha kiwi");
    });

    it("edit_note: a note deleted between read and write is not recreated", async () => {
        const { vault, call } = await setup("MCP");
        await vault.writeNote("MCP/a.md", "a");
        const readNote = vault.readNote.bind(vault);
        vault.readNote = async (p: string) => {
            const content = await readNote(p);
            await vault.deleteNote(p);
            return content;
        };
        assert.equal(await call("edit_note", { path: "MCP/a.md", content: "more" }), "Note not found: MCP/a.md");
        vault.readNote = readNote;
        assert.equal(await vault.readNote("MCP/a.md"), null);
    });

    it("write_note: a note created by someone else after the check is not overwritten in a create-only folder", async () => {
        const { vault, call } = await setup("Raw:create");
        const writeNote = vault.writeNote.bind(vault);
        const modes: unknown[] = [];
        vault.writeNote = async (p: string, c: string, o?: any) => {
            modes.push(o?.mode);
            await writeNote(p, "someone else");
            return writeNote(p, c, o);
        };
        assert.match(await call("write_note", { path: "Raw/a.md", content: "mine" }), /The note already exists; choose a new path\./);
        assert.deepEqual(modes, ["create"]);
        vault.writeNote = writeNote;
        assert.equal(await vault.readNote("Raw/a.md"), "someone else");
    });

    it("write_note passes the mode the folder allows down to the backend", async () => {
        const cases: [string, string | undefined][] = [["MCP", "upsert"], ["MCP:create+update", "upsert"], ["MCP:create", "create"], ["MCP:update", "update"], ["MCP:create+delete", "create"], ["MCP:update+delete", "update"]];
        for (const [scope, mode] of cases) {
            const { vault, call } = await setup(scope);
            await vault.writeNote("MCP/a.md", "x");
            const seen: unknown[] = [];
            const writeNote = vault.writeNote.bind(vault);
            vault.writeNote = async (p: string, c: string, o?: any) => { seen.push(o?.mode); return writeNote(p, c, o); };
            await call("write_note", { path: "MCP/a.md", content: "y" });
            assert.deepEqual(seen, [mode], scope);
        }
        const { vault, call } = await setup(null);
        const seen: unknown[] = [];
        vault.writeNote = async (_p: string, _c: string, o?: any) => { seen.push(o?.mode); return true; };
        await call("write_note", { path: "a.md", content: "y" });
        assert.deepEqual(seen, ["upsert"], "unset scope upserts");
    });

    it("tool descriptions: every write tool carries the scope note and legend", async () => {
        const { tools } = await setup("/,Raw:create");
        for (const name of ["write_note", "edit_note", "delete_note", "move_note"]) {
            const desc = tools.find((t) => t.name === name).description;
            assert.ok(desc.endsWith(" Writes are only allowed inside: /, Raw/ (create only). create = add new files, update = change existing files, delete = delete or move files away; the most specific folder applies."), name);
        }
        assert.match(tools.find((t) => t.name === "move_note").description, /Never replaces an existing note at the destination\./);
    });
});
