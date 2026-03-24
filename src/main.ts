import { FastMCP } from "fastmcp";
import { z } from "zod";
import { join } from "path";
import { timingSafeEqual, createHash } from "crypto";
import { watch } from "fs";
import { readFile } from "fs/promises";
import { makeDeepLink } from "./deeplink.js";
import { mountPasswordAuth } from "./auth.js";
import { SearchIndex } from "./search.js";

// --- Configuration from environment ---
const VAULT_PATH = process.env.VAULT_PATH; // Local mode: path to vault directory
const COUCHDB_URL = process.env.COUCHDB_URL;
const COUCHDB_USER = process.env.COUCHDB_USER ?? "admin";
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD ?? "password";
const COUCHDB_DATABASE = process.env.COUCHDB_DATABASE ?? "obsidian";
const COUCHDB_PASSPHRASE = process.env.COUCHDB_PASSPHRASE || undefined;
const VAULT_NAME = process.env.VAULT_NAME ?? "MyVault";
const PORT = parseInt(process.env.PORT ?? "8787");
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

// --- Initialize vault (local or remote) ---
interface VaultBackend {
    init(): Promise<void>;
    close(): Promise<void>;
    readNote(path: string): Promise<string | null>;
    writeNote(path: string, content: string): Promise<boolean>;
    deleteNote(path: string): Promise<boolean>;
    moveNote(from: string, to: string): Promise<boolean>;
    getMetadata(path: string): Promise<{ path: string; size: number; ctime: number; mtime: number; frontmatter: Record<string, any>; tags: string[]; links: string[] } | null>;
    listNotes(folder?: string): Promise<string[]>;
    searchVault(query: string): Promise<Array<{ path: string; snippet: string }>>;
}

let vault: VaultBackend;

if (VAULT_PATH) {
    const { LocalVault } = await import("./vault-local.js");
    vault = new LocalVault(VAULT_PATH);
    console.log(`Local mode: ${VAULT_PATH}`);
} else if (COUCHDB_URL) {
    const { Vault } = await import("./vault.js");
    vault = new Vault({
        couchdbUrl: COUCHDB_URL,
        couchdbUser: COUCHDB_USER,
        couchdbPassword: COUCHDB_PASSWORD,
        database: COUCHDB_DATABASE,
        passphrase: COUCHDB_PASSPHRASE,
    });
    console.log(`Remote mode: ${COUCHDB_URL}`);
} else {
    console.error("Set VAULT_PATH for local mode or COUCHDB_URL for remote mode.");
    process.exit(1);
}

await vault.init();
console.log("Vault ready.");

// --- Per-vault data directory ---
const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
const vaultId = createHash("sha256").update(VAULT_PATH ?? COUCHDB_URL ?? "default").digest("hex").slice(0, 12);
const dataDir = join(homeDir, ".obsidian-mcp", vaultId);

// --- Search index ---
const indexPath = join(dataDir, "search-index.json");
const searchIndex = new SearchIndex(indexPath);

const loaded = await searchIndex.loadFromDisk();
if (!loaded) {
    const start = performance.now();
    const notes = await vault.listNotes();
    console.log(`Building search index (${notes.length} notes)...`);
    for (let i = 0; i < notes.length; i++) {
        const content = await vault.readNote(notes[i]);
        if (content) searchIndex.update(notes[i], content);
        if (notes.length > 100 && (i + 1) % 500 === 0) {
            console.log(`  indexed ${i + 1}/${notes.length}...`);
        }
    }
    console.log(`Search index built: ${searchIndex.size} notes in ${((performance.now() - start) / 1000).toFixed(1)}s`);
}

// --- Watch for external changes ---
let fsWatcher: ReturnType<typeof watch> | null = null;
if (VAULT_PATH) {
    // Local mode: watch filesystem for changes from Obsidian
    fsWatcher = watch(VAULT_PATH, { recursive: true }, async (event, filename) => {
        if (!filename || !filename.endsWith(".md")) return;
        // Normalize path separators
        const notePath = filename.replace(/\\/g, "/");
        try {
            const content = await readFile(join(VAULT_PATH!, notePath), "utf-8");
            searchIndex.update(notePath, content);
        } catch {
            // File deleted
            searchIndex.remove(notePath);
        }
    });
    console.log("Watching vault for external changes.");
} else if (COUCHDB_URL && "watchChanges" in vault) {
    // Remote mode: watch CouchDB _changes feed for LiveSync updates
    (vault as any).watchChanges((path: string, content: string | null) => {
        if (content) {
            searchIndex.update(path, content);
        } else {
            searchIndex.remove(path);
        }
    });
    console.log("Watching CouchDB for LiveSync changes.");
}

