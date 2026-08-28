import { FastMCP } from "fastmcp";
import { join } from "path";
import { timingSafeEqual, createHash } from "crypto";
import { watch, readFileSync, statSync } from "fs";
import { realpath, stat } from "fs/promises";
import { setGlobalLogFunction, LEVEL_INFO } from "octagonal-wheels/common/logger";
import { mountPasswordAuth } from "./auth.js";
import { planFilesystemIndexSync, SearchIndex } from "./search.js";
import { applyIndexChange } from "./index-sync.js";
import { startAfterSuccessfulRebuild } from "./index-lifecycle.js";
import {
    deriveFullTextIndexKey,
    deriveSearchBackendId,
    FullTextIndex,
    resolveFullTextSearchSetting,
    searchIndexStoragePaths,
    type FullTextSearchSetting,
} from "./full-text-search.js";
import { buildAllowedHosts, isHostAllowed, isOriginAllowed } from "./host-guard.js";
import { registerTools } from "./tools.js";
import { parseWriteFolders } from "./write-scope.js";

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
const READ_ONLY = process.env.READ_ONLY === "true";
const WRITE_FOLDERS = parseWriteFolders(process.env.WRITE_FOLDERS);
const FULL_TEXT_SEARCH = process.env.FULL_TEXT_SEARCH;

// Extra instructions appended to the MCP `instructions` string.
// File wins if both are set (loud warning); missing file is fatal.
const MCP_INSTRUCTIONS_FILE = process.env.MCP_INSTRUCTIONS_FILE?.trim() || undefined;
const MCP_INSTRUCTIONS_ENV = process.env.MCP_INSTRUCTIONS?.trim() || undefined;
let MCP_EXTRA_INSTRUCTIONS: string | undefined;
const MCP_INSTRUCTIONS_MAX_BYTES = 32 * 1024;
if (MCP_INSTRUCTIONS_FILE) {
    try {
        const size = statSync(MCP_INSTRUCTIONS_FILE).size;
        if (size > MCP_INSTRUCTIONS_MAX_BYTES) {
            throw new Error(`file is ${size} bytes, exceeds ${MCP_INSTRUCTIONS_MAX_BYTES} byte cap`);
        }
        MCP_EXTRA_INSTRUCTIONS = readFileSync(MCP_INSTRUCTIONS_FILE, "utf8").trim() || undefined;
    } catch (err) {
        console.error(`Failed to read MCP_INSTRUCTIONS_FILE (${MCP_INSTRUCTIONS_FILE}): ${(err as Error).message}`);
        process.exit(1);
    }
    if (MCP_INSTRUCTIONS_ENV) {
        console.warn("MCP_INSTRUCTIONS_FILE is set; ignoring MCP_INSTRUCTIONS env var.");
    }
} else if (MCP_INSTRUCTIONS_ENV) {
    MCP_EXTRA_INSTRUCTIONS = MCP_INSTRUCTIONS_ENV;
}

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

// --- Per-backend data directory ---
const baseDataDir = process.env.DATA_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".obsidian-mcp");
// OAuth persistence stays at its established path; changing search identity
// must not force unrelated clients to reauthenticate.
const authDataDir = join(
    baseDataDir,
    createHash("sha256").update(VAULT_NAME).digest("hex").slice(0, 12),
);
const backendId = VAULT_PATH
    ? deriveSearchBackendId({ kind: "filesystem", location: await realpath(VAULT_PATH) })
    : deriveSearchBackendId({ kind: "couchdb", url: COUCHDB_URL!, database: COUCHDB_DATABASE });
const { indexPath, legacyIndexPath } = searchIndexStoragePaths(baseDataDir, backendId, VAULT_NAME);

// --- Search indexes ---
let fullTextSetting: FullTextSearchSetting;
try {
    fullTextSetting = resolveFullTextSearchSetting(
        FULL_TEXT_SEARCH,
        Boolean(COUCHDB_URL && COUCHDB_PASSPHRASE),
    );
} catch (error) {
    console.error((error as Error).message);
    process.exit(1);
}

let fullTextIndex: FullTextIndex | undefined;
let fullTextPath: string | undefined;
if (fullTextSetting.enabled) {
    // v2 intentionally uses a new file. The v1 database remains available if
    // the operator rolls back to the previous Docker tag.
    fullTextPath = indexPath;
    let unverifiableLegacyIndex = false;
    try {
        await stat(legacyIndexPath);
        unverifiableLegacyIndex = legacyIndexPath !== fullTextPath;
    } catch {
        // No VAULT_NAME-scoped prototype index to report.
    }
    const encryptionKey = fullTextSetting.encryptIndex
        ? deriveFullTextIndexKey(COUCHDB_PASSPHRASE!, backendId)
        : undefined;
    try {
        fullTextIndex = await FullTextIndex.open(fullTextPath, {
            encryptionKey,
            backendIdentity: backendId,
        });
    } finally {
        encryptionKey?.fill(0);
    }
    if (fullTextIndex.migratedFromPlaintext) {
        console.warn(
            "Migrated the existing plaintext full-text index to encrypted storage. " +
            "Old backups or filesystem snapshots may still contain the plaintext copy.",
        );
    }
    if (fullTextIndex.recreatedForSchemaMismatch) {
        console.warn("Archived an incompatible search index and started a clean v2 rebuild.");
    }
    if (fullTextIndex.recreatedForIdentityMismatch) {
        console.warn("Archived a search index owned by a different backend and started a clean rebuild.");
    }
    if (fullTextIndex.createdFresh && unverifiableLegacyIndex) {
        console.warn(
            "Found a legacy VAULT_NAME-scoped search index. It was left intact but not reused " +
            "because its backend identity and checkpoint cannot be verified; rebuilding once.",
        );
    }
    console.log(
        `Full-text search enabled (local index contains ${fullTextIndex.size} notes, ` +
        `${fullTextIndex.encryptedAtRest ? "encrypted" : "plaintext"}).`,
    );
}

