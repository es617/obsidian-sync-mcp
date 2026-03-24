import { readFile, writeFile, unlink, mkdir, stat, realpath } from "fs/promises";
import { dirname, resolve, sep } from "path";
import { realpathSync } from "fs";
import { glob } from "fs/promises";
import { parseFrontmatterAndLinks } from "./parse.js";

export class LocalVault {
    private root: string;

    constructor(vaultPath: string) {
        this.root = realpathSync(resolve(vaultPath));
    }

    private async safePath(path: string): Promise<string> {
        const full = resolve(this.root, path);
        // Lexical check first (catches ../ without hitting disk)
        if (!full.startsWith(this.root + sep)) {
            throw new Error("Path traversal blocked");
        }
        // Resolve symlinks and re-check (catches symlink escapes)
        try {
            const real = await realpath(full);
            if (!real.startsWith(this.root + sep)) {
                throw new Error("Path traversal blocked");
            }
            return real;
        } catch (e: any) {
            if (e.code === "ENOENT") return full; // file doesn't exist yet (write)
            throw e;
        }
    }

    async init(): Promise<void> {}

    async close(): Promise<void> {}

    async readNote(path: string): Promise<string | null> {
        const fullPath = await this.safePath(path);
        try {
            return await readFile(fullPath, "utf-8");
        } catch {
            return null;
        }
    }

    async writeNote(path: string, content: string): Promise<boolean> {
        const fullPath = await this.safePath(path);
        try {
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, content, "utf-8");
            return true;
        } catch {
            return false;
        }
    }

    async deleteNote(path: string): Promise<boolean> {
        const fullPath = await this.safePath(path);
        try {
            await unlink(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    async moveNote(from: string, to: string): Promise<boolean> {
        const content = await this.readNote(from);
        if (content === null) return false;
        const wrote = await this.writeNote(to, content);
        if (!wrote) return false;
        return await this.deleteNote(from);
    }

    async getMetadata(path: string): Promise<{ path: string; size: number; ctime: number; mtime: number; frontmatter: Record<string, any>; tags: string[]; links: string[] } | null> {
        const fullPath = await this.safePath(path);
        try {
            const [content, s] = await Promise.all([
                readFile(fullPath, "utf-8"),
                stat(fullPath),
            ]);
            return {
                path,
                size: s.size,
                ctime: s.birthtimeMs,
                mtime: s.mtimeMs,
                ...parseFrontmatterAndLinks(content),
            };
        } catch {
            return null;
        }
    }

    async listNotes(folder?: string): Promise<string[]> {
        if (folder && !folder.endsWith("/") && !folder.endsWith("\\")) folder += "/";
        const searchDir = folder ? await this.safePath(folder) : this.root;
        const paths: string[] = [];
        try {
            for await (const entry of glob("**/*.md", { cwd: searchDir })) {
                const notePath = folder ? `${folder}${entry}` : entry;
                paths.push(notePath);
            }
        } catch {
            // Directory doesn't exist
        }
        return paths.sort();
    }

    async searchVault(query: string): Promise<Array<{ path: string; snippet: string }>> {
        const results: Array<{ path: string; snippet: string }> = [];
        const lowerQuery = query.toLowerCase();
        const notes = await this.listNotes();

        for (const notePath of notes) {
            const content = await this.readNote(notePath);
            if (!content) continue;

            const idx = content.toLowerCase().indexOf(lowerQuery);
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
