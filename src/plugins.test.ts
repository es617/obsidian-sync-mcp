import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";
import { readOnlyVault, READ_ONLY_MESSAGE } from "./vault-readonly.js";
import { registerTools } from "./tools.js";
import { UpdateRetriesExhaustedError } from "./vault-backend.js";
import { guardedVault, loadPlugins, parsePluginPolicy, pluginDirectory, PluginWriteError, trackToolNames, type PluginPolicy } from "./plugins.js";

// The example plugin: one tool per vault call, so every guard can be reached from a tool.
const EXAMPLE = `
export default function register(ctx) {
    const { z } = ctx;
    ctx.addTool({
        name: "add_task",
        description: "Append a task line to a note.",
        parameters: z.object({ path: z.string(), task: z.string() }),
        execute: async ({ path, task }) => {
            await ctx.vault.editNote(path, (text) => text + "\\n- [ ] " + task);
            return "added";
        },
    });
    ctx.addTool({
        name: "put_note",
        description: "Write a note.",
        parameters: z.object({ path: z.string(), content: z.string(), createOnly: z.boolean().optional() }),
        execute: async ({ path, content, createOnly }) => { await ctx.vault.writeNote(path, content, { createOnly }); return "written"; },
    });
    ctx.addTool({
        name: "drop_note",
        description: "Delete a note.",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) => { await ctx.vault.deleteNote(path); return "deleted"; },
    });
    ctx.addTool({
        name: "shift_note",
        description: "Move a note.",
        parameters: z.object({ from: z.string(), to: z.string() }),
        execute: async ({ from, to }) => { await ctx.vault.moveNote(from, to); return "moved"; },
    });
    ctx.addTool({
        name: "peek",
        description: "Read a note.",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) => (await ctx.vault.readNote(path)) ?? "missing",
    });
    // The context exposes no backend to go around the guard.
    ctx.addTool({
        name: "inspect_context",
        description: "List what the context offers.",
        parameters: z.object({}),
        execute: async () => JSON.stringify({ ctx: Object.keys(ctx).sort(), vault: Object.keys(ctx.vault).sort() }),
    });
}
`;

