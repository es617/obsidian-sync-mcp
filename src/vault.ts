/**
 * Vault access layer — wraps DirectFileManipulator from livesync-commonlib.
 */

import { DirectFileManipulator } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import type { DirectFileManipulatorOptions } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import { createTextBlob } from "../lib/livesync-commonlib/src/common/utils.ts";
import type { FilePathWithPrefix } from "../lib/livesync-commonlib/src/common/types.ts";
import type { MetaEntry } from "../lib/livesync-commonlib/src/API/DirectFileManipulatorV2.ts";
import { isPathProbablyObfuscated, decrypt } from "octagonal-wheels/encryption/encryption";
import { clearHandlers } from "../lib/livesync-commonlib/src/replication/SyncParamsHandler.ts";
import { parseFrontmatterAndLinks } from "./parse.js";
import type { VaultBackend, NoteInfo, NoteListing } from "./vault-backend.js";
import { validateNotePath, isValidNotePath } from "./note-path.js";
import { deriveOrImportIdKey } from "../lib/livesync-commonlib/src/common/idDerivation.ts";
import { idDerivationOptions } from "./id-derivation-config.js";
import { deriveContent } from "./index-sync.js";
import { classifyIds, type IdFormat } from "./id-format.js";
import { checkDatabase } from "./couchdb-preflight.js";

export interface VaultConfig {
    couchdbUrl: string;
    couchdbUser: string;
    couchdbPassword: string;
    database: string;
    passphrase?: string;
    obfuscatePaths?: boolean;
    /**
     * LiveSync "independent ID derivation" key, as the recovery code
     * (`sls-id-v1:<hex>`) or a source string. Required to resolve paths to
     * document IDs on vaults created with LiveSync 1.0.33+ that use the new
     * keyed ID scheme. Leave unset for older (passphrase-derived) vaults.
     */
    idDerivationKey?: string;
}

export class Vault implements VaultBackend {
    // Created in init(): constructing it starts connecting, and PouchDB would
    // create a missing database, so the existence check has to come first.
    private manipulator!: DirectFileManipulator;
    private passphrase: string | undefined;
    private config: VaultConfig;
    // Resolved 64-hex ID key (from the recovery code / source string), or
    // undefined for legacy passphrase-derived vaults. Set in init().
    private idDerivationKey: string | undefined;

    constructor(config: VaultConfig) {
        this.config = config;
        this.passphrase = config.passphrase;
    }

    private static buildOptions(config: VaultConfig, obfuscatePaths: boolean, idDerivationKey?: string): DirectFileManipulatorOptions {
        return {
            url: config.couchdbUrl,
            username: config.couchdbUser,
            password: config.couchdbPassword,
            database: config.database,
            passphrase: config.passphrase,
            obfuscatePassphrase: obfuscatePaths ? config.passphrase : undefined,
            useEden: false,
            enableCompression: false,
            handleFilenameCaseSensitive: false,
            doNotUseFixedRevisionForChunks: false,
            ...idDerivationOptions(obfuscatePaths, idDerivationKey),
        };
    }

    async init(): Promise<void> {
        // Normalize the recovery code / source string to the 64-hex key once.
        if (this.config.idDerivationKey) {
            this.idDerivationKey = await deriveOrImportIdKey(this.config.idDerivationKey);
        }
        await checkDatabase({
            url: this.config.couchdbUrl,
            database: this.config.database,
            username: this.config.couchdbUser,
            password: this.config.couchdbPassword,
        });
        this.manipulator = new DirectFileManipulator(Vault.buildOptions(this.config, !!this.config.obfuscatePaths, this.idDerivationKey));
        await this.manipulator.ready.promise;
        await this.reconcileObfuscation();
    }

