/**
 * Full-text search index backed by FlexSearch.
 *
 * - Updates incrementally on write/delete/move
 * - Persists everything to disk (encrypted if passphrase is set):
 *   metadata (mtimes, tags, links) + FlexSearch tokenized index
 * - Cold start loads from disk, diffs mtimes, reads only changed notes
 * - Survives suspend/resume (memory preserved) and cold restarts (disk)
 */

import FlexSearch from "flexsearch";
import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { parseFrontmatterAndLinks } from "./parse.js";

const MAX_RESULTS = 50;

function encrypt(text: string, passphrase: string): string {
    const salt = randomBytes(16);
    const key = scryptSync(passphrase, salt, 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
    const tag = (cipher as any).getAuthTag() as Buffer;
    return salt.toString("hex") + ":" + iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(data: string, passphrase: string): string {
    const [saltHex, ivHex, tagHex, encryptedHex] = data.split(":");
    const key = scryptSync(passphrase, Buffer.from(saltHex, "hex"), 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    (decipher as any).setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]).toString("utf-8");
}

export class SearchIndex {
    private index: FlexSearch.Document<{ path: string; content: string }>;
    private mtimes = new Map<string, number>();
    private tags = new Map<string, string[]>();
    private links = new Map<string, string[]>();
    private backlinks = new Map<string, Set<string>>();
    private knownPaths = new Set<string>();
    private flexSearchReady = false;
    private saving = false;
    private _since: string = "";
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

    /** Load full index from disk (metadata + FlexSearch). */
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
            for (const [path, t] of Object.entries(data.tags ?? {})) {
                this.tags.set(path, t as string[]);
            }
            for (const [path, l] of Object.entries(data.links ?? {})) {
                const targets = l as string[];
                this.links.set(path, targets);
                for (const target of targets) {
                    const key = target.toLowerCase();
                    if (!this.backlinks.has(key)) this.backlinks.set(key, new Set());
                    this.backlinks.get(key)!.add(path);
                }
            }
            if (data.since) this._since = data.since;
            // Restore FlexSearch tokenized index
            if (data.flexsearch && data.flexsearch.length > 0) {
                for (const { key, value } of data.flexsearch) {
                    this.index.import(key, value);
                }
                this.flexSearchReady = true;
            }
            console.log(`Search index loaded from disk (${this.knownPaths.size} notes${this.flexSearchReady ? "" : ", text index needs rebuild"}).`);
            return this.knownPaths.size > 0;
        } catch {
            return false;
        }
    }

    /** Save full index to disk (metadata + FlexSearch). Encrypted if passphrase is set. */
    async saveToDisk(): Promise<void> {
        if (!this.persistPath || this.saving) return;
        this.saving = true;
        try {
            await mkdir(dirname(this.persistPath), { recursive: true });
            // Export FlexSearch tokenized index (sync callback — verified by persistence round-trip test)
            const flexChunks: Array<{ key: string; value: string }> = [];
            this.index.export((key: string, value: string) => {
                if (value !== undefined) flexChunks.push({ key, value });
            });
            let data = JSON.stringify({
                mtimes: Object.fromEntries(this.mtimes),
                tags: Object.fromEntries(this.tags),
                links: Object.fromEntries(this.links),
                flexsearch: flexChunks,
                since: this._since,
            });
            if (this.passphrase) {
                data = encrypt(data, this.passphrase);
            }
            await writeFile(this.persistPath, data, { encoding: "utf-8", mode: 0o600 });
            await chmod(this.persistPath, 0o600);
            console.log(`Search index saved to disk (${this.knownPaths.size} notes${this.passphrase ? ", encrypted" : ""}).`);
        } catch (err) {
            console.error("Failed to save search index:", err);
        } finally {
            this.saving = false;
        }
    }

    /** Add or update a note in the index. */
    update(path: string, content: string, mtime?: number): void {
        if (this.knownPaths.has(path)) {
            this.index.remove(path);
            this.clearBacklinks(path);
        }
        this.index.add({ path, content });
        this.knownPaths.add(path);
        this.flexSearchReady = true;
        if (mtime !== undefined) this.mtimes.set(path, mtime);
        const parsed = parseFrontmatterAndLinks(content);
        if (parsed.tags.length > 0) {
            this.tags.set(path, parsed.tags);
        } else {
            this.tags.delete(path);
        }
        if (parsed.links.length > 0) {
            this.links.set(path, parsed.links);
            for (const target of parsed.links) {
                const key = target.toLowerCase();
                if (!this.backlinks.has(key)) this.backlinks.set(key, new Set());
                this.backlinks.get(key)!.add(path);
            }
        } else {
            this.links.delete(path);
        }
    }

    /** Remove a note from the index. */
    remove(path: string): void {
        if (this.knownPaths.has(path)) {
            this.index.remove(path);
            this.knownPaths.delete(path);
            this.mtimes.delete(path);
            this.tags.delete(path);
            this.clearBacklinks(path);
        }
    }

    /** Remove all backlink entries where path is the source. */
    private clearBacklinks(path: string): void {
        const oldLinks = this.links.get(path);
        if (oldLinks) {
            for (const target of oldLinks) {
                const key = target.toLowerCase();
                this.backlinks.get(key)?.delete(path);
                if (this.backlinks.get(key)?.size === 0) this.backlinks.delete(key);
            }
        }
        this.links.delete(path);
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

    /** Whether the FlexSearch index needs rebuilding (has metadata but no text index). */
    get needsRebuild(): boolean {
        return this.knownPaths.size > 0 && !this.flexSearchReady;
    }

    /** Get mtime for a path. */
    getMtime(path: string): number {
        return this.mtimes.get(path) ?? 0;
    }

    /** Get tags for a path. */
    getTags(path: string): string[] {
        return this.tags.get(path) ?? [];
    }

    /** Get outgoing links for a path. */
    getLinks(path: string): string[] {
        return this.links.get(path) ?? [];
    }

    /** Get backlinks for a path (notes that link to it). Case-insensitive, matches by full path or filename. */
    getBacklinks(path: string): string[] {
        const results = new Set<string>();
        const withMd = (path.endsWith(".md") ? path : path + ".md").toLowerCase();
        const withoutMd = (path.endsWith(".md") ? path.slice(0, -3) : path).toLowerCase();
        const nameOnly = withoutMd.includes("/") ? withoutMd.slice(withoutMd.lastIndexOf("/") + 1) : withoutMd;

        for (const target of [withMd, withoutMd, nameOnly]) {
            const sources = this.backlinks.get(target);
            if (sources) {
                for (const s of sources) results.add(s);
            }
        }
        return [...results].sort();
    }

    /** List all tags across the vault with counts. */
    listAllTags(): Array<{ tag: string; count: number }> {
        const counts = new Map<string, number>();
        for (const tags of this.tags.values()) {
            for (const t of tags) {
                counts.set(t, (counts.get(t) ?? 0) + 1);
            }
        }
        return [...counts.entries()]
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);
    }

    /** Clear all index data (for full rebuild after DB nuke). */
    clear(): void {
        const paths = Array.from(this.knownPaths);
        for (const p of paths) this.remove(p);
        this._since = "";
        this.flexSearchReady = false;
    }

    get since(): string {
        return this._since;
    }

    set since(value: string) {
        this._since = value;
    }

    get size(): number {
        return this.knownPaths.size;
    }
}