// --- MCP Server ---
const serverOptions: ConstructorParameters<typeof FastMCP>[0] = {
    name: "obsidian-sync-mcp",
    version: process.env.npm_package_version ?? "0.0.0",
    instructions: "Access and manage an Obsidian vault. You can read, write, list, search, and delete markdown notes. Every response includes a deep link to open the note directly in Obsidian.",
};

// Auth
import type { AuthHandle } from "./auth.js";
let auth: AuthHandle | null = null;

if (AUTH_TOKEN) {
    serverOptions.authenticate = async (req: any) => {
        const header = req.headers["authorization"] as string | undefined;
        // Accept static Bearer token (for curl, MCP Inspector, custom agents)
        const expected = `Bearer ${AUTH_TOKEN}`;
        if (header && header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected))) {
            return { authenticated: true };
        }
        // Accept OAuth-issued tokens (for Claude Web/Desktop/Mobile)
        if (auth?.validateToken(header)) {
            return { authenticated: true };
        }
        throw new Response("Unauthorized", { status: 401 });
    };
    console.log("Auth enabled (password-gated OAuth).");
} else {
    console.log("Auth disabled (set MCP_AUTH_TOKEN to enable).");
}

const server = new FastMCP(serverOptions);

if (AUTH_TOKEN) {
    const tokenPath = join(dataDir, "auth-tokens.json");
    auth = mountPasswordAuth(server.getApp(), BASE_URL, AUTH_TOKEN, tokenPath);
    await auth.loadTokens();
}

// --- Tools ---

server.addTool({
    name: "read_note",
    description:
        "Read the content of a note from the Obsidian vault. Returns the markdown content and a deep link to open it in Obsidian.",
    parameters: z.object({
        path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
    }),
    execute: async ({ path }) => {
        const content = await vault.readNote(path);
        if (content === null) {
            return `Note not found: ${path}`;
        }
        const deepLink = makeDeepLink(VAULT_NAME, path);
        return `${content}\n\n---\n[Open in Obsidian](${deepLink})`;
    },
});

server.addTool({
    name: "write_note",
    description:
        "Write or update a note in the Obsidian vault. Creates the note if it doesn't exist, overwrites if it does.",
    parameters: z.object({
        path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
        content: z.string().describe("Full markdown content for the note"),
    }),
    execute: async ({ path, content }) => {
        const ok = await vault.writeNote(path, content);
        if (!ok) {
            return `Failed to write note: ${path}`;
        }
        searchIndex.update(path, content);
        const deepLink = makeDeepLink(VAULT_NAME, path);
        return `Note saved: ${path}\n[Open in Obsidian](${deepLink})`;
    },
});

server.addTool({
    name: "list_notes",
    description: "List all markdown notes in the vault, optionally filtered to a folder.",
    parameters: z.object({
        folder: z
            .string()
            .optional()
            .describe("Folder to filter by, e.g. 'daily/' or 'projects/'. Omit for all notes."),
    }),
    execute: async ({ folder }) => {
        // Use search index for listing — works with encrypted vaults
        // where enumerateAllNormalDocs returns raw encrypted paths.
        // Falls back to vault.listNotes if index is empty (first startup before watcher runs).
        let notes = searchIndex.listPaths(folder);
        if (notes.length === 0) {
            notes = await vault.listNotes(folder);
        }
        if (notes.length === 0) {
            return folder ? `No notes found in folder: ${folder}` : "Vault is empty.";
        }
        const total = notes.length;
        const capped = notes.slice(0, 500);
        const lines = capped.map((p) => {
            const deepLink = makeDeepLink(VAULT_NAME, p);
            return `- [${p}](${deepLink})`;
        });
        if (total > 500) {
            lines.push(`\n... and ${total - 500} more. Use a folder filter to narrow results.`);
        }
        return lines.join("\n");
    },
});

