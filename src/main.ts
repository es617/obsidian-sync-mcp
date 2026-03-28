import { FastMCP } from "fastmcp";
import { join } from "path";
import { timingSafeEqual, createHash } from "crypto";
import { watch } from "fs";
import { stat } from "fs/promises";
import { setGlobalLogFunction, LEVEL_INFO } from "octagonal-wheels/common/logger";
import { mountPasswordAuth } from "./auth.js";
import { SearchIndex } from "./search.js";
import { registerTools } from "./tools.js";

// Suppress livesync-commonlib logs that expose vault file paths in production.
// Set LOG_LEVEL=debug to see all library logs during development.
const debugLogging = process.env.LOG_LEVEL === "debug";
setGlobalLogFunction((message, level = LEVEL_INFO) => {
    if (level < LEVEL_INFO) return;
    if (!debugLogging && typeof message === "string") {
        if (/^(GET|PUT|DELETE|WATCH|FOLLOW|Sensible merge|Object merge):/.test(message)) return;
        if (message.includes("replicator") || message.includes("Replicator") || message.includes("ReplicatorService")) return;
    }
    console.log(message);
});

// --- Configuration from environment ---
const VAULT_PATH = process.env.VAULT_PATH; // Local mode: path to vault directory
const COUCHDB_URL = process.env.COUCHDB_URL;
const COUCHDB_USER = process.env.COUCHDB_USER ?? "admin";
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD;
const COUCHDB_DATABASE = process.env.COUCHDB_DATABASE ?? "obsidian";
const COUCHDB_PASSPHRASE = process.env.COUCHDB_PASSPHRASE || undefined;
const COUCHDB_OBFUSCATE_PROPERTIES = process.env.COUCHDB_OBFUSCATE_PROPERTIES === "true";
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
    if (!COUCHDB_PASSWORD) {
        console.error("COUCHDB_PASSWORD is required in remote mode.");
        process.exit(1);
    }
    const { Vault } = await import("./vault.js");
    vault = new Vault({
        couchdbUrl: COUCHDB_URL,
        couchdbUser: COUCHDB_USER,
        couchdbPassword: COUCHDB_PASSWORD,
        database: COUCHDB_DATABASE,
        passphrase: COUCHDB_PASSPHRASE,
        obfuscatePaths: COUCHDB_OBFUSCATE_PROPERTIES,
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
const vaultId = createHash("sha256").update(VAULT_NAME).digest("hex").slice(0, 12);
const dataDir = join(baseDataDir, vaultId);

// --- Search index ---
const indexPath = join(dataDir, "search-index.json");
const searchIndex = new SearchIndex(indexPath, COUCHDB_PASSPHRASE);

// Load persisted metadata from disk
await searchIndex.loadFromDisk();
if (debugLogging) {
    console.log(`[debug] Persisted metadata: ${searchIndex.size} notes, since: ${searchIndex.since || "(none)"}`);
}

// Sync metadata in background (server starts immediately)
async function rebuildIndex() {
    const start = performance.now();

    if (COUCHDB_URL && vault.catchUp) {
        const changeCallback = (path: string, content: string | null, mtime?: number) => {
            if (content) {
                searchIndex.update(path, content, mtime);
            } else {
                searchIndex.remove(path);
            }
        };

        let since = searchIndex.since || "0";
        if (debugLogging) console.log(`[debug] CouchDB catch-up from since: ${since}`);
        let changes = 0;
        const onBatch = async (batchSince: string, processed: number) => {
            searchIndex.since = batchSince;
            await searchIndex.saveToDisk();
            console.log(`  checkpoint: ${processed} changes processed, ${searchIndex.size} notes indexed.`);
        };
        try {
            const countingCallback = (path: string, content: string | null, mtime?: number) => {
                changes++;
                if (debugLogging) console.log(`[debug] Change: ${path} ${content ? "(update)" : "(delete)"}`);
                changeCallback(path, content, mtime);
            };
            const newSince = await vault.catchUp(since, countingCallback, onBatch);
            searchIndex.since = newSince;
        } catch (err) {
            console.warn(`Catch-up failed (${err}), rebuilding index from scratch...`);
            searchIndex.clear();
            changes = 0;
            const newSince = await vault.catchUp("0", (path, content, mtime) => {
                changes++;
                changeCallback(path, content, mtime);
            }, onBatch);
            searchIndex.since = newSince;
        }
        if (changes > 0) {
            console.log(`Search index synced: ${changes} changes in ${((performance.now() - start) / 1000).toFixed(1)}s (${searchIndex.size} notes).`);
        } else {
            console.log(`Search index up to date (${searchIndex.size} notes).`);
        }
    } else if (VAULT_PATH) {
        const notesWithMtime = await vault.listNotesWithMtime();
        if (debugLogging) console.log(`[debug] Vault has ${notesWithMtime.length} notes`);
        if (notesWithMtime.length > 0) {
            const vaultPaths = new Set(notesWithMtime.map((n) => n.path));
            for (const p of searchIndex.listPaths()) {
                if (!vaultPaths.has(p)) searchIndex.remove(p);
            }
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
    }
    await searchIndex.saveToDisk();
}
// Fire and forget — server starts while index builds
rebuildIndex().catch((err) => console.error("Index rebuild failed:", err));

// --- Watch for external changes ---
let fsWatcher: ReturnType<typeof watch> | null = null;
if (VAULT_PATH) {
    // Local mode: watch filesystem for changes from Obsidian
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    fsWatcher = watch(VAULT_PATH, { recursive: true }, (event, filename) => {
        if (!filename || !filename.endsWith(".md")) return;
        const notePath = filename.replace(/\\/g, "/");
        if (notePath.startsWith(".obsidian/") || notePath.includes("/.obsidian/")) return;

        // Debounce: coalesce rapid events for the same file (Obsidian fires 2-3 per save)
        if (pending.has(notePath)) clearTimeout(pending.get(notePath)!);
        pending.set(notePath, setTimeout(() => handleFileChange(notePath), 100));
    });

    async function handleFileChange(notePath: string) {
        pending.delete(notePath);
        try {
            const content = await vault.readNote(notePath);
            if (content !== null) {
                const s = await stat(join(VAULT_PATH!, notePath));
                searchIndex.update(notePath, content, s.mtimeMs);
            } else {
                searchIndex.remove(notePath);
            }
        } catch {
            // File deleted or path blocked by safePath
            searchIndex.remove(notePath);
        }
    }
    console.log("Watching vault for external changes.");
} else if (COUCHDB_URL && vault.watchChanges) {
    // Remote mode: watch CouchDB _changes feed for LiveSync updates
    vault.watchChanges((path: string, content: string | null, mtime?: number, seq?: string | number) => {
        if (content) {
            if (debugLogging) console.log(`[debug] CouchDB change: ${path} (mtime: ${mtime})`);
            searchIndex.update(path, content, mtime);
        } else {
            if (debugLogging) console.log(`[debug] CouchDB delete: ${path}`);
            searchIndex.remove(path);
        }
        if (seq) searchIndex.since = String(seq);
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
    const host = process.env.HOST ?? "0.0.0.0";
    if (host === "0.0.0.0") {
        console.warn("WARNING: No authentication and listening on all interfaces. Set MCP_AUTH_TOKEN or HOST=127.0.0.1.");
    } else {
        console.log("Auth disabled (set MCP_AUTH_TOKEN to enable).");
    }
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
    if (auth) {
        auth.cleanup();
        await auth.saveTokens();
    }
}, 5 * 60 * 1000).unref();

// --- Start server ---
server.start({
    transportType: "httpStream",
    httpStream: { port: PORT, endpoint: "/mcp", host: process.env.HOST ?? "0.0.0.0" },
});
console.log(`obsidian-sync-mcp v${process.env.npm_package_version ?? "unknown"} listening on port ${PORT}`);

// Prevent unhandled rejections from crashing the server (e.g. decryption failures in watcher)
process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
});