    /**
     * Detect whether the vault's document IDs are obfuscated and, if the
     * configured COUCHDB_OBFUSCATE_PROPERTIES doesn't match, correct it.
     * A mismatched setting can never work: path→id resolution misses every
     * existing note on read, and writes produce docs LiveSync clients ignore
     * (issues #4, #10). The database is the ground truth.
     */
    private async reconcileObfuscation(): Promise<void> {
        const configured = !!this.config.obfuscatePaths;
        const format = await this.detectIdFormat();
        if (format === "empty") return;
        if (format === "mixed") {
            console.warn(
                "Warning: vault contains both obfuscated and plaintext document IDs. " +
                `Keeping COUCHDB_OBFUSCATE_PROPERTIES=${configured}. ` +
                "This usually means \"Obfuscate properties\" was toggled without rebuilding the database — consider rebuilding it from LiveSync.",
            );
            return;
        }
        const actual = format === "obfuscated";
        if (actual === configured) return;
        if (actual && !this.passphrase) {
            throw new Error(
                "Vault uses obfuscated document IDs (LiveSync \"Obfuscate properties\"), which requires the E2E passphrase. " +
                "Set COUCHDB_PASSPHRASE and COUCHDB_OBFUSCATE_PROPERTIES=true.",
            );
        }
        console.warn(
            actual
                ? "Warning: vault uses obfuscated document IDs but COUCHDB_OBFUSCATE_PROPERTIES is not set to true. " +
                  "Enabling path obfuscation automatically — set COUCHDB_OBFUSCATE_PROPERTIES=true to silence this warning."
                : "Warning: COUCHDB_OBFUSCATE_PROPERTIES=true but vault uses plaintext document IDs. " +
                  "Disabling path obfuscation automatically — set COUCHDB_OBFUSCATE_PROPERTIES=false to silence this warning.",
        );
        await this.manipulator.close();
        this.manipulator = new DirectFileManipulator(Vault.buildOptions(this.config, actual, this.idDerivationKey));
        await this.manipulator.ready.promise;
    }

    /** Sample file-entry docs from the changes feed and classify their IDs. */
    private async detectIdFormat(): Promise<IdFormat> {
        const SAMPLE_TARGET = 20;
        const BATCH_SIZE = 100;
        const db = this.manipulator.liveSyncLocalDB.localDatabase;
        const ids: string[] = [];
        let since: string | number = 0;

        while (ids.length < SAMPLE_TARGET) {
            const result = await db.changes({
                since,
                limit: BATCH_SIZE,
                // Only real file entries — excludes chunks, versioninfo, milestones, sync params.
                selector: { type: { $in: ["plain", "newnote"] } },
                live: false,
            });
            for (const change of result.results) {
                if (ids.length >= SAMPLE_TARGET) break;
                ids.push(change.id);
            }
            if (result.results.length < BATCH_SIZE) break;
            since = result.last_seq;
        }
        return classifyIds(ids);
    }

    async close(): Promise<void> {
        this.manipulator.endWatch();
        await this.manipulator.close();
    }

    private static mdFilter(meta: any): boolean {
        return isValidNotePath(meta.path ?? "");
    }

    private static docToChange(doc: any, callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void, seq?: string | number) {
        const path = doc.path ?? "";
        if (!isValidNotePath(path)) return;
        // null => deleted (remove); "" => existing empty note (index it, don't drop)
        const content = deriveContent(doc);
        callback(path, content, content === null ? undefined : doc.mtime, seq);
    }

    async catchUp(
        since: string,
        callback: (path: string, content: string | null, mtime?: number) => void,
        onBatch?: (since: string, processed: number) => Promise<void>,
        stats?: { unreadable: number },
    ): Promise<string> {
        // Paginate _changes in batches to limit memory usage.
        const BATCH_SIZE = 50;
        const db = this.manipulator.liveSyncLocalDB.localDatabase;
        let currentSince = since;
        let totalProcessed = 0;

        while (true) {
            const result = await db.changes({
                include_docs: true,
                since: currentSince,
                selector: { type: { $ne: "leaf" } },
                live: false,
                limit: BATCH_SIZE,
            });

            for (const change of result.results) {
                if (!change.doc) continue;
                const meta = change.doc as any;
                // Skip chunks and system docs
                if (meta.type === "leaf" || meta.type === "versioninfo") continue;
                if (meta._id?.startsWith("h:") || meta._id?.startsWith("_")) continue;
                // Decrypt path to check .md BEFORE fetching chunks (avoids loading large attachments)
                let path = meta.path ?? "";
                if (isPathProbablyObfuscated(path) && this.passphrase) {
                    try { path = await decrypt(path, this.passphrase, false); } catch {
                        // Path could not be decrypted: the note is skipped and stays
                        // invisible to the index. Counted so search_notes can say so.
                        if (stats) stats.unreadable++;
                        continue;
                    }
                }
                // A deletion doesn't need the body — the decrypted path is enough
                // to remove the note. Short-circuit so a tombstone whose chunks were
                // already purged still removes it instead of silently lingering.
                if (meta.deleted) {
                    if (isValidNotePath(path)) callback(path, null);
                    continue;
                }
                if (!isValidNotePath(path)) continue;
                const doc = await this.manipulator.getByMeta(meta).catch(() => null);
                if (doc) {
                    Vault.docToChange(doc, callback);
                } else if (stats) {
                    // Chunks missing or undecryptable for a live note: a silent miss.
                    stats.unreadable++;
                }
            }

            totalProcessed += result.results.length;
            currentSince = String(result.last_seq);

            // Release chunk cache between batches to prevent memory growth
            this.manipulator.liveSyncLocalDB.clearCaches();

            // Save checkpoint after each batch so crashes don't restart from zero
            if (onBatch && result.results.length > 0) {
                await onBatch(currentSince, totalProcessed);
            }

            // No more changes
            if (result.results.length < BATCH_SIZE) break;
        }

        this.manipulator.since = currentSince;
        return currentSince;
    }

