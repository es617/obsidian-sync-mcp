/**
 * Plugins: extra tools loaded at startup from the plugin directory, off unless
 * PLUGINS is set (see parsePluginPolicy).
 *
 * The directory is PLUGIN_DIR, else `plugins/` in DATA_DIR. A plugin is a
 * `.js` or `.mjs` file directly in it, not starting with a dot (a symlink to a file counts, as a
 * Kubernetes ConfigMap volume presents its keys); its name is the file name
 * without the extension. PLUGINS=a,b loads only those names, PLUGINS=all
 * every plugin in the directory. A file that isn't selected is never read,
 * stat'ed or imported. Selected plugins are imported in name order, and each
 * default export is called once with a PluginContext. A plugin adds tools
 * with `ctx.addTool` (same shape as a built-in FastMCP tool) and reaches the
 * vault only through `ctx.vault`, which applies the same checks as the
 * built-in tools: READ_ONLY, WRITE_FOLDERS with its create / update / delete
 * permissions, and the same write calls (so a plugin's writes get the same
 * create-only and edit semantics as write_note and edit_note), and keeps the
 * search index current.
 *
 * Trust: a plugin runs in this process with this process's rights. The
 * context gives it no way around the checks above, but nothing stops a
 * plugin's own code from importing anything it likes; enable only plugins
 * you would run as the server itself. Startup fails on a name in PLUGINS with
 * no plugin file, and on a selected plugin that does not load, does not
 * export a function, throws, or adds a tool whose name is taken, so a broken
 * plugin is never half-loaded and a misspelt name never goes unnoticed.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { NoteExistsError, NoteNotFoundError, type NoteInfo, type VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";
import { checkWrite, type WriteScope } from "./write-scope.js";
import { chooseWriteMode, editNoteText } from "./tools.js";
import { READ_ONLY_MESSAGE } from "./vault-readonly.js";

/** A write a plugin asked for was refused; the message is meant for the agent. */
export class PluginWriteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PluginWriteError";
    }
}

export interface PluginVault {
    readNote(path: string): Promise<string | null>;
    getMetadata(path: string): Promise<NoteInfo | null>;
    listNotes(folder?: string): Promise<string[]>;
    /** Create or replace a note, as write_note does; `createOnly` never replaces. */
    writeNote(path: string, content: string, options?: { createOnly?: boolean }): Promise<void>;
    /** Change a note's text as edit_note does; returns the new text. */
    editNote(path: string, apply: (content: string) => string): Promise<string>;
    deleteNote(path: string): Promise<void>;
    /** Never replaces a note at `to`. */
    moveNote(from: string, to: string): Promise<void>;
}

export interface PluginTool {
    name: string;
    description: string;
    parameters: z.ZodType;
    execute: (args: any, ctx: any) => Promise<unknown>;
}

export interface PluginContext {
    vaultName: string;
    readOnly: boolean;
    /** The zod the server uses, for tool parameters. */
    z: typeof z;
    vault: PluginVault;
    addTool(tool: PluginTool): void;
    log(message: string): void;
}

export type Plugin = (ctx: PluginContext) => void | Promise<void>;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

interface ToolServer {
    addTool(tool: any): void;
}

/** Record every tool name registered from now on, so plugins can't shadow one. */
export function trackToolNames(server: ToolServer): Set<string> {
    const names = new Set<string>();
    const add = server.addTool.bind(server);
    server.addTool = (tool: any) => {
        names.add(tool.name);
        return add(tool);
    };
    return names;
}

