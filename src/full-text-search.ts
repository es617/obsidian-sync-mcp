/** Encrypted, disk-backed, PKB-aware search for vault notes. */

import { chmod, mkdir, open as openFile, rename } from "fs/promises";
import { basename, dirname, join } from "path";
import { createHash, hkdfSync, scryptSync } from "node:crypto";
import Database from "better-sqlite3-multiple-ciphers";
import { chunkMarkdown } from "./markdown-chunker.js";
import { parseFrontmatterAndLinks } from "./parse.js";

export type FullTextSearchMode = "all" | "any" | "phrase";
export interface FullTextSearchOptions {
    query: string;
    folder?: string;
    tag?: string;
    modifiedAfter?: number;
    mode?: FullTextSearchMode;
    limit?: number;
}
export interface FullTextSearchResult {
    path: string;
    mtime: number;
    rank: number;
    snippet: string;
    heading?: string;
    breadcrumb?: string;
    matchedBy?: "exact" | "metadata" | "passage";
}
export interface FullTextSearchSetting { enabled: boolean; encryptIndex: boolean }
export interface FullTextIndexOptions {
    encryptionKey?: Buffer;
    /** HKDF-only key used by the first encrypted-index prototype. Migration only. */
    legacyEncryptionKey?: Buffer;
    /** Opaque hash of the backing filesystem root or CouchDB database. */
    backendIdentity?: string;
}

export type SearchBackendIdentity =
    | { kind: "filesystem"; location: string }
    | { kind: "couchdb"; url: string; database: string };

/**
 * Derive an opaque, stable identity from the backend that owns the notes.
 * VAULT_NAME is intentionally absent: it is presentation metadata and is not
 * sufficient to isolate persisted results or CouchDB checkpoints.
 */