    watchChanges(callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void): void {
        // catchUp already set this.manipulator.since to the right point
        this.manipulator.beginWatch(
            (doc, seq) => Vault.docToChange(doc, callback, seq),
            Vault.mdFilter,
        );
    }

    private validatePath(path: string): void {
        validateNotePath(path);
    }

    async readNote(path: string): Promise<string | null> {
        this.validatePath(path);
        const entry = await this.manipulator.get(path as FilePathWithPrefix);
        if (!entry) return null;
        if ("data" in entry && Array.isArray(entry.data)) {
            return entry.data.join("");
        }
        return null;
    }

    async writeNote(path: string, content: string): Promise<boolean> {
        this.validatePath(path);
        // Clear cached PBKDF2 salt so we re-fetch from CouchDB before encrypting.
        // Prevents stale salt after Obsidian "Overwrite remote" rebuilds (issue #686).
        clearHandlers();

        // Preserve ctime if note already exists
        let ctime = Date.now();
        const existing = await this.manipulator.get(path as FilePathWithPrefix, true);
        if (existing && "ctime" in existing) {
            ctime = existing.ctime;
        }

        const blob = createTextBlob(content);
        return await this.manipulator.put(path, blob, {
            ctime,
            mtime: Date.now(),
            size: new TextEncoder().encode(content).byteLength,
        });
    }

    async deleteNote(path: string): Promise<boolean> {
        this.validatePath(path);
        clearHandlers();
        return await this.manipulator.delete(path);
    }

    async moveNote(from: string, to: string): Promise<boolean> {
        this.validatePath(from);
        this.validatePath(to);
        const content = await this.readNote(from);
        if (content === null) return false;
        const wrote = await this.writeNote(to, content);
        if (!wrote) return false;
        return await this.deleteNote(from);
    }

    async getMetadata(path: string): Promise<NoteInfo | null> {
        this.validatePath(path);
        const entry = await this.manipulator.get(path as FilePathWithPrefix);
        if (!entry) return null;
        const content = "data" in entry && Array.isArray(entry.data) ? entry.data.join("") : "";
        return {
            path,
            size: entry.size,
            ctime: entry.ctime,
            mtime: entry.mtime,
            ...parseFrontmatterAndLinks(content),
        };
    }

    async listNotes(folder?: string): Promise<string[]> {
        const notes = await this.listNotesWithMtime(folder);
        return notes.map((n) => n.path);
    }

    async listNotesWithMtime(folder?: string): Promise<NoteListing[]> {
        if (folder && !folder.endsWith("/")) folder += "/";
        const results: NoteListing[] = [];
        for await (const doc of this.manipulator.enumerateAllNormalDocs({ metaOnly: true })) {
            const entry = doc as MetaEntry;
            if (entry.deleted) continue;
            const notePath = entry.path ?? "";
            if (!isValidNotePath(notePath)) continue;
            if (folder && !notePath.startsWith(folder)) continue;
            results.push({ path: notePath, mtime: entry.mtime ?? 0 });
        }
        return results.sort((a, b) => a.path.localeCompare(b.path));
    }

}
