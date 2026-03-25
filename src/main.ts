import { FastMCP } from "fastmcp";
import { join } from "path";
import { timingSafeEqual, createHash } from "crypto";
import { watch } from "fs";
import { readFile, stat } from "fs/promises";
import { mountPasswordAuth } from "./auth.js";
import { SearchIndex } from "./search.js";
import { registerTools } from "./tools.js";

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
import type { VaultBackend } from "./vault-backend.js";

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
const baseDataDir = process.env.DATA_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".obsidian-mcp");
const vaultId = createHash("sha256").update(VAULT_PATH ?? COUCHDB_URL ?? "default").digest("hex").slice(0, 12);
const dataDir = join(baseDataDir, vaultId);

// --- Search index ---
const indexPath = join(dataDir, "search-index.json");
const searchIndex = new SearchIndex(indexPath, COUCHDB_PASSPHRASE);

// Load metadata (paths + mtimes) from disk, then rebuild FlexSearch index
await searchIndex.loadFromDisk();
const start = performance.now();
const notesWithMtime = await vault.listNotesWithMtime();
if (notesWithMtime.length > 0) {
    console.log(`Building search index (${notesWithMtime.length} notes)...`);
    for (let i = 0; i < notesWithMtime.length; i++) {
        const { path, mtime } = notesWithMtime[i];
        const content = await vault.readNote(path);
        if (content) searchIndex.update(path, content, mtime);
        if (notesWithMtime.length > 100 && (i + 1) % 500 === 0) {
            console.log(`  indexed ${i + 1}/${notesWithMtime.length}...`);
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
            const fullPath = join(VAULT_PATH!, notePath);
            const [content, s] = await Promise.all([readFile(fullPath, "utf-8"), stat(fullPath)]);
            searchIndex.update(notePath, content, s.mtimeMs);
        } catch {
            // File deleted
            searchIndex.remove(notePath);
        }
    });
    console.log("Watching vault for external changes.");
} else if (COUCHDB_URL && vault.watchChanges) {
    // Remote mode: watch CouchDB _changes feed for LiveSync updates
    vault.watchChanges((path: string, content: string | null, mtime?: number) => {
        if (content) {
            searchIndex.update(path, content, mtime);
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
    instructions: "Access and manage an Obsidian vault. You can read, write, list, search, move, and delete markdown notes. Every tool response includes an Obsidian deep link. Always show this link to the user using the format [obsidian://open?vault=...&file=...](obsidian://open?vault=...&file=...) so it is both clickable and visible as a URL.",
};

// Auth
import type { AuthHandle } from "./auth.js";
let auth: AuthHandle | null = null;

if (AUTH_TOKEN) {
    serverOptions.authenticate = async (req: import("http").IncomingMessage) => {
        const header = req.headers["authorization"];
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
registerTools(server, vault, searchIndex, VAULT_NAME);

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
    httpStream: { port: PORT, endpoint: "/mcp", host: process.env.HOST ?? "0.0.0.0" },
});
console.log(`MCP server listening on port ${PORT}`);