server.addTool({
    name: "search_vault",
    description: "Search for a text query across all notes in the vault. Returns matching notes with snippets.",
    parameters: z.object({
        query: z.string().describe("Text to search for (case-insensitive)"),
    }),
    execute: async ({ query }) => {
        const results = searchIndex.search(query);
        if (results.length === 0) {
            return `No results for: ${query}`;
        }
        const lines = results.map((r) => {
            const deepLink = makeDeepLink(VAULT_NAME, r.path);
            return `### [${r.path}](${deepLink})\n\`\`\`\n${r.snippet}\n\`\`\``;
        });
        return lines.join("\n\n");
    },
});

server.addTool({
    name: "delete_note",
    description: "Delete a note from the Obsidian vault.",
    parameters: z.object({
        path: z.string().describe("Vault-relative path to the note to delete"),
    }),
    execute: async ({ path }) => {
        const ok = await vault.deleteNote(path);
        if (ok) searchIndex.remove(path);
        return ok ? `Deleted: ${path}` : `Failed to delete: ${path}`;
    },
});

server.addTool({
    name: "move_note",
    description:
        "Move or rename a note. Use this to rename a note within the same folder, move it to a different folder, or both at once. Creates destination folders automatically.",
    parameters: z.object({
        from: z.string().describe("Current path, e.g. 'daily/old-name.md'"),
        to: z.string().describe("New path, e.g. 'projects/new-name.md'"),
    }),
    execute: async ({ from, to }) => {
        const content = await vault.readNote(from);
        const ok = await vault.moveNote(from, to);
        if (!ok) {
            return `Failed to move: ${from} → ${to}`;
        }
        searchIndex.remove(from);
        if (content) searchIndex.update(to, content);
        const deepLink = makeDeepLink(VAULT_NAME, to);
        return `Moved: ${from} → ${to}\n[Open in Obsidian](${deepLink})`;
    },
});

server.addTool({
    name: "get_note_metadata",
    description:
        "Get metadata about a note without reading its full content. Returns frontmatter properties, tags (both frontmatter and inline #tags), internal links ([[wikilinks]] and markdown links), file size, and timestamps.",
    parameters: z.object({
        path: z.string().describe("Vault-relative path to the note, e.g. 'projects/my-project.md'"),
    }),
    execute: async ({ path }) => {
        const meta = await vault.getMetadata(path);
        if (!meta) {
            return `Note not found: ${path}`;
        }
        const deepLink = makeDeepLink(VAULT_NAME, path);
        const lines = [
            `**${path}**`,
            `Size: ${meta.size} bytes`,
            `Created: ${new Date(meta.ctime).toISOString()}`,
            `Modified: ${new Date(meta.mtime).toISOString()}`,
        ];
        if (Object.keys(meta.frontmatter).length > 0) {
            lines.push(`\nFrontmatter:`);
            for (const [k, v] of Object.entries(meta.frontmatter)) {
                lines.push(`  ${k}: ${v}`);
            }
        }
        if (meta.tags.length > 0) {
            lines.push(`\nTags: ${meta.tags.map((t) => `#${t}`).join(", ")}`);
        }
        if (meta.links.length > 0) {
            lines.push(`\nLinks: ${meta.links.join(", ")}`);
        }
        lines.push(`\n[Open in Obsidian](${deepLink})`);
        return lines.join("\n");
    },
});

// --- Graceful shutdown ---
async function shutdown() {
    console.log("Shutting down...");
    if (fsWatcher) fsWatcher.close();
    await searchIndex.saveToDisk();
    if (auth) await auth.saveTokens();
    await vault.close();
    process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- Periodic save (every 5 minutes) ---
setInterval(async () => {
    await searchIndex.saveToDisk();
    if (auth) await auth.saveTokens();
}, 5 * 60 * 1000).unref();

// --- Start server ---
server.start({
    transportType: "httpStream",
    httpStream: { port: PORT, endpoint: "/mcp" },
});
console.log(`MCP server listening on port ${PORT}`);
