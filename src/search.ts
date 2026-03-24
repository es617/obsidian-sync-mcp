/**
 * Full-text search index backed by FlexSearch.
 *
 * - Builds in-memory index on startup from all notes
 * - Updates incrementally on write/delete/move
 * - Persists to disk on clean shutdown, loads on next startup
 * - Survives suspend/resume (memory preserved)
 */

import FlexSearch from "flexsearch";
import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";

const MAX_RESULTS = 50;

export class SearchIndex {
    private index: FlexSearch.Document<{ path: string; content: string }>;
    private contents = new Map<string, string>(); // path -> content (for snippet extraction)
    private persistPath: string | null;

    constructor(persistPath?: string) {
        this.persistPath = persistPath ?? null;
        this.index = new FlexSearch.Document({
            document: { id: "path", index: ["content", "path"] },
            tokenize: "forward",
        });
    }

    /** Try to load a persisted index from disk. Returns true if loaded. */
    async loadFromDisk(): Promise<boolean> {
        if (!this.persistPath) return false;
        try {
            const data = await readFile(this.persistPath, "utf-8");
            const { contents } = JSON.parse(data);
            for (const [path, content] of Object.entries(contents)) {
                this.index.add({ path, content: content as string });
                this.contents.set(path, content as string);
            }
            console.log(`Search index loaded from disk (${this.contents.size} notes).`);
            return true;
        } catch {
            return false;
        }
    }

    /** Save the index to disk. */
    async saveToDisk(): Promise<void> {
        if (!this.persistPath) return;
        try {
            await mkdir(dirname(this.persistPath), { recursive: true });
            const data = JSON.stringify({
                contents: Object.fromEntries(this.contents),
            });
            await writeFile(this.persistPath, data, { encoding: "utf-8", mode: 0o600 });
            await chmod(this.persistPath, 0o600);
            console.log(`Search index saved to disk (${this.contents.size} notes).`);
        } catch (err) {
            console.error("Failed to save search index:", err);
        }
    }

    /** Add or update a note in the index. */
    update(path: string, content: string): void {
        // FlexSearch requires remove before update
        if (this.contents.has(path)) {
            this.index.remove(path);
        }
        this.index.add({ path, content });
        this.contents.set(path, content);
    }

    /** Remove a note from the index. */
    remove(path: string): void {
        if (this.contents.has(path)) {
            this.index.remove(path);
            this.contents.delete(path);
        }
    }

    /** Search for a query. Returns paths with snippets. */
    search(query: string): Array<{ path: string; snippet: string }> {
        const results = this.index.search(query, { limit: MAX_RESULTS });

        // FlexSearch returns results per index field — merge and deduplicate
        const paths = new Set<string>();
        for (const result of results) {
            if (result.result) {
                for (const id of result.result) {
                    paths.add(id as string);
                }
            }
        }

        const output: Array<{ path: string; snippet: string }> = [];
        const lowerQuery = query.toLowerCase();

        for (const path of paths) {
            if (output.length >= MAX_RESULTS) break;
            const content = this.contents.get(path);
            if (!content) continue;

            // Extract snippet around first match
            const idx = content.toLowerCase().indexOf(lowerQuery);
            if (idx !== -1) {
                const start = Math.max(0, idx - 80);
                const end = Math.min(content.length, idx + query.length + 80);
                const snippet =
                    (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");
                output.push({ path, snippet });
            } else {
                // FlexSearch matched via tokenization — show beginning of content
                output.push({ path, snippet: content.slice(0, 160) + (content.length > 160 ? "..." : "") });
            }
        }

        return output;
    }

    /** List all indexed paths, optionally filtered by folder prefix. */
    listPaths(folder?: string): string[] {
        const paths = [...this.contents.keys()].filter((p) => p.endsWith(".md"));
        if (folder) {
            return paths.filter((p) => p.startsWith(folder)).sort();
        }
        return paths.sort();
    }

    get size(): number {
        return this.contents.size;
    }
}
