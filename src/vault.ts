/**
 * Vault access layer — wraps DirectFileManipulator from livesync-commonlib.
 */

import { DirectFileManipulator } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import type { DirectFileManipulatorOptions } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import { createTextBlob } from "../lib/livesync-commonlib/src/common/utils.ts";
import type { FilePathWithPrefix } from "../lib/livesync-commonlib/src/common/types.ts";
import type { ReadyEntry, MetaEntry } from "../lib/livesync-commonlib/src/API/DirectFileManipulatorV2.ts";
import { parseFrontmatterAndLinks } from "./parse.js";

export interface VaultConfig {
    couchdbUrl: string;
    couchdbUser: string;
    couchdbPassword: string;
    database: string;
    passphrase?: string;
}

export class Vault {
    private manipulator: DirectFileManipulator;

    constructor(config: VaultConfig) {
        const opts: DirectFileManipulatorOptions = {
            url: config.couchdbUrl,
            username: config.couchdbUser,
            password: config.couchdbPassword,
            database: config.database,
            passphrase: config.passphrase,
            obfuscatePassphrase: config.passphrase,
            useEden: false,
            enableCompression: false,
            handleFilenameCaseSensitive: false,
            doNotUseFixedRevisionForChunks: false,
        };
        this.manipulator = new DirectFileManipulator(opts);
    }

    async init(): Promise<void> {
        await this.manipulator.ready.promise;
    }

    async close(): Promise<void> {
        this.manipulator.endWatch();
        await this.manipulator.close();
    }

    watchChanges(callback: (path: string, content: string | null) => void): void {
        this.manipulator.beginWatch(
            (doc) => {
                const path = doc.path ?? "";
                if (!path.endsWith(".md")) return;
                if (doc.deleted) {
                    callback(path, null);
                } else {
                    const content = "data" in doc && Array.isArray(doc.data) ? doc.data.join("") : null;
                    callback(path, content);
                }
            },
            (meta) => {
                // Only interested in markdown files
                const path = meta.path ?? "";
                return path.endsWith(".md");
            },
        );
    }

    private validatePath(path: string): void {
        if (!path || path.includes("\0") || path.length > 1000) {
            throw new Error("Invalid path");
        }
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

    async getMetadata(path: string): Promise<{ path: string; size: number; ctime: number; mtime: number; frontmatter: Record<string, any>; tags: string[]; links: string[] } | null> {
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
        const paths: string[] = [];
        for await (const doc of this.manipulator.enumerateAllNormalDocs({ metaOnly: true })) {
            const entry = doc as MetaEntry;
            if (entry.deleted) continue;
            const notePath = entry.path ?? "";
            if (!notePath.endsWith(".md")) continue;
            if (folder) {
                if (!notePath.startsWith(folder)) continue;
            }
            paths.push(notePath);
        }
        return paths.sort();
    }

    async searchVault(query: string): Promise<Array<{ path: string; snippet: string }>> {
        const results: Array<{ path: string; snippet: string }> = [];
        const lowerQuery = query.toLowerCase();

        for await (const doc of this.manipulator.enumerateAllNormalDocs({ metaOnly: false })) {
            const entry = doc as ReadyEntry;
            if (entry.deleted) continue;
            const notePath = entry.path ?? "";
            if (!notePath.endsWith(".md")) continue;

            const content = entry.data?.join("") ?? "";
            const lowerContent = content.toLowerCase();
            const idx = lowerContent.indexOf(lowerQuery);
            if (idx === -1) continue;

            const start = Math.max(0, idx - 80);
            const end = Math.min(content.length, idx + query.length + 80);
            const snippet =
                (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");

            results.push({ path: notePath, snippet });
            if (results.length >= 50) break;
        }
        return results;
    }
}
