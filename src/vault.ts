/**
 * Vault access layer — wraps DirectFileManipulator from livesync-commonlib.
 */

import { DirectFileManipulator } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import type { DirectFileManipulatorOptions } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import { createTextBlob, createBinaryBlob, readContent, determineTypeFromBlob } from "../lib/livesync-commonlib/src/common/utils.ts";
import type { LoadedEntry, SavingEntry, DocumentID } from "../lib/livesync-commonlib/src/common/types.ts";
import type { FilePathWithPrefix } from "../lib/livesync-commonlib/src/common/types.ts";
import type { MetaEntry } from "../lib/livesync-commonlib/src/API/DirectFileManipulatorV2.ts";
import { isPathProbablyObfuscated, decrypt } from "octagonal-wheels/encryption/encryption";
import { clearHandlers } from "../lib/livesync-commonlib/src/replication/SyncParamsHandler.ts";
import { PouchDB } from "../lib/livesync-commonlib/src/pouchdb/pouchdb-http.ts";
import { inspectDatabasePathIdentity, type PathIdentityInspection } from "../lib/livesync-commonlib/src/pouchdb/pathIdentityCompatibility.ts";
import type { EntryDoc } from "../lib/livesync-commonlib/src/common/types.ts";
import { parseFrontmatterAndLinks } from "./parse.js";
import { AttachmentExistsError, AttachmentMoveIncompleteError, AttachmentTooLargeError, NoteExistsError, NoteNotFoundError, RevisionMismatchError, UpdateRetriesExhaustedError, type RevisedNote, type UpdateOptions, type UpdateResult, type NoteWriteOptions, type MoveOptions, type VaultBackend, type NoteInfo, type NoteListing, type AttachmentInfo, type AttachmentChangeCallback, type WriteOptions } from "./vault-backend.js";
import { KeyedLock } from "./keyed-lock.js";
import { validateNotePath, isValidNotePath } from "./note-path.js";
import { validateAttachmentPath, isValidAttachmentPath } from "./attachment-path.js";
import { deriveOrImportIdKey } from "../lib/livesync-commonlib/src/common/idDerivation.ts";
import { idDerivationOptions } from "./id-derivation-config.js";
import { deriveContent } from "./index-sync.js";
import { classifyIds, isNamespacedId, ID_SAMPLE_TARGET } from "./id-format.js";
import { checkDatabase } from "./couchdb-preflight.js";
import { resolvePathIdentity, type PathNormalizationSetting } from "./path-identity-config.js";

const debugLog = process.env.LOG_LEVEL === "debug";
/** Upper bound of the random pause between two attempts of updateNote. */
const RETRY_JITTER_MS = 25;
/** writeNote's default rounds for replacing an existing note; write_note passes edit_note's budget. */
const OVERWRITE_MAX_ATTEMPTS = 10;

