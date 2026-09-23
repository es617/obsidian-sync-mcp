/**
 * Metadata index for vault notes.
 *
 * Tracks paths, mtimes, tags, links, and backlinks, and keeps the decrypted
 * note text in memory for `search_notes` (substring search over content).
 * Metadata persists to disk (encrypted if passphrase is set); the content map
 * is rebuilt from the vault at startup and is never written to disk.
 */

import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { parseFrontmatterAndLinks } from "./parse.js";


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

/**
 * Lifecycle of the in-memory index. "building" from construction until the
 * startup rebuild finishes, "ready" afterwards, "failed" if the rebuild threw.
 * Read by list_notes and search_notes so a client can tell a partial index from a complete one.
 */
export type IndexState = "building" | "ready" | "failed";

export interface SearchQuery {
    /** Case-insensitive substrings; a note matches when ANY term occurs (OR). A term may contain spaces. */
    terms?: string[];
    folder?: string;
    tag?: string;
    /** Only notes with mtime >= this (ms since epoch). */
    modifiedAfter?: number;
    limit?: number;
}

export interface SearchHit {
    path: string;
    mtime: number;
    /** Distinct terms that matched in path/title or content. */
    matched: number;
    /** True when the path or the frontmatter title matched. Name hits rank first. */
    nameHit: boolean;
    /** One line of context around the first content match; whitespace collapsed. Empty for a name-only hit. */
    snippet: string;
}

/** Cut a one-line snippet around `idx` (match of length `len`), whitespace collapsed. */
export function snippetAround(text: string, idx: number, len: number, context = 80): string {
    const start = Math.max(0, idx - context);
    const end = Math.min(text.length, idx + len + context);
    const body = text.slice(start, end).replace(/\s+/g, " ").trim();
    return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
}

export class SearchIndex {
    private _state: IndexState = "building";
    private mtimes = new Map<string, number>();
    private tags = new Map<string, string[]>();
    private links = new Map<string, string[]>();
    private backlinks = new Map<string, Set<string>>();
    private knownPaths = new Set<string>();
    /** Decrypted note text, in memory only — one copy per note; term matching is case-insensitive via a regex per term. */
    private content = new Map<string, string>();
    /** Frontmatter `title:` per path, when present — searched together with the path. */
    private titles = new Map<string, string>();
    private saving = false;
    private _since: string = "";
    /** When `since` last advanced from a completed catch-up or a watcher change (ms), null before the first. */
    private _lastSyncAt: number | null = null;
    private persistPath: string | null;
    private passphrase: string | null;

    constructor(persistPath?: string, passphrase?: string) {
        this.persistPath = persistPath ?? null;
        this.passphrase = passphrase ?? null;
    }

    /** Load metadata from disk. */
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
            console.log(`Search metadata loaded from disk (${this.knownPaths.size} notes, since: ${this._since ? "yes" : "none"}).`);
            return this.knownPaths.size > 0;
        } catch {
            return false;
        }
    }

    /** Save metadata to disk. Encrypted if passphrase is set. */
    async saveToDisk(): Promise<void> {
        if (!this.persistPath || this.saving) return;
        this.saving = true;
        try {
            await mkdir(dirname(this.persistPath), { recursive: true });
            let data = JSON.stringify({
                mtimes: Object.fromEntries(this.mtimes),
                tags: Object.fromEntries(this.tags),
                links: Object.fromEntries(this.links),
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
            this.clearBacklinks(path);
        }
        this.knownPaths.add(path);
        if (mtime !== undefined) this.mtimes.set(path, mtime);
        // Same code path for the startup catch-up, the watcher and the
        // pre-search catch-up: whatever updates metadata also updates content.
        this.content.set(path, content);
        const parsed = parseFrontmatterAndLinks(content);
        const title = parsed.frontmatter["title"];
        if (typeof title === "string" && title.trim().length > 0) {
            this.titles.set(path, title.trim());
        } else {
            this.titles.delete(path);
        }
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
            this.knownPaths.delete(path);
            this.mtimes.delete(path);
            this.tags.delete(path);
            this.content.delete(path);
            this.titles.delete(path);
            this.clearBacklinks(path);
        }
    }

    /** Decrypted text of a note, or null if the index holds no content for it. */
    getContent(path: string): string | null {
        return this.content.get(path) ?? null;
    }

    /** Notes whose text is in memory. Below `size` means search cannot see every note. */
    get contentCount(): number {
        return this.content.size;
    }

    /**
     * Search over path + frontmatter title first, then the in-memory text.
     * Ranked: name hits first, then number of distinct terms matched, then
     * newest first, then path. `limit` defaults to 20.
     */
    search(q: SearchQuery): { hits: SearchHit[]; total: number } {
        const prefix = q.folder ? (q.folder.endsWith("/") ? q.folder : q.folder + "/") : undefined;
        const terms = (q.terms ?? []).filter((t) => t.length > 0).map((t) => ({
            text: t.toLowerCase(),
            // Case-insensitive (Unicode) search over the note text without a lowercased copy of the vault in memory.
            re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"),
        }));
        const hits: SearchHit[] = [];
        for (const [path, entry] of this.content) {
            if (!path.endsWith(".md")) continue;
            if (prefix && !path.startsWith(prefix)) continue;
            if (q.tag && !this.getTags(path).includes(q.tag)) continue;
            const mtime = this.mtimes.get(path) ?? 0;
            if (q.modifiedAfter !== undefined && mtime < q.modifiedAfter) continue;
            // Step 1: path and title. Step 2: content. A term counts once even if it hits both.
            const title = this.titles.get(path);
            const name = title ? `${path} ${title}` : path;
            const nameLower = name.toLowerCase();
            let matched = 0;
            let nameHit = false;
            let anchor = -1;
            let anchorLen = 1;
            {
                for (const t of terms) {
                    const inName = nameLower.includes(t.text);
                    const i = entry.search(t.re);
                    if (!inName && i === -1) continue;
                    matched++;
                    if (inName) nameHit = true;
                    if (i !== -1 && (anchor === -1 || i < anchor)) {
                        anchor = i;
                        anchorLen = t.text.length;
                    }
                }
                if (matched === 0) continue;
            }
            const snippet = anchor === -1 ? "" : snippetAround(entry, anchor, anchorLen);
            hits.push({ path, mtime, matched, nameHit, snippet });
        }
        hits.sort(
            (a, b) =>
                Number(b.nameHit) - Number(a.nameHit) ||
                b.matched - a.matched ||
                b.mtime - a.mtime ||
                a.path.localeCompare(b.path),
        );
        return { hits: hits.slice(0, q.limit ?? 20), total: hits.length };
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
        this._state = "building";
    }

    get state(): IndexState {
        return this._state;
    }

    set state(value: IndexState) {
        this._state = value;
    }

    get since(): string {
        return this._since;
    }

    set since(value: string) {
        this._since = value;
    }

    get lastSyncAt(): number | null {
        return this._lastSyncAt;
    }

    set lastSyncAt(value: number | null) {
        this._lastSyncAt = value;
    }

    get size(): number {
        return this.knownPaths.size;
    }
}
