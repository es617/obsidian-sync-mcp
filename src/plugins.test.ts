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
import { loadPlugins, parsePluginPolicy, pluginDirectory, trackToolNames, type PluginPolicy } from "./plugins.js";

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