const searchIndex = new SearchIndex(fullTextIndex);

// Sync metadata in background (server starts immediately)
async function rebuildIndex() {
    const start = performance.now();

    if (COUCHDB_URL && vault.catchUp) {
        searchIndex.setBuildStatus("catching_up", 0, undefined, "Catching up with CouchDB changes.");
        const changeCallback = (path: string, content: string | null, mtime?: number) => {
            // content === "" is an empty-but-present note: index it, don't drop it.
            applyIndexChange(searchIndex, path, content, mtime);
        };

        let since = searchIndex.since || "0";
        if (debugLogging) console.log(`[debug] CouchDB catch-up from since: ${since}`);
        let changes = 0;
        const catchUpBatched = async (
            from: string,
            callback: (path: string, content: string | null, mtime?: number) => void,
        ) => {
            searchIndex.beginBatch();
            try {
                const result = await vault.catchUp!(from, callback, async (batchSince, processed) => {
                    // The checkpoint and indexed changes commit atomically.
                    searchIndex.since = batchSince;
                    searchIndex.commitBatch();
                    searchIndex.setBuildStatus("catching_up", processed);
                    console.log(`  checkpoint: ${processed} changes processed, ${searchIndex.size} notes indexed.`);
                    await new Promise<void>((resolve) => setImmediate(resolve));
                    searchIndex.beginBatch();
                });
                searchIndex.commitBatch();
                return result;
            } catch (error) {
                searchIndex.rollbackBatch();
                throw error;
            }
        };
        try {
            const countingCallback = (path: string, content: string | null, mtime?: number) => {
                changes++;
                if (debugLogging) console.log(`[debug] Change: ${path} ${content !== null ? "(update)" : "(delete)"}`);
                changeCallback(path, content, mtime);
            };
            const newSince = await catchUpBatched(since, countingCallback);
            searchIndex.since = newSince;
        } catch (err) {
            console.warn(`Catch-up failed (${err}), rebuilding index from scratch...`);
            searchIndex.clear();
            changes = 0;
            const newSince = await catchUpBatched("0", (path, content, mtime) => {
                changes++;
                changeCallback(path, content, mtime);
            });
            searchIndex.since = newSince;
        }
        if (changes > 0) {
            console.log(`Search index synced: ${changes} changes in ${((performance.now() - start) / 1000).toFixed(1)}s (${searchIndex.size} notes).`);
        } else {
            console.log(`Search index up to date (${searchIndex.size} notes).`);
        }
    } else if (VAULT_PATH) {
        searchIndex.setBuildStatus("building", 0, undefined, "Scanning local vault notes.");
        const notesWithMtime = await vault.listNotesWithMtime();
        if (debugLogging) console.log(`[debug] Vault has ${notesWithMtime.length} notes`);
        const plan = planFilesystemIndexSync(searchIndex.listWithMtime(), notesWithMtime);
        searchIndex.setBuildStatus("building", 0, plan.read.length, "Indexing changed local vault notes.");
        for (const path of plan.remove) searchIndex.remove(path);
        if (plan.read.length > 0) {
            console.log(
                `Updating search index (${plan.read.length} changed, ${plan.unchanged} unchanged, ` +
                `${plan.remove.length} deleted)...`,
            );
            searchIndex.beginBatch();
            try {
                for (let i = 0; i < plan.read.length; i++) {
                    const { path, mtime } = plan.read[i];
                    const content = await vault.readNote(path);
                    // Index empty notes too (content === ""); readNote returns null only if absent.
                    if (content !== null) searchIndex.update(path, content, mtime);
                    else searchIndex.remove(path);
                    searchIndex.setBuildStatus("building", i + 1, plan.read.length);
                    if (plan.read.length > 100 && (i + 1) % 500 === 0) {
                        searchIndex.commitBatch();
                        console.log(`  indexed ${i + 1}/${plan.read.length} changed notes...`);
                        await new Promise<void>((resolve) => setImmediate(resolve));
                        searchIndex.beginBatch();
                    }
                }
                searchIndex.commitBatch();
            } catch (error) {
                searchIndex.rollbackBatch();
                throw error;
            }
            console.log(`Search index updated: ${searchIndex.size} notes in ${((performance.now() - start) / 1000).toFixed(1)}s`);
        } else {
            console.log(
                `Search index up to date (${searchIndex.size} notes; ${plan.remove.length} stale entries removed).`,
            );
        }
    }
    searchIndex.setBuildStatus("ready", searchIndex.size, searchIndex.size);
}
// Fire and forget — server starts while index builds.
const rebuildPromise = rebuildIndex();
void rebuildPromise.catch((err) => {
    searchIndex.setBuildStatus("error", searchIndex.status.processed, searchIndex.status.total, String(err));
    console.error("Index rebuild failed:", err);
});

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
    // Start the live feed only after catch-up closes its final transaction. The
    // feed resumes from Vault's last sequence, so changes during catch-up are
    // not lost and cannot advance the checkpoint out of order.
    void startAfterSuccessfulRebuild(rebuildPromise, () => {
        vault.watchChanges!((path: string, content: string | null, mtime?: number, seq?: string | number) => {
            if (debugLogging) console.log(`[debug] CouchDB ${content === null ? "delete" : "change"}: ${path}`);
            searchIndex.beginBatch();
            try {
                applyIndexChange(searchIndex, path, content, mtime);
                if (seq) searchIndex.since = String(seq);
                searchIndex.commitBatch();
            } catch (error) {
                searchIndex.rollbackBatch();
                throw error;
            }
        });
        console.log("Watching CouchDB for LiveSync changes.");
    }).catch((error) => {
        console.error("Failed to start CouchDB change watcher:", error);
    });
}