/** The vault as a plugin sees it: every write passes the same checks as the built-in tools. */
export function guardedVault(vault: VaultBackend, searchIndex: SearchIndex, writeFolders: WriteScope, readOnly: boolean): PluginVault {
    const deny = (message: string | null) => {
        if (message) throw new PluginWriteError(message);
    };
    const writable = () => deny(readOnly ? READ_ONLY_MESSAGE : null);
    return {
        readNote: (path) => vault.readNote(path),
        getMetadata: (path) => vault.getMetadata(path),
        listNotes: (folder) => vault.listNotes(folder),
        async writeNote(path, content, { createOnly = false } = {}) {
            writable();
            const choice = createOnly ? { mode: "create" as const } : chooseWriteMode(path, writeFolders);
            if ("denied" in choice) throw new PluginWriteError(choice.denied);
            if (createOnly) deny(checkWrite(path, "create", writeFolders));
            try {
                if (!(await vault.writeNote(path, content, { mode: choice.mode }))) throw new PluginWriteError(`Failed to write note: ${path}`);
            } catch (err) {
                if (err instanceof NoteExistsError) throw new PluginWriteError(`Note already exists: ${path}`);
                if (err instanceof NoteNotFoundError) throw new PluginWriteError(checkWrite(path, "create", writeFolders) ?? `Note not found: ${path}`);
                throw err;
            }
            searchIndex.update(path, content, Date.now());
        },
        async editNote(path, apply) {
            writable();
            deny(checkWrite(path, "update", writeFolders));
            const updated = await editNoteText(vault, path, apply);
            if (updated === null) throw new PluginWriteError(`Note not found: ${path}`);
            searchIndex.update(path, updated, Date.now());
            return updated;
        },
        async deleteNote(path) {
            writable();
            deny(checkWrite(path, "delete", writeFolders));
            if ((await vault.readNote(path)) === null) throw new PluginWriteError(`Note not found: ${path}`);
            if (!(await vault.deleteNote(path))) throw new PluginWriteError(`Failed to delete: ${path}`);
            searchIndex.remove(path);
        },
        async moveNote(from, to) {
            writable();
            deny(checkWrite(from, "delete", writeFolders) ?? checkWrite(to, "create", writeFolders));
            const content = await vault.readNote(from);
            try {
                if (!(await vault.moveNote(from, to))) throw new PluginWriteError(`Failed to move: ${from} → ${to}`);
            } catch (err) {
                if (err instanceof NoteExistsError) throw new PluginWriteError(`A note already exists at ${to}.`);
                throw err;
            }
            searchIndex.remove(from);
            if (content !== null) searchIndex.update(to, content, Date.now());
        },
    };
}

/** Which plugins to load, from PLUGINS. */
export type PluginPolicy = { kind: "off" } | { kind: "all" } | { kind: "names"; names: string[] };

/** A plugin's name: its file name without `.js` / `.mjs`. */
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PLUGIN_FILE = /\.m?js$/;

/**
 * Parse PLUGINS: unset or empty (also after trimming every entry) = off,
 * `all` = every plugin in the directory, otherwise a comma-separated list of
 * plugin names. Throws on a name that can't be a plugin file and on `all`
 * mixed with names.
 */
export function parsePluginPolicy(raw: string | undefined): PluginPolicy {
    const names = [...new Set((raw ?? "").split(",").map((n) => n.trim()).filter(Boolean))];
    if (names.length === 0) return { kind: "off" };
    if (names.includes("all")) {
        if (names.length > 1) throw new Error(`PLUGINS: "all" can't be combined with plugin names (got ${JSON.stringify(raw)}).`);
        return { kind: "all" };
    }
    for (const name of names) {
        if (!PLUGIN_NAME.test(name)) throw new Error(`PLUGINS: ${JSON.stringify(name)} is not a plugin name (the file name without .js or .mjs).`);
    }
    return { kind: "names", names };
}

/** The plugin directory: PLUGIN_DIR when set, else `plugins` in the data directory. */
export function pluginDirectory(pluginDirEnv: string | undefined, dataDir: string): string {
    return resolve(pluginDirEnv?.trim() || join(dataDir, "plugins"));
}

export interface LoadOptions {
    server: ToolServer;
    toolNames: Set<string>;
    vault: VaultBackend;
    searchIndex: SearchIndex;
    vaultName: string;
    readOnly: boolean;
    writeFolders: WriteScope;
}

/**
 * The files PLUGINS selects in `root`, as [name, file] in name order. Only
 * entries whose name is selected are looked at further, so an unselected file
 * (even a broken symlink) can't affect startup.
 */