export function deriveSearchBackendId(backend: SearchBackendIdentity): string {
    let canonical: string;
    if (backend.kind === "filesystem") {
        canonical = `filesystem\0${backend.location.replace(/\\/g, "/").replace(/\/+$/, "") || "/"}`;
    } else {
        const url = new URL(backend.url);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        url.pathname = url.pathname.replace(/\/+$/, "") || "/";
        canonical = `couchdb\0${url.toString()}\0${backend.database}`;
    }
    return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function searchIndexStoragePaths(baseDataDir: string, backendId: string, vaultName: string) {
    const legacyVaultId = createHash("sha256").update(vaultName).digest("hex").slice(0, 12);
    return {
        dataDir: join(baseDataDir, "backends", backendId),
        indexPath: join(baseDataDir, "backends", backendId, "full-text-index-v2.sqlite"),
        // Detection only. This path is never reused because it has no verifiable backend identity.
        legacyIndexPath: join(baseDataDir, legacyVaultId, "full-text-index-v2.sqlite"),
    };
}

const SCHEMA_VERSION = 2;
const CANDIDATE_LIMIT = 200;
const EXACT_WEIGHT = 12;
// Prefix matches exist for partial-word queries the FTS lanes cannot serve at
// all; when a full word matches a title, the metadata lane already ranks it.
// Keeping this below PASSAGE_WEIGHT stops a broad title/path prefix (e.g.
// "meeting" against a Meetings/ folder) from drowning genuine body relevance.
const EXACT_PREFIX_WEIGHT = 2;
const METADATA_WEIGHT = 5;
const PASSAGE_WEIGHT = 3;
const INDEX_KDF_SCRYPT_OPTIONS = {
    N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
} as const;

function queryTokens(value: string): string[] {
    return value.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [];
}
function quotePhrase(tokens: string[]): string {
    return `"${tokens.join(" ").replaceAll('"', '""')}"`;
}
export function buildFtsQuery(query: string, mode: FullTextSearchMode = "all"): string {
    const tokens = queryTokens(query);
    if (tokens.length === 0) throw new Error("Search query must contain at least one letter or number.");
    return mode === "phrase"
        ? quotePhrase(tokens)
        : tokens.map((token) => quotePhrase([token])).join(mode === "any" ? " OR " : " AND ");
}
export function resolveFullTextSearchSetting(
    raw: string | undefined,
    encryptedRemoteVault: boolean,
): FullTextSearchSetting {
    const value = raw?.trim().toLowerCase() || "auto";
    if (!["auto", "true", "false"].includes(value)) {
        throw new Error("FULL_TEXT_SEARCH must be 'auto', 'true', or 'false'.");
    }
    const enabled = value !== "false";
    return { enabled, encryptIndex: enabled && encryptedRemoteVault };
}
export function deriveLegacyFullTextIndexKey(passphrase: string, vaultId: string): Buffer {
    return Buffer.from(hkdfSync(
        "sha256", Buffer.from(passphrase, "utf8"), Buffer.from(vaultId, "utf8"),
        Buffer.from("obsidian-sync-mcp/full-text-index/v1", "utf8"), 32,
    ));
}
export function deriveFullTextIndexKey(passphrase: string, vaultId: string): Buffer {
    const vaultKey = scryptSync(
        Buffer.from(passphrase, "utf8"),
        Buffer.from(`obsidian-sync-mcp/vault-kdf/v1/${vaultId}`, "utf8"),
        32,
        INDEX_KDF_SCRYPT_OPTIONS,
    );
    try {
        return Buffer.from(hkdfSync(
            "sha256", vaultKey, Buffer.from(vaultId, "utf8"),
            Buffer.from("obsidian-sync-mcp/full-text-index/v2", "utf8"), 32,
        ));
    } finally {
        vaultKey.fill(0);
    }
}

async function hasPlaintextSqliteHeader(path: string): Promise<boolean> {
    try {
        const file = await openFile(path, "r");
        try {
            const header = Buffer.alloc(16);
            const { bytesRead } = await file.read(header, 0, header.length, 0);
            return bytesRead === header.length && header.equals(Buffer.from("SQLite format 3\0", "binary"));
        } finally { await file.close(); }
    } catch { return false; }
}
function normalizeLookup(value: string): string {
    return value.normalize("NFKC").toLocaleLowerCase("en-US")
        .replace(/\.md$/i, "").replace(/[_-]+/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
function pathAsText(path: string): string {
    return path.replace(/\.md$/i, "").replace(/[\\/_-]+/g, " ");
}
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, "\\$&"); }
function normalizeSnippet(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function extractSearchFields(path: string, content: string) {
    const metadata = parseFrontmatterAndLinks(content);
    const firstHeading = content.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
    const title = firstHeading || basename(path, ".md");
    return {
        title,
        titleNorm: normalizeLookup(title),
        basenameNorm: normalizeLookup(basename(path, ".md")),
        pathNorm: normalizeLookup(path),
        pathText: pathAsText(path),
        aliases: metadata.aliases,
        tags: metadata.tags,
        links: metadata.links,
        linkLabels: metadata.linkLabels,
        chunks: chunkMarkdown(content),
        contentHash: createHash("sha256").update(content).digest("hex"),
    };
}
interface Candidate {
    path: string;
    mtime: number;
    score: number;
    snippet: string;
    heading?: string;
    breadcrumb?: string;
    matchedBy: "exact" | "metadata" | "passage";
    snippetPriority: number;
}

export class FullTextIndex {
    private db: Database.Database;
    private statements = new Map<string, Database.Statement>();
    private batchOpen = false;
    readonly createdFresh: boolean;
    readonly encryptedAtRest: boolean;
    readonly migratedFromPlaintext: boolean;
    readonly migratedFromLegacyEncryption: boolean;
    recreatedForSchemaMismatch = false;
    recreatedForIdentityMismatch = false;

    private constructor(
        db: Database.Database,
        createdFresh: boolean,
        encryptedAtRest: boolean,
        migratedFromPlaintext: boolean,
        migratedFromLegacyEncryption: boolean,
    ) {
        this.db = db;
        this.createdFresh = createdFresh;
        this.encryptedAtRest = encryptedAtRest;
        this.migratedFromPlaintext = migratedFromPlaintext;
        this.migratedFromLegacyEncryption = migratedFromLegacyEncryption;
    }

    /** Reuse native statements; rebuilding them per note causes large native-memory spikes. */
    private statement(sql: string): Database.Statement {
        let statement = this.statements.get(sql);
        if (!statement) {
            statement = this.db.prepare(sql);
            this.statements.set(sql, statement);
        }
        return statement;
    }

    static async open(path: string, options: FullTextIndexOptions = {}): Promise<FullTextIndex> {
        if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const migratedFromPlaintext = Boolean(
            options.encryptionKey && path !== ":memory:" && await hasPlaintextSqliteHeader(path),
        );
        let migratedFromLegacyEncryption = false;
        let db: Database.Database;
        if (options.encryptionKey) {
            if (migratedFromPlaintext) {
                db = new Database(path);
                db.pragma("cipher = sqlcipher");
                try {
                    db.rekey(options.encryptionKey);
                    db.prepare("SELECT count(*) AS count FROM sqlite_master").get();
                } catch (error) {
                    db.close();
                    throw new Error("Unable to encrypt the existing plaintext full-text index.", { cause: error });
                }
            } else {
                const openEncrypted = (key: Buffer): Database.Database => {
                    const encryptedDb = new Database(path);
                    encryptedDb.pragma("cipher = sqlcipher");
                    try {
                        encryptedDb.key(key);
                        encryptedDb.prepare("SELECT count(*) AS count FROM sqlite_master").get();
                        return encryptedDb;
                    } catch (error) { encryptedDb.close(); throw error; }
                };
                try {
                    db = openEncrypted(options.encryptionKey);
                } catch (primaryError) {
                    if (!options.legacyEncryptionKey) {
                        throw new Error(
                            "Unable to unlock the encrypted full-text index. " +
                            "Check the vault passphrase or delete the index to rebuild it.",
                            { cause: primaryError },
                        );
                    }
                    try {
                        const legacyDb = openEncrypted(options.legacyEncryptionKey);
                        try { legacyDb.rekey(options.encryptionKey); } finally { legacyDb.close(); }
                        db = openEncrypted(options.encryptionKey);
                        migratedFromLegacyEncryption = true;
                    } catch (legacyError) {
                        throw new Error(
                            "Unable to unlock the encrypted full-text index. " +
                            "Check the vault passphrase or delete the index to rebuild it.",
                            { cause: legacyError },
                        );
                    }
                }
            }
        } else {
            db = new Database(path);
        }

        db.exec(`
            PRAGMA journal_mode = DELETE;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA cache_size = -32768;
            PRAGMA mmap_size = 134217728;
            PRAGMA temp_store = MEMORY;
            PRAGMA memory_security = 1;
        `);
        const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
        const version = Number(versionRow?.user_version ?? 0);
        if (version !== 0 && version !== SCHEMA_VERSION) {
            db.close();
            if (path === ":memory:") throw new Error(`Unsupported in-memory search schema ${version}.`);
            const backupPath = `${path}.schema-v${version}-${Date.now()}.bak`;
            await rename(path, backupPath);
            const rebuilt = await FullTextIndex.open(path, options);
            rebuilt.recreatedForSchemaMismatch = true;
            return rebuilt;
        }
        const createdFresh = version === 0;
        if (createdFresh) {
            db.exec(`
                CREATE TABLE notes(
                    path TEXT PRIMARY KEY, mtime REAL NOT NULL, content_hash TEXT NOT NULL,
                    title TEXT NOT NULL, title_norm TEXT NOT NULL, basename_norm TEXT NOT NULL,
                    path_norm TEXT NOT NULL,
                    path_text TEXT NOT NULL, aliases TEXT NOT NULL, tags TEXT NOT NULL,
                    link_labels TEXT NOT NULL
                );
                CREATE INDEX notes_title_norm_idx ON notes(title_norm);
                CREATE INDEX notes_basename_norm_idx ON notes(basename_norm);
                CREATE INDEX notes_path_norm_idx ON notes(path_norm);
                CREATE TABLE note_aliases(
                    path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
                    alias TEXT NOT NULL, alias_norm TEXT NOT NULL,
                    PRIMARY KEY(path, alias_norm)
                );
                CREATE INDEX note_aliases_norm_idx ON note_aliases(alias_norm);
                CREATE TABLE note_tags(
                    path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
                    tag TEXT NOT NULL, tag_norm TEXT NOT NULL,
                    PRIMARY KEY(path, tag_norm)
                );
                CREATE INDEX note_tags_norm_idx ON note_tags(tag_norm);
                CREATE TABLE note_links(
                    path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
                    target TEXT NOT NULL, target_norm TEXT NOT NULL, target_name_norm TEXT NOT NULL,
                    PRIMARY KEY(path, target_norm)
                );
                CREATE INDEX note_links_target_idx ON note_links(target_norm);
                CREATE INDEX note_links_name_idx ON note_links(target_name_norm);
                CREATE TABLE chunks(
                    id INTEGER PRIMARY KEY,
                    path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
                    ordinal INTEGER NOT NULL, heading TEXT NOT NULL,
                    breadcrumb TEXT NOT NULL, body TEXT NOT NULL,
                    UNIQUE(path, ordinal)
                );
                CREATE INDEX chunks_path_idx ON chunks(path);
                CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE VIRTUAL TABLE notes_fts USING fts5(
                    title, aliases, tags, path_text, link_labels,
                    content = 'notes', content_rowid = 'rowid',
                    tokenize = 'unicode61 remove_diacritics 2'
                );
                CREATE VIRTUAL TABLE chunks_fts USING fts5(
                    heading, breadcrumb, body,
                    content = 'chunks', content_rowid = 'id',
                    tokenize = 'porter unicode61 remove_diacritics 2'
                );
                CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
                    INSERT INTO notes_fts(rowid, title, aliases, tags, path_text, link_labels)
                    VALUES (new.rowid, new.title, new.aliases, new.tags, new.path_text, new.link_labels);
                END;
                CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
                    INSERT INTO notes_fts(notes_fts, rowid, title, aliases, tags, path_text, link_labels)
                    VALUES ('delete', old.rowid, old.title, old.aliases, old.tags, old.path_text, old.link_labels);
                END;
                CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
                    INSERT INTO notes_fts(notes_fts, rowid, title, aliases, tags, path_text, link_labels)
                    VALUES ('delete', old.rowid, old.title, old.aliases, old.tags, old.path_text, old.link_labels);
                    INSERT INTO notes_fts(rowid, title, aliases, tags, path_text, link_labels)
                    VALUES (new.rowid, new.title, new.aliases, new.tags, new.path_text, new.link_labels);
                END;
                CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
                    INSERT INTO chunks_fts(rowid, heading, breadcrumb, body)
                    VALUES (new.id, new.heading, new.breadcrumb, new.body);
                END;
                CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
                    INSERT INTO chunks_fts(chunks_fts, rowid, heading, breadcrumb, body)
                    VALUES ('delete', old.id, old.heading, old.breadcrumb, old.body);
                END;
                CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
                    INSERT INTO chunks_fts(chunks_fts, rowid, heading, breadcrumb, body)
                    VALUES ('delete', old.id, old.heading, old.breadcrumb, old.body);
                    INSERT INTO chunks_fts(rowid, heading, breadcrumb, body)
                    VALUES (new.id, new.heading, new.breadcrumb, new.body);
                END;
                PRAGMA user_version = ${SCHEMA_VERSION};
            `);
        }
        if (options.backendIdentity) {
            const identityRow = db.prepare(
                "SELECT value FROM index_meta WHERE key = 'backend_identity'",
            ).get() as { value?: string } | undefined;
            if (!createdFresh && identityRow?.value !== options.backendIdentity) {
                db.close();
                if (path === ":memory:") {
                    throw new Error("In-memory search index backend identity mismatch.");
                }
                const backupPath = `${path}.backend-mismatch-${Date.now()}.bak`;
                await rename(path, backupPath);
                const rebuilt = await FullTextIndex.open(path, options);
                rebuilt.recreatedForIdentityMismatch = true;
                return rebuilt;
            }
            if (createdFresh) {
                db.prepare(
                    "INSERT INTO index_meta(key, value) VALUES ('backend_identity', ?)",
                ).run(options.backendIdentity);
            }
        }
        if (path !== ":memory:") await chmod(path, 0o600);
        return new FullTextIndex(
            db, createdFresh, Boolean(options.encryptionKey),
            migratedFromPlaintext, migratedFromLegacyEncryption,
        );
    }

    update(path: string, content: string, mtime?: number): void {
        const fields = extractSearchFields(path, content);
        const current = this.statement("SELECT mtime, content_hash FROM notes WHERE path = ?").get(path) as
            | { mtime?: number | string; content_hash?: string }
            | undefined;
        if (current && current.content_hash === fields.contentHash &&
            (mtime === undefined || Number(current.mtime) === mtime)) return;
        const ownsTransaction = !this.batchOpen;
        if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
        try {
            this.statement("DELETE FROM notes WHERE path = ?").run(path);
            this.statement(`
                INSERT INTO notes(
                    path, mtime, content_hash, title, title_norm, basename_norm,
                    path_norm, path_text, aliases, tags, link_labels
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                path, mtime ?? 0, fields.contentHash, fields.title, fields.titleNorm,
                fields.basenameNorm, fields.pathNorm, fields.pathText, fields.aliases.join("\n"),
                fields.tags.join(" "), fields.linkLabels.join("\n"),
            );
            const insertAlias = this.statement(
                "INSERT OR IGNORE INTO note_aliases(path, alias, alias_norm) VALUES (?, ?, ?)",
            );
            for (const alias of fields.aliases) insertAlias.run(path, alias, normalizeLookup(alias));
            const insertTag = this.statement(
                "INSERT OR IGNORE INTO note_tags(path, tag, tag_norm) VALUES (?, ?, ?)",
            );
            for (const tag of fields.tags) insertTag.run(path, tag, tag.toLocaleLowerCase("en-US"));
            const insertLink = this.statement(
                "INSERT OR IGNORE INTO note_links(path, target, target_norm, target_name_norm) VALUES (?, ?, ?, ?)",
            );
            for (const target of fields.links) {
                const withoutExtension = target.replace(/\.md$/i, "");
                const name = withoutExtension.split("/").pop() ?? withoutExtension;
                insertLink.run(path, target, normalizeLookup(withoutExtension), normalizeLookup(name));
            }
            const insertChunk = this.statement(
                "INSERT INTO chunks(path, ordinal, heading, breadcrumb, body) VALUES (?, ?, ?, ?, ?)",
            );
            for (const chunk of fields.chunks) {
                insertChunk.run(path, chunk.ordinal, chunk.heading, chunk.breadcrumb, chunk.body);
            }
            if (ownsTransaction) this.db.exec("COMMIT");
        } catch (error) {
            if (ownsTransaction) this.db.exec("ROLLBACK");
            throw error;
        }
    }

    beginBatch(): void {
        if (this.batchOpen) return;
        this.db.exec("BEGIN IMMEDIATE");
        this.batchOpen = true;
    }
    commitBatch(): void {
        if (!this.batchOpen) return;
        this.db.exec("COMMIT");
        this.batchOpen = false;
    }
    rollbackBatch(): void {
        if (!this.batchOpen) return;
        this.db.exec("ROLLBACK");
        this.batchOpen = false;
    }
    remove(path: string): void { this.statement("DELETE FROM notes WHERE path = ?").run(path); }
    // Preserve backend_identity across a clear: clear() only ever rebuilds the
    // *same* backend (the CouchDB catch-up fallback), and identity is re-inserted
    // only for a fresh DB. Deleting it here would leave the rebuilt index with no
    // identity row, so the next open() reads it as a mismatch and needlessly
    // archives + full-rebuilds a valid index. `since` is intentionally dropped;
    // the rebuild resets it from "0".
    clear(): void { this.db.exec("DELETE FROM notes; DELETE FROM index_meta WHERE key <> 'backend_identity';"); }

    private filterSql(options: FullTextSearchOptions, alias = "notes") {
        const conditions: string[] = [];
        const parameters: Array<string | number> = [];
        if (options.folder) {
            const folder = options.folder.replace(/[\\/]+$/, "");
            conditions.push(`${alias}.path LIKE ? ESCAPE '\\'`);
            parameters.push(`${escapeLike(folder)}/%`);
        }
        if (options.tag) {
            conditions.push(`EXISTS (
                SELECT 1 FROM note_tags filter_tags
                WHERE filter_tags.path = ${alias}.path AND filter_tags.tag_norm = ?
            )`);
            parameters.push(options.tag.toLocaleLowerCase("en-US"));
        }
        if (options.modifiedAfter !== undefined) {
            conditions.push(`${alias}.mtime >= ?`);
            parameters.push(options.modifiedAfter);
        }
        return { conditions, parameters };
    }

    search(options: FullTextSearchOptions): FullTextSearchResult[] {
        const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
        const match = buildFtsQuery(options.query, options.mode);
        const normalized = normalizeLookup(options.query);
        const candidates = new Map<string, Candidate>();
        const add = (
            row: { path: string; mtime: number | string; snippet?: string; heading?: string; breadcrumb?: string },
            laneRank: number,
            laneWeight: number,
            matchedBy: Candidate["matchedBy"],
            snippetPriority: number,
        ) => {
            const contribution = laneWeight / (60 + laneRank);
            const existing = candidates.get(row.path);
            if (!existing) {
                candidates.set(row.path, {
                    path: row.path, mtime: Number(row.mtime), score: contribution,
                    snippet: normalizeSnippet(row.snippet ?? ""),
                    heading: row.heading || undefined, breadcrumb: row.breadcrumb || undefined,
                    matchedBy, snippetPriority,
                });
                return;
            }
            existing.score += contribution;
            if (snippetPriority > existing.snippetPriority && row.snippet) {
                existing.snippet = normalizeSnippet(row.snippet);
                existing.heading = row.heading || undefined;
                existing.breadcrumb = row.breadcrumb || undefined;
                existing.matchedBy = matchedBy;
                existing.snippetPriority = snippetPriority;
            }
        };

        const exactFilters = this.filterSql(options);
        const prefix = `${escapeLike(normalized)}%`;
        // A note matched by several aliases must contribute once, at its best rank.
        const exactRows = this.statement(`
            SELECT notes.path, notes.mtime, notes.title AS snippet,
                MIN(CASE WHEN notes.title_norm = ? OR notes.basename_norm = ? OR notes.path_norm = ? THEN 0
                     WHEN note_aliases.alias_norm = ? THEN 1 ELSE 2 END) AS lane_rank
            FROM notes LEFT JOIN note_aliases ON note_aliases.path = notes.path
            WHERE (notes.title_norm = ? OR notes.basename_norm = ? OR notes.path_norm = ? OR
                   note_aliases.alias_norm = ? OR notes.title_norm LIKE ? ESCAPE '\\' OR
                   notes.basename_norm LIKE ? ESCAPE '\\' OR notes.path_norm LIKE ? ESCAPE '\\' OR
                   note_aliases.alias_norm LIKE ? ESCAPE '\\')
                ${exactFilters.conditions.length ? `AND ${exactFilters.conditions.join(" AND ")}` : ""}
            GROUP BY notes.path
            ORDER BY lane_rank, notes.path LIMIT ?
        `).all(
            normalized, normalized, normalized, normalized,
            normalized, normalized, normalized, normalized, prefix, prefix, prefix, prefix,
            ...exactFilters.parameters, CANDIDATE_LIMIT,
        ) as Array<{ path: string; mtime: number; snippet: string; lane_rank: number }>;
        exactRows.forEach((row, index) =>
            add(row, index, Number(row.lane_rank) === 2 ? EXACT_PREFIX_WEIGHT : EXACT_WEIGHT, "exact", 1));

        const metadataFilters = this.filterSql(options);
        const metadataRows = this.statement(`
            SELECT notes.path, notes.mtime,
                CASE WHEN highlight(notes_fts, 0, '**', '**') LIKE '%**%'
                        THEN highlight(notes_fts, 0, '**', '**')
                     WHEN highlight(notes_fts, 1, '**', '**') LIKE '%**%'
                        THEN highlight(notes_fts, 1, '**', '**')
                     ELSE snippet(notes_fts, 4, '**', '**', ' … ', 18) END AS snippet,
                notes_fts.rank AS lane_score
            FROM notes_fts JOIN notes ON notes.rowid = notes_fts.rowid
            WHERE notes_fts MATCH ? AND notes_fts.rank MATCH ?
                ${metadataFilters.conditions.length ? `AND ${metadataFilters.conditions.join(" AND ")}` : ""}
            ORDER BY lane_score, notes.path LIMIT ?
        `).all(
            match, "bm25(12.0, 10.0, 5.0, 3.0, 7.0)",
            ...metadataFilters.parameters, CANDIDATE_LIMIT,
        ) as Array<{ path: string; mtime: number; snippet: string; lane_score: number }>;
        metadataRows.forEach((row, index) => add(row, index, METADATA_WEIGHT, "metadata", 3));

        const passageFilters = this.filterSql(options);
        const passageRows = this.statement(`
            WITH hits AS (
                SELECT notes.path, notes.mtime, chunks.ordinal, chunks.heading, chunks.breadcrumb,
                    CASE WHEN highlight(chunks_fts, 0, '**', '**') LIKE '%**%'
                            THEN highlight(chunks_fts, 0, '**', '**')
                         ELSE snippet(chunks_fts, 2, '**', '**', ' … ', 28) END AS snippet,
                    chunks_fts.rank AS lane_score
                FROM chunks_fts
                JOIN chunks ON chunks.id = chunks_fts.rowid
                JOIN notes ON notes.path = chunks.path
                WHERE chunks_fts MATCH ? AND chunks_fts.rank MATCH ?
                    ${passageFilters.conditions.length ? `AND ${passageFilters.conditions.join(" AND ")}` : ""}
                ORDER BY lane_score, notes.path, chunks.ordinal
                LIMIT ?
            ), grouped AS (
                SELECT *, ROW_NUMBER() OVER (PARTITION BY path ORDER BY lane_score, ordinal) AS note_rank
                FROM hits
            )
            SELECT path, mtime, heading, breadcrumb, snippet, lane_score
            FROM grouped WHERE note_rank = 1
            ORDER BY lane_score, path LIMIT ?
        `).all(
            match, "bm25(9.0, 5.0, 1.0)",
            ...passageFilters.parameters, CANDIDATE_LIMIT * 5, CANDIDATE_LIMIT,
        ) as Array<{
            path: string; mtime: number; heading: string; breadcrumb: string;
            snippet: string; lane_score: number;
        }>;
        passageRows.forEach((row, index) => add(row, index, PASSAGE_WEIGHT, "passage", 2));

        return [...candidates.values()]
            .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
            .slice(0, limit)
            .map(({ score, snippetPriority: _priority, ...result }) => ({ ...result, rank: score }));
    }

    listWithMtime(folder?: string): Array<{ path: string; mtime: number }> {
        const parameters: string[] = [];
        const where = folder ? "WHERE path LIKE ? ESCAPE '\\'" : "";
        if (folder) parameters.push(`${escapeLike(folder.replace(/[\\/]+$/, ""))}/%`);
        return this.statement(`SELECT path, mtime FROM notes ${where} ORDER BY path`).all(...parameters)
            .map((row: any) => ({ path: String(row.path), mtime: Number(row.mtime) }));
    }
    getMtime(path: string): number {
        const row = this.statement("SELECT mtime FROM notes WHERE path = ?").get(path) as
            | { mtime?: number | string }
            | undefined;
        return Number(row?.mtime ?? 0);
    }
    getTags(path: string): string[] {
        return this.statement("SELECT tag FROM note_tags WHERE path = ? ORDER BY rowid").all(path)
            .map((row: any) => String(row.tag));
    }
    getLinks(path: string): string[] {
        return this.statement("SELECT target FROM note_links WHERE path = ? ORDER BY rowid").all(path)
            .map((row: any) => String(row.target));
    }
    getBacklinks(path: string): string[] {
        const normalized = normalizeLookup(path);
        const name = normalizeLookup(path.replace(/\.md$/i, "").split("/").pop() ?? path);
        return this.statement(`
            SELECT DISTINCT path FROM note_links
            WHERE target_norm = ? OR target_name_norm = ? ORDER BY path
        `).all(normalized, name).map((row: any) => String(row.path));
    }
    listAllTags(): Array<{ tag: string; count: number }> {
        return this.statement(`
            SELECT min(tag) AS tag, count(*) AS count FROM note_tags
            GROUP BY tag_norm ORDER BY count DESC, tag
        `).all().map((row: any) => ({ tag: String(row.tag), count: Number(row.count) }));
    }
    get checkpoint(): string {
        const row = this.statement("SELECT value FROM index_meta WHERE key = 'since'").get() as
            | { value?: string }
            | undefined;
        return row?.value ?? "";
    }
    set checkpoint(value: string) {
        this.statement(`
            INSERT INTO index_meta(key, value) VALUES ('since', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(value);
    }
    get size(): number {
        const row = this.statement("SELECT count(*) AS count FROM notes").get() as { count?: number } | undefined;
        return Number(row?.count ?? 0);
    }
    get chunkCount(): number {
        const row = this.statement("SELECT count(*) AS count FROM chunks").get() as { count?: number } | undefined;
        return Number(row?.count ?? 0);
    }
    close(): void { this.rollbackBatch(); this.statements.clear(); this.db.close(); }
}