// --- MCP Server ---
const BASE_INSTRUCTIONS = "Access and manage an Obsidian vault. You can read, write, list, search, move, and delete markdown notes. Every tool response includes an Obsidian deep link. Always show this link to the user using the format [obsidian://open?vault=...&file=...](obsidian://open?vault=...&file=...) so it is both clickable and visible as a URL.";
const serverOptions: ConstructorParameters<typeof FastMCP>[0] = {
    name: "obsidian-sync-mcp",
    version: process.env.npm_package_version ?? "0.0.0",
    instructions: MCP_EXTRA_INSTRUCTIONS ? `${BASE_INSTRUCTIONS}\n\n${MCP_EXTRA_INSTRUCTIONS}` : BASE_INSTRUCTIONS,
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
        // RFC 9728: point strict clients (e.g. Gemini) at the resource
        // metadata; Claude probes /.well-known directly but others rely on this.
        throw new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"` },
        });
    };
    console.log("Auth enabled (password-gated OAuth).");
} else {
    // No token: enforce a Host-header allowlist so the "local only" precondition
    // actually holds. Without this, DNS rebinding lets any website the operator
    // visits reach the tool surface (CWE-350) even on a loopback bind, because
    // the browser still sends the attacker's hostname in Host. Defaults to
    // localhost; MCP_ALLOWED_HOSTS extends it for legit LAN/private-network use.
    const allowedHosts = buildAllowedHosts(process.env.MCP_ALLOWED_HOSTS);
    serverOptions.authenticate = async (req: import("http").IncomingMessage) => {
        // Host check defeats DNS rebinding; Origin check defeats a direct
        // cross-origin browser fetch to loopback (the transport sends wildcard CORS).
        if (!isHostAllowed(req.headers["host"], allowedHosts)) {
            throw new Response("Forbidden: Host not allowed", { status: 403 });
        }
        if (!isOriginAllowed(req.headers["origin"], allowedHosts)) {
            throw new Response("Forbidden: cross-origin request rejected", { status: 403 });
        }
        return { authenticated: true };
    };
    console.log(`Auth disabled — accepting only local Host/Origin headers: ${[...allowedHosts].join(", ")}. Set MCP_ALLOWED_HOSTS to add hosts, or MCP_AUTH_TOKEN for authenticated remote access.`);
    const host = process.env.HOST ?? "0.0.0.0";
    if (host === "0.0.0.0") {
        console.warn("WARNING: No authentication and listening on all interfaces. Browser attacks (DNS rebinding and cross-origin fetch) are blocked by the Host/Origin checks, but any non-browser client that can reach this port has full vault access. Set MCP_AUTH_TOKEN, or HOST=127.0.0.1 to bind to loopback only.");
    }
}

const server = new FastMCP(serverOptions);

if (AUTH_TOKEN) {
    const tokenPath = join(authDataDir, "auth-tokens.json");
    auth = mountPasswordAuth(server.getApp(), BASE_URL, AUTH_TOKEN, tokenPath);
    await auth.loadTokens();
}

// --- Tools ---
registerTools(server, vault, searchIndex, VAULT_NAME, READ_ONLY, WRITE_FOLDERS);

// --- Graceful shutdown ---
async function shutdown() {
    console.log("Shutting down...");
    if (fsWatcher) fsWatcher.close();
    searchIndex.close();
    if (auth) await auth.saveTokens();
    await vault.close();
    process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- Periodic auth-token cleanup ---
setInterval(async () => {
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
