/** Metadata access and search facade, backed by SQLite when search is enabled. */

import { parseFrontmatterAndLinks } from "./parse.js";
import type { FullTextIndex, FullTextSearchOptions, FullTextSearchResult } from "./full-text-search.js";

export type SearchBuildState = "ready" | "building" | "catching_up" | "error";
export interface SearchBuildStatus {
    state: SearchBuildState;
    processed: number;
    total?: number;
    message?: string;
    notes: number;
    chunks: number;
}

export interface IndexedNoteListing { path: string; mtime: number }
export interface FilesystemIndexSyncPlan {
    remove: string[];
    read: IndexedNoteListing[];
    unchanged: number;
}

/** Plan a local startup reconciliation without reading unchanged note bodies. */
export function planFilesystemIndexSync(
    indexedNotes: IndexedNoteListing[],
    vaultNotes: IndexedNoteListing[],
): FilesystemIndexSyncPlan {
    const indexed = new Map(indexedNotes.map((note) => [note.path, note.mtime]));
    const vaultPaths = new Set(vaultNotes.map((note) => note.path));
    const remove = indexedNotes
        .filter((note) => !vaultPaths.has(note.path))
        .map((note) => note.path)
        .sort();
    const read = vaultNotes.filter((note) => indexed.get(note.path) !== note.mtime);
    return { remove, read, unchanged: vaultNotes.length - read.length };
}

export class SearchIndex {
    // Used only when FULL_TEXT_SEARCH=false. The normal path keeps metadata in SQLite.
    private mtimes = new Map<string, number>();
    private tags = new Map<string, string[]>();
    private links = new Map<string, string[]>();
    private backlinks = new Map<string, Set<string>>();
    private knownPaths = new Set<string>();
    private _since = "";
    private fullTextIndex: FullTextIndex | null;
    private buildState: Omit<SearchBuildStatus, "notes" | "chunks"> = {
        state: "ready",
        processed: 0,
    };

    constructor(fullTextIndex?: FullTextIndex) {
        this.fullTextIndex = fullTextIndex ?? null;
    }

    update(path: string, content: string, mtime?: number): void {
        if (this.fullTextIndex) {
            this.fullTextIndex.update(path, content, mtime);
            return;
        }
        if (this.knownPaths.has(path)) this.clearBacklinks(path);
        this.knownPaths.add(path);
        if (mtime !== undefined) this.mtimes.set(path, mtime);
        const parsed = parseFrontmatterAndLinks(content);
        if (parsed.tags.length > 0) this.tags.set(path, parsed.tags);
        else this.tags.delete(path);
        if (parsed.links.length > 0) {
            this.links.set(path, parsed.links);
            for (const target of parsed.links) {
                const key = target.toLowerCase();
                if (!this.backlinks.has(key)) this.backlinks.set(key, new Set());
                this.backlinks.get(key)!.add(path);
            }
        } else this.links.delete(path);
    }

    remove(path: string): void {
        if (this.fullTextIndex) {
            this.fullTextIndex.remove(path);
            return;
        }
        if (this.knownPaths.has(path)) {
            this.knownPaths.delete(path);
            this.mtimes.delete(path);
            this.tags.delete(path);
            this.clearBacklinks(path);
        }
    }

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

    listPaths(folder?: string): string[] { return this.listWithMtime(folder).map((note) => note.path); }
    listWithMtime(folder?: string): Array<{ path: string; mtime: number }> {
        if (this.fullTextIndex) return this.fullTextIndex.listWithMtime(folder);
        const prefix = folder && !folder.endsWith("/") ? `${folder}/` : folder;
        return [...this.knownPaths]
            .filter((path) => path.endsWith(".md"))
            .filter((path) => !prefix || path.startsWith(prefix))
            .map((path) => ({ path, mtime: this.mtimes.get(path) ?? 0 }))
            .sort((left, right) => left.path.localeCompare(right.path));
    }
    getMtime(path: string): number {
        return this.fullTextIndex?.getMtime(path) ?? this.mtimes.get(path) ?? 0;
    }
    getTags(path: string): string[] { return this.fullTextIndex?.getTags(path) ?? this.tags.get(path) ?? []; }
    getLinks(path: string): string[] { return this.fullTextIndex?.getLinks(path) ?? this.links.get(path) ?? []; }
    getBacklinks(path: string): string[] {
        if (this.fullTextIndex) return this.fullTextIndex.getBacklinks(path);
        const results = new Set<string>();
        const withMd = (path.endsWith(".md") ? path : `${path}.md`).toLowerCase();
        const withoutMd = (path.endsWith(".md") ? path.slice(0, -3) : path).toLowerCase();
        const nameOnly = withoutMd.includes("/")
            ? withoutMd.slice(withoutMd.lastIndexOf("/") + 1)
            : withoutMd;
        for (const target of [withMd, withoutMd, nameOnly]) {
            for (const source of this.backlinks.get(target) ?? []) results.add(source);
        }
        return [...results].sort();
    }
    listAllTags(): Array<{ tag: string; count: number }> {
        if (this.fullTextIndex) return this.fullTextIndex.listAllTags();
        const counts = new Map<string, number>();
        for (const noteTags of this.tags.values()) {
            for (const tag of noteTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
        return [...counts.entries()]
            .map(([tag, count]) => ({ tag, count }))
            .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
    }

    clear(): void {
        if (this.fullTextIndex) {
            this.fullTextIndex.clear();
            return;
        }
        this.mtimes.clear();
        this.tags.clear();
        this.links.clear();
        this.backlinks.clear();
        this.knownPaths.clear();
        this._since = "";
    }
    beginBatch(): void { this.fullTextIndex?.beginBatch(); }
    commitBatch(): void { this.fullTextIndex?.commitBatch(); }
    rollbackBatch(): void { this.fullTextIndex?.rollbackBatch(); }
    searchNotes(options: FullTextSearchOptions): FullTextSearchResult[] {
        return this.fullTextIndex?.search(options) ?? [];
    }

    setBuildStatus(
        state: SearchBuildState,
        processed = this.buildState.processed,
        total?: number,
        message?: string,
    ): void {
        this.buildState = { state, processed, total, message };
    }
    get status(): SearchBuildStatus {
        return {
            ...this.buildState,
            notes: this.size,
            chunks: this.fullTextIndex?.chunkCount ?? 0,
        };
    }
    get fullTextEnabled(): boolean { return this.fullTextIndex !== null; }
    get fullTextSize(): number { return this.fullTextIndex?.size ?? 0; }
    get fullTextCreatedFresh(): boolean { return this.fullTextIndex?.createdFresh ?? false; }
    close(): void { this.fullTextIndex?.close(); }
    get since(): string { return this.fullTextIndex?.checkpoint ?? this._since; }
    set since(value: string) {
        if (this.fullTextIndex) this.fullTextIndex.checkpoint = value;
        else this._since = value;
    }
    get size(): number { return this.fullTextIndex?.size ?? this.knownPaths.size; }
}