/** CouchDB answered false while the note was still at the write's base: not a 409. */
class WriteNotStoredError extends Error {
    constructor(readonly path: string) {
        super(`CouchDB did not store the write to ${path}`);
        this.name = "WriteNotStoredError";
    }
}

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
    /**
     * Match LiveSync's "Handle filenames as case-sensitive" setting. Defaults
     * to false (the plugin default). Set true only if your vault was created
     * with that option on, otherwise obfuscated document IDs won't resolve.
     */
    caseSensitive?: boolean;
    /**
     * COUCHDB_PATH_NORMALIZATION: "auto" (default) follows the database and
     * picks NFC for an empty one; "nfc" / "legacy" force a choice for an empty
     * database and must match an existing one.
     */
    pathNormalization?: PathNormalizationSetting;
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
    // Obfuscation actually in effect after reconciling with the database, which
    // can differ from the configured value.
    private obfuscatePathsEffective = false;
    // Path identity declared by the database: 0 = legacy, 1 = Unicode NFC
    // (`nfc-path-identity-v1`, the default for databases created by LiveSync
    // 1.0.49+). Detected in init(); the library rejects a mismatch.
    private pathNormalizationVersion: 0 | 1 = 0;
    /** Per-document lock: makes an existence check and the write after it one step, and orders this server's own retries (see updateNote). */
    private docLock = new KeyedLock();

    constructor(config: VaultConfig) {
        this.config = config;
        this.passphrase = config.passphrase;
    }

    private static buildOptions(config: VaultConfig, obfuscatePaths: boolean, idDerivationKey: string | undefined, pathNormalizationVersion: 0 | 1): DirectFileManipulatorOptions {
        return {
            url: config.couchdbUrl,
            username: config.couchdbUser,
            password: config.couchdbPassword,
            database: config.database,
            passphrase: config.passphrase,
            obfuscatePassphrase: obfuscatePaths ? config.passphrase : undefined,
            useEden: false,
            enableCompression: false,
            handleFilenameCaseSensitive: !!config.caseSensitive,
            doNotUseFixedRevisionForChunks: false,
            pathNormalizationVersion,
            ...idDerivationOptions(obfuscatePaths, idDerivationKey),
        };
    }

    async init(): Promise<void> {
        // Normalize the recovery code / source string to the 64-hex key once.
        if (this.config.idDerivationKey) {
            this.idDerivationKey = await deriveOrImportIdKey(this.config.idDerivationKey);
        }
        this.obfuscatePathsEffective = !!this.config.obfuscatePaths;
        await checkDatabase({
            url: this.config.couchdbUrl,
            database: this.config.database,
            username: this.config.couchdbUser,
            password: this.config.couchdbPassword,
        });
        const pathIdentity = resolvePathIdentity(this.config.pathNormalization ?? "auto", await this.inspectPathIdentity());
        this.pathNormalizationVersion = pathIdentity.version;
        if (pathIdentity.notice) console.warn(pathIdentity.notice);
        else if (pathIdentity.version === 1) console.log("Vault uses Unicode NFC path identity (nfc-path-identity-v1).");
        this.manipulator = new DirectFileManipulator(this.options(this.obfuscatePathsEffective));
        await this.awaitManipulatorReady();
        await this.reconcileObfuscation();
        if (this.idDerivationKey && !this.obfuscatePathsEffective) {
            console.warn(
                "Warning: COUCHDB_ID_DERIVATION_KEY is set but this vault does not use path obfuscation; " +
                "the ID key only applies to obfuscated vaults and is ignored.",
            );
        }
    }

    private options(obfuscatePaths: boolean): DirectFileManipulatorOptions {
        return Vault.buildOptions(this.config, obfuscatePaths, this.idDerivationKey, this.pathNormalizationVersion);
    }

    /**
     * Read the database's path identity declaration (legacy vs Unicode NFC)
     * so the manipulator is opened with the matching setting. Read-only: it
     * never declares a feature itself; DirectFileManipulator then declares the
     * chosen identity in an empty database when it opens it.
     */
    private async inspectPathIdentity(): Promise<PathIdentityInspection> {
        const db = new PouchDB<EntryDoc>(`${this.config.couchdbUrl.replace(/\/+$/, "")}/${this.config.database}`, {
            auth: { username: this.config.couchdbUser, password: this.config.couchdbPassword },
            skip_setup: true,
        });
        try {
            return await inspectDatabasePathIdentity(db);
        } finally {
            await db.close();
        }
    }

    /**
     * Await the manipulator's readiness, translating the library's ID-mismatch
     * error into actionable guidance. The library (0.1.34+) verifies at startup
     * that sampled document IDs match the configured derivation, so a v1 vault
     * with the wrong or missing key fails here instead of silently missing reads.
     */
    private async awaitManipulatorReady(): Promise<void> {
        try {
            await this.manipulator.ready.promise;
        } catch (err) {
            if (err instanceof Error && err.message.includes("do not match the configured ID key")) {
                throw new Error(
                    "Vault document IDs do not match the configured ID scheme. " +
                    (this.idDerivationKey
                        ? "COUCHDB_ID_DERIVATION_KEY is set but does not match this vault; paste the exact recovery code (sls-id-v1:...) from LiveSync's \"Show current recovery code\". "
                        : "If this vault was created with LiveSync 1.0.33+ with path obfuscation, set COUCHDB_ID_DERIVATION_KEY to the LiveSync recovery code (sls-id-v1:...). ") +
                    "If instead your LiveSync vault has \"Handle filenames as case-sensitive\" enabled, set COUCHDB_CASE_SENSITIVE=true to match it.",
                );
            }
            throw err;
        }
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
        const format = classifyIds(await this.sampleNoteIds());
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
        this.obfuscatePathsEffective = actual;
        await Vault.closeManipulator(this.manipulator);
        this.manipulator = new DirectFileManipulator(this.options(actual));
        await this.awaitManipulatorReady();
    }

    /**
     * Sample note-document IDs from the changes feed, oldest first. Namespaced
     * file documents (`i:`, `ix:`, `ps:`) are skipped: their prefix hides the ID
     * format (#62).
     */
    private async sampleNoteIds(): Promise<string[]> {
        const BATCH_SIZE = 100;
        const db = this.manipulator.liveSyncLocalDB.localDatabase;
        const ids: string[] = [];
        let since: string | number = 0;

        while (ids.length < ID_SAMPLE_TARGET) {
            const result = await db.changes({
                since,
                limit: BATCH_SIZE,
                // Only real file entries — excludes chunks, versioninfo, milestones, sync params.
                selector: { type: { $in: ["plain", "newnote"] } },
                live: false,
            });
            for (const change of result.results) {
                if (ids.length >= ID_SAMPLE_TARGET) break;
                if (!isNamespacedId(change.id)) ids.push(change.id);
            }
            if (result.results.length < BATCH_SIZE) break;
            since = result.last_seq;
        }
        return ids;
    }

    async close(): Promise<void> {
        await Vault.closeManipulator(this.manipulator);
    }

    /**
     * Close a manipulator and stop its internal changes feed. The library tears
     * its managers down on PouchDB's "close" event, but PouchDB emits "closed",
     * so without this the feed outlives close() and keeps decrypting incoming
     * changes. After clearHandlers() that dead instance can win the race to
     * re-create the shared sync-parameters handler, binding it to a closed
     * database: every later salt fetch then fails. Reproduced as an
     * intermittent crash in the CouchDB harness; the reopen in
     * reconcileObfuscation is exposed to the same race.
     */
    private static async closeManipulator(manipulator: DirectFileManipulator): Promise<void> {
        manipulator.endWatch();
        try {
            await manipulator.liveSyncLocalDB.managers.teardownManagers();
        } catch {
            // Managers were never created (initialisation failed); nothing to stop.
        }
        await manipulator.close();
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
        onAttachment?: AttachmentChangeCallback,
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
                // Attachments are reported from the metadata doc alone: size and
                // mtime are on it, so no chunk is ever fetched for them.
                if (onAttachment && isValidAttachmentPath(path)) {
                    onAttachment(path, meta.deleted ? null : { size: meta.size ?? 0, mtime: meta.mtime ?? 0 });
                    continue;
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

    watchChanges(callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void, onAttachment?: AttachmentChangeCallback): void {
        // catchUp already set this.manipulator.since to the right point.
        // The interest filter sees the metadata doc before any chunk is loaded:
        // attachments are reported from it and then filtered out, so their
        // bytes are never fetched.
        const filter = (meta: any): boolean => {
            if (onAttachment) this.reportAttachment(meta, onAttachment);
            return Vault.mdFilter(meta);
        };
        this.manipulator.beginWatch(
            (doc, seq) => Vault.docToChange(doc, callback, seq),
            filter,
        );
    }

    private reportAttachment(meta: any, onAttachment: AttachmentChangeCallback): void {
        const emit = (path: string) => {
            if (!isValidAttachmentPath(path)) return;
            onAttachment(path, meta.deleted ? null : { size: meta.size ?? 0, mtime: meta.mtime ?? 0 });
        };
        const path = meta.path ?? "";
        if (isPathProbablyObfuscated(path) && this.passphrase) {
            decrypt(path, this.passphrase, false).then(emit, () => {});
        } else {
            emit(path);
        }
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

    async readNoteRevision(path: string): Promise<RevisedNote | null> {
        this.validatePath(path);
        const entry = await this.manipulator.get(path as FilePathWithPrefix);
        if (!entry || !("data" in entry) || !Array.isArray(entry.data) || !entry._rev) return null;
        return { content: entry.data.join(""), revision: entry._rev };
    }

    async updateNote(path: string, apply: (content: string) => string, options: UpdateOptions = {}): Promise<UpdateResult> {
        this.validatePath(path);
        const id = await this.manipulator.path2id(path as FilePathWithPrefix);
        // The lock orders this server's own writers, so they never spend attempts
        // on each other, and is held across retries so a writer that lost to
        // another instance keeps its turn here. CouchDB's revision check orders
        // everyone else.
        return await this.docLock.run([id], () => this.updateUnlocked(path, id, apply, options));
    }

    /**
     * The retry loop of updateNote; the caller holds the document's lock.
     * `readText: false` is a blind overwrite (write_note): only the revision is
     * fetched, `apply` gets "", and since its result doesn't depend on the old
     * text, retrying it is always safe.
     */
    private async updateUnlocked(path: string, id: DocumentID, apply: (content: string) => string, { expectedRevision, maxAttempts = 1, minRetryMs = 0 }: UpdateOptions, readText = true): Promise<UpdateResult> {
        // A caller-pinned revision is one attempt: re-applying on newer text is the caller's call.
        const allowed = expectedRevision !== undefined ? 1 : Math.max(1, maxAttempts);
        const started = performance.now();
        let refusedBase: string | undefined;
        for (let attempt = 1; ; attempt++) {
            clearHandlers();
            const entry = await this.manipulator.get(path as FilePathWithPrefix, !readText);
            if (!entry || !entry._rev || (readText && (!("data" in entry) || !Array.isArray(entry.data)))) throw new NoteNotFoundError(path);
            // The library answers false both for a 409 and for a write it could
            // not store at all. After a 409 the note has moved on; if it is still
            // at the refused base, the write failed for another reason.
            if (refusedBase === entry._rev) throw new WriteNotStoredError(path);
            if (expectedRevision !== undefined && entry._rev !== expectedRevision) throw new RevisionMismatchError(path, expectedRevision, entry._rev);
            const content = apply(readText ? (entry.data as string[]).join("") : "");
            const revision = await this.putAtRevision(path, id, content, entry.ctime, entry._rev);
            if (revision) return { content, revision, attempts: attempt };
            refusedBase = entry._rev;
            if (expectedRevision !== undefined) {
                const now = await this.manipulator.get(path as FilePathWithPrefix, true);
                if (now && now._rev === expectedRevision) throw new WriteNotStoredError(path);
                throw new RevisionMismatchError(path, expectedRevision, (now && now._rev) || "(deleted)");
            }
            if (attempt >= allowed && (attempt >= allowed * 5 || performance.now() - started >= minRetryMs)) throw new UpdateRetriesExhaustedError(path, attempt);
            if (debugLog) console.log(`[vault] revision conflict on attempt ${attempt}, retrying`);
            if (RETRY_JITTER_MS > 0) await new Promise((r) => setTimeout(r, Math.random() * RETRY_JITTER_MS));
        }
    }

    /**
     * Write a note as a child of `baseRevision` with a plain (non-forced) put,
     * so CouchDB itself refuses it when another writer advanced the note first.
     * Returns the new revision, or false when CouchDB refused it.
     */
    private async putAtRevision(path: string, id: DocumentID, content: string, ctime: number, baseRevision: string): Promise<string | false> {
        const data = createTextBlob(content);
        const type = determineTypeFromBlob(data);
        const doc = {
            _id: id,
            path: path as FilePathWithPrefix,
            data,
            ctime,
            mtime: Date.now(),
            size: new TextEncoder().encode(content).byteLength,
            type,
            datatype: type,
            eden: {},
            children: [] as string[],
        } as SavingEntry;
        const result = await this.manipulator.liveSyncLocalDB.putDBEntryWithLiveBaseRevision(doc, baseRevision);
        return result ? result.rev : false;
    }

    async writeNote(path: string, content: string, options: NoteWriteOptions = {}): Promise<boolean> {
        this.validatePath(path);
        const id = await this.manipulator.path2id(path as FilePathWithPrefix);
        return await this.docLock.run([id], () => this.writeNoteUnlocked(path, id, content, options));
    }

    /**
     * The create/update checks rely on the caller holding the document's lock.
     * Replacing an existing note is a revision-checked put, retried on a 409
     * (the new text doesn't depend on the old one), so a concurrent writer on
     * another instance or in Obsidian can't leave a conflict revision with it.
     * Creating a missing note is still the library's forced put: two instances
     * creating the same new note at the same moment can still conflict.
     */
    private async writeNoteUnlocked(path: string, id: DocumentID, content: string, { mode = "upsert", maxAttempts = OVERWRITE_MAX_ATTEMPTS, minRetryMs = 0 }: NoteWriteOptions): Promise<boolean> {
        // Clear cached PBKDF2 salt so we re-fetch from CouchDB before encrypting.
        // Prevents stale salt after Obsidian "Overwrite remote" rebuilds (issue #686).
        clearHandlers();

        const existing = await this.manipulator.get(path as FilePathWithPrefix, true);
        if (existing && mode === "create") throw new NoteExistsError(path);
        if (!existing && mode === "update") throw new NoteNotFoundError(path);
        if (existing) {
            try {
                await this.updateUnlocked(path, id, () => content, { maxAttempts, minRetryMs }, false);
                return true;
            } catch (err) {
                if (err instanceof WriteNotStoredError) return false;
                // Deleted while we retried: an upsert creates it, as it would have
                // had it come after the delete; an update refuses.
                if (!(err instanceof NoteNotFoundError) || mode === "update") throw err;
            }
        }

        const blob = createTextBlob(content);
        const now = Date.now();
        return await this.manipulator.put(path, blob, {
            ctime: now,
            mtime: now,
            size: new TextEncoder().encode(content).byteLength,
        });
    }

    async deleteNote(path: string): Promise<boolean> {
        this.validatePath(path);
        const id = await this.manipulator.path2id(path as FilePathWithPrefix);
        return await this.docLock.run([id], async () => {
            clearHandlers();
            return await this.manipulator.delete(path);
        });
    }

    async moveNote(from: string, to: string): Promise<boolean> {
        this.validatePath(from);
        this.validatePath(to);
        const fromId = await this.manipulator.path2id(from as FilePathWithPrefix);
        const toId = await this.manipulator.path2id(to as FilePathWithPrefix);
        return await this.docLock.run([fromId, toId], async () => {
            const content = await this.readNote(from);
            if (content === null) return false;
            if (from === to) return true;
            // A case-only rename on a case-insensitive vault (LiveSync's default)
            // is one document: rewrite it under the new path and delete nothing.
            if (fromId === toId) return await this.writeNoteUnlocked(to, toId, content, { mode: "upsert" });
            const wrote = await this.writeNoteUnlocked(to, toId, content, { mode: "create" });
            if (!wrote) return false;
            clearHandlers();
            return await this.manipulator.delete(from);
        });
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
            revision: entry._rev,
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

    async writeAttachment(path: string, data: Uint8Array, options: WriteOptions = {}): Promise<boolean> {
        validateAttachmentPath(path);
        const id = await this.manipulator.path2id(path as FilePathWithPrefix);
        return await this.docLock.run([id], () => this.writeAttachmentUnlocked(path, data, options));
    }

    /**
     * The library's put always writes over the current revision, so "create
     * unless it exists" can't be one CouchDB request. Callers hold the
     * document's lock instead, which covers writes made by this server; a
     * concurrent write from Obsidian is left to LiveSync's conflict handling.
     */
    private async writeAttachmentUnlocked(path: string, data: Uint8Array, { overwrite = false }: WriteOptions): Promise<boolean> {
        clearHandlers();
        let ctime = Date.now();
        const existing = await this.manipulator.get(path as FilePathWithPrefix, true);
        if (existing && !overwrite) throw new AttachmentExistsError(path);
        if (existing && "ctime" in existing) {
            ctime = existing.ctime;
        }
        // A binary blob makes the library store a "newnote" (binary) entry,
        // chunked and encrypted exactly as LiveSync does for files added in Obsidian.
        // Copy into a fresh ArrayBuffer-backed view: the blob type wants one.
        const blob = createBinaryBlob(new Uint8Array(data));
        return await this.manipulator.put(path, blob, {
            ctime,
            mtime: Date.now(),
            size: data.byteLength,
        });
    }

    async deleteAttachment(path: string): Promise<boolean> {
        validateAttachmentPath(path);
        const id = await this.manipulator.path2id(path as FilePathWithPrefix);
        return await this.docLock.run([id], async () => {
            clearHandlers();
            return await this.manipulator.delete(path);
        });
    }

    async moveAttachment(from: string, to: string, { maxBytes, ...options }: MoveOptions = {}): Promise<boolean> {
        validateAttachmentPath(from);
        validateAttachmentPath(to);
        const fromId = await this.manipulator.path2id(from as FilePathWithPrefix);
        const toId = await this.manipulator.path2id(to as FilePathWithPrefix);
        return await this.docLock.run([fromId, toId], async () => {
            // Checked from metadata first: a move loads the whole file, and a
            // file added in Obsidian can be far larger than any upload.
            const meta = await this.manipulator.get(from as FilePathWithPrefix, true);
            if (!meta) return false;
            if (from === to) return true;
            // Fails closed: a missing or non-numeric size doesn't let the file load.
            if (maxBytes !== undefined && !(Number.isFinite(meta.size) && meta.size <= maxBytes)) {
                throw new AttachmentTooLargeError(from, meta.size, maxBytes);
            }
            if (fromId !== toId && !options.overwrite && (await this.manipulator.get(to as FilePathWithPrefix, true))) {
                throw new AttachmentExistsError(to);
            }
            const entry = await this.manipulator.get(from as FilePathWithPrefix);
            if (!entry || !("data" in entry)) return false;
            const content = readContent(entry as LoadedEntry);
            const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
            // The stored size can understate the file; check what was loaded too.
            if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new AttachmentTooLargeError(from, bytes.byteLength, maxBytes);
            if (fromId === toId) {
                // Case-only rename on a case-insensitive vault: one document,
                // so rewrite it under the new path and delete nothing.
                return await this.writeAttachmentUnlocked(to, bytes, { overwrite: true });
            }
            const wrote = await this.writeAttachmentUnlocked(to, bytes, options);
            if (!wrote) return false;
            clearHandlers();
            let deleted = false;
            try {
                deleted = await this.manipulator.delete(from);
            } catch {
                // Reported below: the copy exists either way.
            }
            if (!deleted) throw new AttachmentMoveIncompleteError(from, to);
            return true;
        });
    }

    async getAttachmentInfo(path: string): Promise<AttachmentInfo | null> {
        validateAttachmentPath(path);
        const entry = await this.manipulator.get(path as FilePathWithPrefix, true);
        if (!entry) return null;
        return { path, size: entry.size, ctime: entry.ctime, mtime: entry.mtime };
    }
}