describe("plugins", () => {
    let dir: string;
    before(async () => { dir = await mkdtemp(join(tmpdir(), "plugins-")); });
    after(async () => { await rm(dir, { recursive: true, force: true }); });

    async function setup(scope: string | undefined, plugins: Record<string, string>, readOnly = false, policy: PluginPolicy = { kind: "all" }) {
        const root = await mkdtemp(join(dir, "v-"));
        const pluginDir = await mkdtemp(join(dir, "p-"));
        for (const [name, code] of Object.entries(plugins)) await writeFile(join(pluginDir, name), code);
        const local = new LocalVault(root);
        await mkdir(join(root, "Tasks"), { recursive: true });
        await local.writeNote("Tasks/list.md", "# List");
        await local.writeNote("Archive/old.md", "old");
        const vault = readOnly ? readOnlyVault(local) : local;
        const tools: any[] = [];
        const server = { addTool: (t: any) => { tools.push(t); } };
        const toolNames = trackToolNames(server);
        const searchIndex = new SearchIndex();
        const writeFolders = parseWriteFolders(scope);
        registerTools(server as any, vault, searchIndex, "vault", readOnly, writeFolders);
        const load = (p: PluginPolicy = policy) => loadPlugins(pluginDir, p, { server, toolNames, vault, searchIndex, vaultName: "vault", readOnly, writeFolders });
        const call = (name: string, args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === name);
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { local, load, call, tools, searchIndex, pluginDir };
    }

    it("loads a plugin's tools, which use the vault", async () => {
        const { load, call, local, searchIndex } = await setup(undefined, { "tasks.mjs": EXAMPLE });
        assert.deepEqual(await load(), ["tasks"]);
        assert.equal(await call("add_task", { path: "Tasks/list.md", task: "water plants" }), "added");
        assert.equal(await local.readNote("Tasks/list.md"), "# List\n- [ ] water plants");
        assert.equal(await call("peek", { path: "Tasks/list.md" }), "# List\n- [ ] water plants");
        assert.ok(searchIndex.listPaths().includes("Tasks/list.md"), "plugin writes update the search index");
    });

    it("WRITE_FOLDERS applies to plugin writes exactly as to built-in tools", async () => {
        const { load, call, local } = await setup("Tasks:create+update", { "tasks.mjs": EXAMPLE });
        await load();
        // Outside the scope: every kind of write is refused, with the built-in message.
        assert.match(await call("add_task", { path: "Archive/old.md", task: "x" }), /Write access denied|outside|only allowed/i);
        assert.match(await call("put_note", { path: "Archive/new.md", content: "x" }), /Write access denied|outside|only allowed/i);
        assert.match(await call("shift_note", { from: "Archive/old.md", to: "Tasks/old.md" }), /Write access denied|outside|only allowed|can't/i);
        assert.equal(await local.readNote("Archive/old.md"), "old");
        assert.equal(await local.readNote("Archive/new.md"), null);
        // Inside it, but without delete permission: delete and move-away are refused.
        assert.match(await call("drop_note", { path: "Tasks/list.md" }), /delete/);
        assert.match(await call("shift_note", { from: "Tasks/list.md", to: "Tasks/moved.md" }), /delete/);
        assert.equal(await local.readNote("Tasks/list.md"), "# List");
        // Allowed writes work.
        assert.equal(await call("put_note", { path: "Tasks/new.md", content: "n" }), "written");
        assert.equal(await call("add_task", { path: "Tasks/new.md", task: "t" }), "added");
    });

    it("create-only folders and createOnly never replace a note", async () => {
        const { load, call, local } = await setup("Tasks:create", { "tasks.mjs": EXAMPLE });
        await load();
        assert.match(await call("put_note", { path: "Tasks/list.md", content: "replaced" }), /Note already exists|allows only create/);
        assert.match(await call("add_task", { path: "Tasks/list.md", task: "x" }), /allows only create|update/);
        assert.equal(await local.readNote("Tasks/list.md"), "# List");
        const open = await setup(undefined, { "tasks.mjs": EXAMPLE });
        await open.load();
        assert.equal(await open.call("put_note", { path: "Tasks/list.md", content: "replaced", createOnly: true }), "Note already exists: Tasks/list.md");
        assert.equal(await open.local.readNote("Tasks/list.md"), "# List");
    });

    it("READ_ONLY refuses every plugin write", async () => {
        const { load, call, local } = await setup(undefined, { "tasks.mjs": EXAMPLE }, true);
        await load();
        for (const [name, args] of [["add_task", { path: "Tasks/list.md", task: "x" }], ["put_note", { path: "Tasks/n.md", content: "x" }], ["drop_note", { path: "Tasks/list.md" }], ["shift_note", { from: "Tasks/list.md", to: "Tasks/m.md" }]] as const) {
            assert.equal(await call(name, args), READ_ONLY_MESSAGE, name);
        }
        assert.equal(await local.readNote("Tasks/list.md"), "# List");
    });

    it("the context exposes no backend, only the guarded calls", async () => {
        const { load, call } = await setup(undefined, { "tasks.mjs": EXAMPLE });
        await load();
        assert.deepEqual(JSON.parse(await call("inspect_context", {})), {
            ctx: ["addTool", "log", "readOnly", "vault", "vaultName", "z"],
            vault: ["deleteNote", "editNote", "getMetadata", "listNotes", "moveNote", "readNote", "writeNote"],
        });
    });

    it("refuses a tool name that is taken, by a built-in or another plugin", async () => {
        const shadow = `export default (ctx) => ctx.addTool({ name: "write_note", description: "", parameters: ctx.z.object({}), execute: async () => "" });`;
        await assert.rejects((await setup(undefined, { "evil.mjs": shadow })).load(), /plugin evil\.mjs: a tool named write_note already exists/);
        await assert.rejects((await setup(undefined, { "a.mjs": EXAMPLE, "b.mjs": EXAMPLE })).load(), /plugin b\.mjs: a tool named add_task already exists/);
    });

    it("fails on a plugin that doesn't load, exports no function, or throws", async () => {
        await assert.rejects((await setup(undefined, { "x.mjs": "export default 42;" })).load(), /plugin x\.mjs has no default export function/);
        await assert.rejects((await setup(undefined, { "x.mjs": "export default () => { throw new Error('boom'); };" })).load(), /plugin x\.mjs failed during setup: boom/);
        await assert.rejects((await setup(undefined, { "x.mjs": "this is not javascript" })).load(), /plugin x\.mjs failed to load/);
        await assert.rejects((await setup(undefined, { "x.mjs": `export default (ctx) => ctx.addTool({ name: "Bad Name", parameters: ctx.z.object({}), execute: async () => "" });` })).load(), /tool name must match/);
    });

    it("ignores files that aren't .js or .mjs", async () => {
        const { load, tools } = await setup(undefined, { "notes.txt": "not a plugin", "tasks.mjs": EXAMPLE });
        assert.deepEqual(await load(), ["tasks"]);
        assert.ok(tools.some((t) => t.name === "add_task"));
    });

    it("loads a plugin presented as a symlink, as a ConfigMap volume mounts it, and skips a linked directory", async () => {
        const { load, tools, pluginDir } = await setup(undefined, {});
        const data = join(pluginDir, "..data");
        await mkdir(data);
        await writeFile(join(data, "tasks.mjs"), EXAMPLE);
        await symlink(join(data, "tasks.mjs"), join(pluginDir, "tasks.mjs"));
        await mkdir(join(dir, "linked-dir.mjs"), { recursive: true });
        await symlink(join(dir, "linked-dir.mjs"), join(pluginDir, "dir.mjs"));
        assert.deepEqual(await load(), ["tasks"]);
        assert.ok(tools.some((t) => t.name === "add_task"));
    });

    it("stops on a plugin symlink that points at nothing", async () => {
        const { load, pluginDir } = await setup(undefined, {});
        await symlink(join(pluginDir, "missing.mjs"), join(pluginDir, "gone.mjs"));
        await assert.rejects(load(), /plugin gone\.mjs is a symlink to nothing/);
    });
});

// A plugin whose top-level code records that it ran, so a test can tell
// "not loaded" from "loaded but added nothing".
function marked(name: string): string {
    return `(globalThis.pluginRuns ??= []).push(${JSON.stringify(name)});
export default (ctx) => ctx.addTool({ name: ${JSON.stringify("tool_" + name.replace(/-/g, "_"))}, description: "", parameters: ctx.z.object({}), execute: async () => ${JSON.stringify(name)} });`;
}

describe("PLUGINS selects what loads", () => {
    let dir: string;
    before(async () => { dir = await mkdtemp(join(tmpdir(), "plugin-policy-")); });
    after(async () => { await rm(dir, { recursive: true, force: true }); });
    const runs = () => ((globalThis as any).pluginRuns ??= []) as string[];

    // Every case gets fresh file names: ESM caches an import by URL.
    let n = 0;
    async function folder(files: Record<string, string>) {
        const pluginDir = await mkdtemp(join(dir, "p-"));
        for (const [name, code] of Object.entries(files)) await writeFile(join(pluginDir, name), code);
        const tools: any[] = [];
        const server = { addTool: (t: any) => { tools.push(t); } };
        const toolNames = trackToolNames(server);
        const local = new LocalVault(await mkdtemp(join(dir, "v-")));
        const load = (raw: string | undefined) => loadPlugins(pluginDir, parsePluginPolicy(raw), {
            server, toolNames, vault: local, searchIndex: new SearchIndex(), vaultName: "vault", readOnly: false, writeFolders: null,
        });
        return { pluginDir, load, toolNames: () => tools.map((t) => t.name).sort() };
    }
    const unique = (base: string) => `${base}${++n}`;

    it("parses PLUGINS: unset, empty or only commas is off; all; a list of names", () => {
        for (const raw of [undefined, "", "  ", " , ,"]) assert.deepEqual(parsePluginPolicy(raw), { kind: "off" }, String(raw));
        assert.deepEqual(parsePluginPolicy("all"), { kind: "all" });
        assert.deepEqual(parsePluginPolicy(" all "), { kind: "all" });
        assert.deepEqual(parsePluginPolicy("tasks, daily-note,tasks"), { kind: "names", names: ["tasks", "daily-note"] });
        assert.throws(() => parsePluginPolicy("all,tasks"), /"all" can't be combined/);
        assert.throws(() => parsePluginPolicy("../evil"), /is not a plugin name/);
        assert.throws(() => parsePluginPolicy("tasks.mjs/x"), /is not a plugin name/);
    });

    it("loads nothing while PLUGINS is unset, even with plugins in the directory", async () => {
        const a = unique("off");
        const { load, toolNames } = await folder({ [`${a}.mjs`]: marked(a) });
        for (const raw of [undefined, ""]) assert.deepEqual(await load(raw), []);
        assert.deepEqual(toolNames(), []);
        assert.ok(!runs().includes(a), "an unselected plugin's code never runs");
    });

    it("with PLUGINS off, the directory is not read at all", async () => {
        // Would throw if it were read: a dangling plugin symlink stops a load.
        const { pluginDir, load } = await folder({});
        await symlink(join(pluginDir, "missing.mjs"), join(pluginDir, "gone.mjs"));
        assert.deepEqual(await load(undefined), []);
        assert.deepEqual(await loadPlugins(join(dir, "does-not-exist"), { kind: "off" }, {} as any), []);
    });

    it("a list of names loads only those, by file name without extension", async () => {
        const [a, b, c] = [unique("a"), unique("b"), unique("c")];
        const { pluginDir, load, toolNames } = await folder({ [`${a}.mjs`]: marked(a), [`${b}.js`]: marked(b), [`${c}.mjs`]: marked(c) });
        // An unlisted broken symlink can't stop startup: it is never looked at.
        await symlink(join(pluginDir, "missing.mjs"), join(pluginDir, "unlisted.mjs"));
        assert.deepEqual(await load(`${b},${a}`), [a, b], "in name order");
        assert.deepEqual(toolNames(), [`tool_${a}`, `tool_${b}`]);
        assert.ok(runs().includes(a) && runs().includes(b));
        assert.ok(!runs().includes(c), "an unlisted plugin's code never runs");
    });

    it("logs each plugin it loads with its name and file", async () => {
        const [a, b] = [unique("log-a"), unique("log-b")];
        const { pluginDir, load } = await folder({ [`${a}.mjs`]: marked(a), [`${b}.js`]: marked(b) });
        const lines: string[] = [];
        const original = console.log;
        console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
        try {
            await load(a);
        } finally {
            console.log = original;
        }
        const loaded = lines.filter((l) => l.startsWith("Plugin "));
        assert.deepEqual(loaded, [`Plugin ${a} loaded from ${join(resolve(pluginDir), `${a}.mjs`)}`]);
    });

    it("all loads every plugin in the directory", async () => {
        const [a, b] = [unique("all-a"), unique("all-b")];
        const { load, toolNames } = await folder({ [`${a}.mjs`]: marked(a), [`${b}.js`]: marked(b), "readme.txt": "not a plugin" });
        assert.deepEqual(await load("all"), [a, b]);
        assert.deepEqual(toolNames(), [`tool_all_a${n - 1}`, `tool_all_b${n}`]);
    });

    it("stops startup on a listed name with no plugin file, naming it and the directory", async () => {
        const a = unique("known");
        const { pluginDir, load } = await folder({ [`${a}.mjs`]: marked(a), "notes.md.txt": "" });
        await mkdir(join(pluginDir, "folder.mjs"));
        await assert.rejects(load(`${a},typo`), (err: Error) => err.message.includes("PLUGINS lists typo") && err.message.includes(pluginDir));
        // A directory with a plugin's name is not a plugin.
        await assert.rejects(load("folder"), /PLUGINS lists folder/);
        assert.ok(!runs().includes(a), "nothing ran: names are checked before any plugin is imported");
    });

    it("a missing directory: all loads nothing, a name list is an error", async () => {
        const missing = join(dir, "no-such-dir");
        const opts = { server: { addTool() {} }, toolNames: new Set<string>(), vault: new LocalVault(dir), searchIndex: new SearchIndex(), vaultName: "v", readOnly: false, writeFolders: null };
        assert.deepEqual(await loadPlugins(missing, { kind: "all" }, opts), []);
        await assert.rejects(loadPlugins(missing, { kind: "names", names: ["tasks"] }, opts), /plugin directory .*no-such-dir does not exist/);
    });

    it("skips dot-files, so an editor lock or a macOS ._ file can't stop startup", async () => {
        const a = unique("dot");
        const { pluginDir, load } = await folder({ [`${a}.mjs`]: marked(a), [`._${a}.mjs`]: "\0\0 not javascript" });
        await symlink(join(pluginDir, "nowhere"), join(pluginDir, `.#${a}.mjs`));
        assert.deepEqual(await load("all"), [a]);
    });

    it("refuses two files with one name, and a plugin named all", async () => {
        const a = unique("twice");
        const twice = await folder({ [`${a}.js`]: marked(a), [`${a}.mjs`]: marked(a) });
        await assert.rejects(twice.load("all"), new RegExp(`plugin ${a} is both`));
        await assert.rejects(twice.load(a), new RegExp(`plugin ${a} is both`));
        const reserved = await folder({ "all.mjs": marked("reserved") });
        await assert.rejects(reserved.load("all"), /"all" is reserved/);
    });

    it("loads a listed plugin from a ConfigMap-style volume (symlinks through ..data)", async () => {
        const a = unique("cm");
        const { pluginDir, load, toolNames } = await folder({});
        // What the kubelet writes: ..<timestamp>/ holds the files, ..data links to it, each key links through ..data.
        await mkdir(join(pluginDir, "..2026_01_01_00_00_00.000000001"));
        await writeFile(join(pluginDir, "..2026_01_01_00_00_00.000000001", `${a}.mjs`), marked(a));
        await symlink("..2026_01_01_00_00_00.000000001", join(pluginDir, "..data"));
        await symlink(`..data/${a}.mjs`, join(pluginDir, `${a}.mjs`));
        assert.deepEqual(await load(a), [a]);
        assert.deepEqual(toolNames(), [`tool_${a}`]);
    });

    it("the directory defaults to plugins/ in the data directory; PLUGIN_DIR overrides it", () => {
        assert.equal(pluginDirectory(undefined, "/data"), "/data/plugins");
        assert.equal(pluginDirectory("  ", "/data"), "/data/plugins");
        assert.equal(pluginDirectory("/etc/mcp-plugins", "/data"), "/etc/mcp-plugins");
    });
});

describe("plugins on a backend with revisions", () => {
    it("editNote goes through the revision-checked update, like edit_note", async () => {
        const { guardedVault } = await import("./plugins.js");
        const calls: string[] = [];
        let text = "start";
        const backend: any = {
            readNote: async () => text,
            writeNote: async () => { calls.push("writeNote"); return true; },
            updateNote: async (_p: string, apply: (c: string) => string, o: any) => {
                calls.push(`updateNote maxAttempts=${o?.maxAttempts}`);
                text = apply(text);
                return { content: text, revision: "2-x", attempts: 1 };
            },
        };
        const v = guardedVault(backend, new SearchIndex(), null, false);
        assert.equal(await v.editNote("a.md", (t) => t + "!"), "start!");
        assert.deepEqual(calls, ["updateNote maxAttempts=10"]);
    });
});

/** A tool's answer; a throw becomes "THREW: <message>", so a comparison shows it instead of stopping the test. */
async function answer(p: Promise<unknown>): Promise<string> {
    try {
        return String(await p);
    } catch (err) {
        return `THREW: ${(err as Error).message}`;
    }
}

/** A backend that records every write and never touches a disk; `revisions` adds updateNote (CouchDB mode). */
function recordingBackend(revisions = true, text = "start") {
    const writes: string[] = [];
    const backend: any = {
        readNote: async () => text,
        writeNote: async (p: string, c: string) => { writes.push(`write ${p} ${JSON.stringify(c)}`); return true; },
        deleteNote: async (p: string) => { writes.push(`delete ${p}`); return true; },
        moveNote: async (f: string, t: string) => { writes.push(`move ${f} ${t}`); return true; },
    };
    if (revisions) {
        backend.updateNote = async (p: string, apply: (c: string) => string) => {
            const next = apply(text);
            writes.push(`update ${p} ${JSON.stringify(next)}`);
            return { content: next, revision: "2-a", attempts: 1 };
        };
    }
    return { backend, writes };
}

describe("ctx.vault refuses values that aren't strings", () => {
    // A String subclass with its own replace(): the folder check would see "MCP/x.md".
    class Sneaky extends String {
        override replace(): string { return "MCP/x.md"; }
    }
    const sneaky = new Sneaky("Other/x.md") as unknown as string;
    const refused = (pattern: RegExp) => (err: unknown) => err instanceof PluginWriteError && pattern.test(err.message);

    for (const revisions of [true, false]) {
        it(`refuses a non-string path or content before any check or write (${revisions ? "CouchDB" : "local"}-shaped backend)`, async () => {
            const { backend, writes } = recordingBackend(revisions);
            const v = guardedVault(backend, new SearchIndex(), parseWriteFolders("MCP"), false);
            const cases: Array<[string, () => Promise<unknown>, RegExp]> = [
                ["writeNote path", () => v.writeNote(sneaky, "c"), /^writeNote: path must be a string, got a String object\. Nothing was written\.$/],
                ["writeNote undefined content", () => v.writeNote("MCP/a.md", undefined as any), /^writeNote: content must be a string, got undefined\./],
                ["writeNote object content", () => v.writeNote("MCP/a.md", { a: 1 } as any), /^writeNote: content must be a string, got an object\./],
                ["editNote path", () => v.editNote(sneaky, (t) => t), /^editNote: path must be a string/],
                ["deleteNote path", () => v.deleteNote(sneaky), /^deleteNote: path must be a string/],
                ["moveNote from", () => v.moveNote(sneaky, "MCP/b.md"), /^moveNote: from must be a string/],
                ["moveNote to", () => v.moveNote("MCP/a.md", sneaky), /^moveNote: to must be a string/],
            ];
            for (const [what, run, pattern] of cases) await assert.rejects(run(), refused(pattern), what);
            assert.deepEqual(writes, [], "nothing reached the backend");
        });

        it(`an editNote callback must return a string (${revisions ? "CouchDB" : "local"}-shaped backend)`, async () => {
            const { backend, writes } = recordingBackend(revisions);
            const v = guardedVault(backend, new SearchIndex(), null, false);
            for (const [what, result, got] of [
                ["undefined", undefined, "undefined"],
                ["an object", { text: "x" }, "an object"],
                ["a Promise", Promise.resolve("x"), "a Promise (the callback must not be async)"],
                ["a String object", new String("x"), "a String object"],
            ] as const) {
                await assert.rejects(v.editNote("a.md", () => result as any), refused(new RegExp(`^editNote: the callback must return the new text as a string, got ${got.replace(/[()]/g, "\\$&")}\\. Nothing was written\\.$`)), what);
            }
            assert.deepEqual(writes, []);
            assert.equal(await v.editNote("a.md", (t) => t + "!"), "start!", "a string still works");
        });
    }
});

describe("plugin answers match the built-in tools", () => {
    let dir: string;
    let pluginDir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "plugin-parity-"));
        pluginDir = await mkdtemp(join(dir, "p-"));
        await writeFile(join(pluginDir, "tasks.mjs"), EXAMPLE);
    });
    after(async () => { await rm(dir, { recursive: true, force: true }); });

    /** The built-in tools and the example plugin's tools over one backend. */
    async function both(backend: any, scope?: string) {
        const tools: any[] = [];
        const server = { addTool: (t: any) => { tools.push(t); } };
        const toolNames = trackToolNames(server);
        const searchIndex = new SearchIndex();
        const writeFolders = parseWriteFolders(scope);
        registerTools(server as any, backend, searchIndex, "vault", false, writeFolders);
        await loadPlugins(pluginDir, { kind: "names", names: ["tasks"] }, { server, toolNames, vault: backend, searchIndex, vaultName: "vault", readOnly: false, writeFolders });
        return (name: string, args: any) => {
            const tool = tools.find((t) => t.name === name);
            return answer(tool.execute(tool.parameters.parse(args), {}));
        };
    }
    const SUCCESS = /^(Note saved|Note edited|Deleted|Moved)/;

    it("every refusal on a local vault under WRITE_FOLDERS reads the same", async () => {
        const root = await mkdtemp(join(dir, "v-"));
        const local = new LocalVault(root);
        for (const p of ["Raw/a.md", "MCP/a.md", "MCP/b.md", "Notes/n.md", "Other/o.md"]) await local.writeNote(p, "text");
        const call = await both(local, "MCP,Raw:create,Notes:create+update");
        const cases: Array<[string, [string, any], [string, any]]> = [
            ["overwrite in a create-only folder", ["write_note", { path: "Raw/a.md", content: "x" }], ["put_note", { path: "Raw/a.md", content: "x" }]],
            ["createOnly onto a note in a create-only folder", ["write_note", { path: "Raw/a.md", content: "x" }], ["put_note", { path: "Raw/a.md", content: "x", createOnly: true }]],
            ["write outside every folder", ["write_note", { path: "Other/x.md", content: "x" }], ["put_note", { path: "Other/x.md", content: "x" }]],
            ["edit in a create-only folder", ["edit_note", { path: "Raw/a.md", content: "x" }], ["add_task", { path: "Raw/a.md", task: "x" }]],
            ["edit a missing note", ["edit_note", { path: "MCP/missing.md", content: "x" }], ["add_task", { path: "MCP/missing.md", task: "x" }]],
            ["edit outside every folder", ["edit_note", { path: "Other/o.md", content: "x" }], ["add_task", { path: "Other/o.md", task: "x" }]],
            ["delete without delete permission", ["delete_note", { path: "Notes/n.md" }], ["drop_note", { path: "Notes/n.md" }]],
            ["delete a missing note", ["delete_note", { path: "MCP/missing.md" }], ["drop_note", { path: "MCP/missing.md" }]],
            ["move onto an existing note", ["move_note", { from: "MCP/a.md", to: "MCP/b.md" }], ["shift_note", { from: "MCP/a.md", to: "MCP/b.md" }]],
            ["move out of a create-only folder", ["move_note", { from: "Raw/a.md", to: "MCP/z.md" }], ["shift_note", { from: "Raw/a.md", to: "MCP/z.md" }]],
            ["move into a folder outside the scope", ["move_note", { from: "MCP/a.md", to: "Other/z.md" }], ["shift_note", { from: "MCP/a.md", to: "Other/z.md" }]],
        ];
        for (const [what, [bt, bargs], [pt, pargs]] of cases) {
            const builtIn = await call(bt, bargs);
            assert.doesNotMatch(builtIn, SUCCESS, `${what}: the built-in refuses`);
            assert.equal(await call(pt, pargs), builtIn, what);
        }
        assert.match(await call("shift_note", { from: "MCP/a.md", to: "MCP/b.md" }), /Choose another path\.$/);
        assert.match(await call("put_note", { path: "Raw/a.md", content: "x" }), /^Write access denied: .*The note already exists; choose a new path\.$/);
    });

    it("writeNote gets write_note's retry budget", async () => {
        const seen: any[] = [];
        const backend: any = { readNote: async () => null, writeNote: async (_p: string, _c: string, o: any) => { seen.push(o); return true; } };
        const call = await both(backend);
        await call("write_note", { path: "a.md", content: "x" });
        await call("put_note", { path: "a.md", content: "x" });
        assert.equal(seen.length, 2);
        assert.ok(seen[0].maxAttempts > 0 && seen[0].minRetryMs > 0, JSON.stringify(seen[0]));
        assert.deepEqual(seen[1], seen[0]);
    });

    it("a note that kept changing reads the same, on write and on edit", async () => {
        const backend: any = {
            readNote: async () => "text",
            writeNote: async (p: string) => { throw new UpdateRetriesExhaustedError(p, 50); },
            updateNote: async (p: string) => { throw new UpdateRetriesExhaustedError(p, 50); },
        };
        const call = await both(backend);
        const write = await call("write_note", { path: "a.md", content: "x" });
        assert.match(write, /kept changing during 50 attempts/);
        assert.equal(await call("put_note", { path: "a.md", content: "x" }), write);
        const edit = await call("edit_note", { path: "a.md", content: "x" });
        assert.match(edit, /kept changing during 50 attempts/);
        assert.equal(await call("add_task", { path: "a.md", task: "x" }), edit);
    });

    it("local mode: a write the backend doesn't confirm reads the same, and nothing throws", async () => {
        const backend: any = { readNote: async () => "text", writeNote: async () => false, deleteNote: async () => false, moveNote: async () => false };
        const call = await both(backend);
        for (const [[bt, bargs], [pt, pargs]] of [
            [["edit_note", { path: "a.md", content: "x" }], ["add_task", { path: "a.md", task: "x" }]],
            [["write_note", { path: "a.md", content: "x" }], ["put_note", { path: "a.md", content: "x" }]],
            [["delete_note", { path: "a.md" }], ["drop_note", { path: "a.md" }]],
            [["move_note", { from: "a.md", to: "b.md" }], ["shift_note", { from: "a.md", to: "b.md" }]],
        ] as Array<[[string, any], [string, any]]>) {
            const builtIn = await call(bt, bargs);
            assert.match(builtIn, /^Failed to /, bt);
            assert.equal(await call(pt, pargs), builtIn, bt);
        }
    });
});
