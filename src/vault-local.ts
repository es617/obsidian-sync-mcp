import { readFile, writeFile, unlink, mkdir, stat, realpath, rename } from "fs/promises";
import { dirname, resolve, sep } from "path";
import { realpathSync } from "fs";
import { glob } from "fs/promises";
import { parseFrontmatterAndLinks } from "./parse.js";
import type { VaultBackend, NoteInfo, NoteListing } from "./vault-backend.js";

export class LocalVault implements VaultBackend {
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
        const fromPath = await this.safePath(from);
        const toPath = await this.safePath(to);
        try {
            await mkdir(dirname(toPath), { recursive: true });
            await rename(fromPath, toPath);
            return true;
        } catch (e: any) {
            if (e.code === "EXDEV") {
                // Cross-device: fall back to copy-delete
                const content = await this.readNote(from);
                if (content === null) return false;
                const wrote = await this.writeNote(to, content);
                if (!wrote) return false;
                return await this.deleteNote(from);
            }
            return false;
        }
    }

    async getMetadata(path: string): Promise<NoteInfo | null> {
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
        const notes = await this.listNotesWithMtime(folder);
        return notes.map((n) => n.path);
    }

    async listNotesWithMtime(folder?: string): Promise<NoteListing[]> {
        if (folder && !folder.endsWith("/") && !folder.endsWith("\\")) folder += "/";
        const searchDir = folder ? await this.safePath(folder) : this.root;
        const entries: string[] = [];
        try {
            for await (const entry of glob("**/*.md", { cwd: searchDir })) {
                entries.push(folder ? `${folder}${entry}` : entry);
            }
        } catch {
            return [];
        }
        const results = await Promise.all(
            entries.map(async (p) => {
                try {
                    const s = await stat(resolve(this.root, p));
                    return { path: p, mtime: s.mtimeMs };
                } catch {
                    return { path: p, mtime: 0 };
                }
            }),
        );
        return results.sort((a, b) => a.path.localeCompare(b.path));
    }

}
