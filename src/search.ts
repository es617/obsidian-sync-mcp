/**
 * Full-text search index backed by FlexSearch.
 *
 * - Builds in-memory index on startup from all notes
 * - Updates incrementally on write/delete/move
 * - Persists paths + mtimes to disk (encrypted if passphrase is set)
 * - FlexSearch tokenized index is in memory only (rebuilt on cold start)
 * - Survives suspend/resume (memory preserved)
 */

import FlexSearch from "flexsearch";
import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const MAX_RESULTS = 50;

function encrypt(text: string, passphrase: string): string {
    const salt = randomBytes(16);
    const key = scryptSync(passphrase, salt, 32);
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
    return salt.toString("hex") + ":" + iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(data: string, passphrase: string): string {
    const [saltHex, ivHex, encryptedHex] = data.split(":");
    const key = scryptSync(passphrase, Buffer.from(saltHex, "hex"), 32);
    const decipher = createDecipheriv("aes-256-cbc", key, Buffer.from(ivHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]).toString("utf-8");
}

export class SearchIndex {
    private index: FlexSearch.Document<{ path: string; content: string }>;
    private mtimes = new Map<string, number>();
    private knownPaths = new Set<string>();
    private persistPath: string | null;
    private passphrase: string | null;

    constructor(persistPath?: string, passphrase?: string) {
        this.persistPath = persistPath ?? null;
        this.passphrase = passphrase ?? null;
        this.index = new FlexSearch.Document({
            document: { id: "path", index: ["content", "path"] },
            tokenize: "forward",
        });
    }

    /** Load paths + mtimes from disk. FlexSearch index needs rebuild after this. */
    async loadFromDisk(): Promise<boolean> {
        if (!this.persistPath) return false;
        try {
            let raw = await readFile(this.persistPath, "utf-8");
            if (this.passphrase) {
                raw = decrypt(raw, this.passphrase);
            }
            const data = JSON.parse(raw);
            for (const [path, mtime] of Object.entries(data.mtimes ?? {})) {
                this.mtimes.set(path, mtime as number);
                this.knownPaths.add(path);
            }
            console.log(`Search metadata loaded from disk (${this.knownPaths.size} notes). Index rebuild needed.`);
            return this.knownPaths.size > 0;
        } catch {
            return false;
        }
    }

    /** Save paths + mtimes to disk. Encrypted if passphrase is set. */
    async saveToDisk(): Promise<void> {
        if (!this.persistPath) return;
        try {
            await mkdir(dirname(this.persistPath), { recursive: true });
            let data = JSON.stringify({
                mtimes: Object.fromEntries(this.mtimes),
            });
            if (this.passphrase) {
                data = encrypt(data, this.passphrase);
            }
            await writeFile(this.persistPath, data, { encoding: "utf-8", mode: 0o600 });
            await chmod(this.persistPath, 0o600);
            console.log(`Search metadata saved to disk (${this.knownPaths.size} notes${this.passphrase ? ", encrypted" : ""}).`);
        } catch (err) {
            console.error("Failed to save search metadata:", err);
        }
    }

    /** Add or update a note in the index. */
    update(path: string, content: string, mtime?: number): void {
        if (this.knownPaths.has(path)) {
            this.index.remove(path);
        }
        this.index.add({ path, content });
        this.knownPaths.add(path);
        if (mtime !== undefined) this.mtimes.set(path, mtime);
    }

    /** Remove a note from the index. */
    remove(path: string): void {
        if (this.knownPaths.has(path)) {
            this.index.remove(path);
            this.knownPaths.delete(path);
            this.mtimes.delete(path);
        }
    }

    /** Search for a query. Returns matching paths (caller fetches content for snippets). */
    search(query: string): string[] {
        const results = this.index.search(query, { limit: MAX_RESULTS });

        const paths = new Set<string>();
        for (const result of results) {
            if (result.result) {
                for (const id of result.result) {
                    paths.add(id as string);
                }
            }
        }

        return [...paths].slice(0, MAX_RESULTS);
    }

    /** List all indexed paths, optionally filtered by folder prefix. */
    listPaths(folder?: string): string[] {
        return this.listWithMtime(folder).map((n) => n.path);
    }

    /** List all indexed paths with mtimes, optionally filtered by folder prefix. */
    listWithMtime(folder?: string): Array<{ path: string; mtime: number }> {
        const prefix = folder && !folder.endsWith("/") ? folder + "/" : folder;
        const entries = [...this.knownPaths]
            .filter((p) => p.endsWith(".md"))
            .filter((p) => !prefix || p.startsWith(prefix))
            .map((p) => ({ path: p, mtime: this.mtimes.get(p) ?? 0 }));
        return entries.sort((a, b) => a.path.localeCompare(b.path));
    }

    /** Whether the FlexSearch index needs rebuilding (has metadata but no indexed content). */
    get needsRebuild(): boolean {
        return this.knownPaths.size > 0 && this.index.search("a", { limit: 1 }).length === 0;
    }

    /** Get mtime for a path. */
    getMtime(path: string): number {
        return this.mtimes.get(path) ?? 0;
    }

    get size(): number {
        return this.knownPaths.size;
    }
}