async function selectPlugins(root: string, policy: Exclude<PluginPolicy, { kind: "off" }>): Promise<Array<[string, string]>> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        if (policy.kind === "all") return [];
        throw new Error(`PLUGINS lists ${policy.names.join(", ")}, but the plugin directory ${root} does not exist.`);
    }
    const wanted = policy.kind === "names" ? new Set(policy.names) : null;
    const found = new Map<string, string>();
    for (const e of entries) {
        // Dot-files are never plugins: macOS `._x.mjs`, editor locks, a ConfigMap's `..data`.
        if (e.name.startsWith(".") || !PLUGIN_FILE.test(e.name)) continue;
        const name = basename(e.name, extname(e.name));
        if (wanted && !wanted.has(name)) continue;
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
            // A Kubernetes ConfigMap volume presents every key as a symlink.
            const target = await stat(join(root, e.name)).catch(() => null);
            if (!target) throw new Error(`plugin ${e.name} is a symlink to nothing.`);
            isFile = target.isFile();
        }
        if (!isFile) continue;
        if (name === "all") throw new Error(`plugin ${e.name}: "all" is reserved in PLUGINS; rename the file.`);
        if (!PLUGIN_NAME.test(name)) throw new Error(`plugin ${e.name}: the name ${JSON.stringify(name)} can't be listed in PLUGINS; rename the file.`);
        const other = found.get(name);
        if (other) throw new Error(`plugin ${name} is both ${other} and ${e.name}; keep one.`);
        found.set(name, e.name);
    }
    if (policy.kind === "names") {
        const missing = policy.names.filter((n) => !found.has(n));
        if (missing.length) throw new Error(`PLUGINS lists ${missing.join(", ")}, but ${root} has no ${missing.map((n) => `${n}.js or ${n}.mjs`).join(", ")}.`);
    }
    return [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Load the plugins `policy` selects from `dir`; with the policy off, nothing
 * is read. Throws, naming the plugin, on the first one that fails. Returns the
 * names loaded.
 */
export async function loadPlugins(dir: string, policy: PluginPolicy, options: LoadOptions): Promise<string[]> {
    if (policy.kind === "off") return [];
    const root = resolve(dir);
    const selected = await selectPlugins(root, policy);
    const vault = guardedVault(options.vault, options.searchIndex, options.writeFolders, options.readOnly);
    for (const [, file] of selected) await loadPlugin(join(root, file), vault, options);
    return selected.map(([name]) => name);
}

/** Import one plugin file and run its setup. Throws, naming the file, when it fails. */
export async function loadPlugin(path: string, vault: PluginVault, options: LoadOptions): Promise<void> {
    const file = basename(path);
    const where = `plugin ${file}`;
    let plugin: unknown;
    try {
        plugin = (await import(pathToFileURL(path).href)).default;
    } catch (err) {
        throw new Error(`${where} failed to load: ${(err as Error).message}`);
    }
    if (typeof plugin !== "function") throw new Error(`${where} has no default export function.`);
    const ctx: PluginContext = {
        vaultName: options.vaultName,
        readOnly: options.readOnly,
        z,
        vault,
        log: (message) => console.log(`[${file}] ${message}`),
        addTool: (tool) => {
            if (!tool || typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
                throw new Error(`${where}: tool name must match ${TOOL_NAME}, got ${JSON.stringify(tool?.name)}.`);
            }
            if (options.toolNames.has(tool.name)) throw new Error(`${where}: a tool named ${tool.name} already exists.`);
            if (typeof tool.execute !== "function" || !tool.parameters) throw new Error(`${where}: tool ${tool.name} needs parameters and execute.`);
            const execute = tool.execute;
            options.server.addTool({
                ...tool,
                // A refused write is an answer for the agent, not a server error.
                execute: async (args: unknown, c: unknown) => {
                    try {
                        return await execute(args, c);
                    } catch (err) {
                        if (err instanceof PluginWriteError) return err.message;
                        throw err;
                    }
                },
            });
        },
    };
    try {
        await (plugin as Plugin)(ctx);
    } catch (err) {
        throw new Error(`${where} failed during setup: ${(err as Error).message}`);
    }
}
