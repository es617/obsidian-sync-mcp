import { readFile, writeFile, unlink, mkdir, stat, realpath, rename } from "fs/promises";
import { dirname, resolve, sep } from "path";
import { realpathSync } from "fs";
import { glob } from "fs/promises";
import { parseFrontmatterAndLinks } from "./parse.js";
import { validateNotePath, isValidNotePath } from "./note-path.js";
import { validateAttachmentPath, isValidAttachmentPath } from "./attachment-path.js";
import type { VaultBackend, NoteInfo, NoteListing, AttachmentInfo } from "./vault-backend.js";

export class LocalVault implements VaultBackend {
    private root: string;

    constructor(vaultPath: string) {
        this.root = realpathSync(resolve(vaultPath));
    }

    private async safePath(path: string, kind: "note" | "attachment" | "folder" = "folder"): Promise<string> {
        // Note operations must target a real note (.md, no dot-folders, etc.)
        // and attachment operations an allowed media file; folder listing
        // passes a directory and skips this.
        if (kind === "note") validateNotePath(path);
        if (kind === "attachment") validateAttachmentPath(path);
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
            if (e.code !== "ENOENT") throw e;
            // The file (or a parent) doesn't exist yet. Confirm the nearest
            // existing ancestor still resolves inside the vault, so a symlinked
            // parent directory can't redirect a write outside the root.
            if (!(await this.realpathWithinRoot(dirname(full)))) {
                throw new Error("Path traversal blocked");
            }
            return full;
        }
    }

    private async realpathWithinRoot(target: string): Promise<boolean> {
        let current = target;
        for (;;) {
            try {
                const real = await realpath(current);
                return real === this.root || real.startsWith(this.root + sep);
            } catch (e: any) {
                if (e.code !== "ENOENT") throw e;
                const parent = dirname(current);
                if (parent === current) return false; // reached filesystem root
                current = parent;
            }
        }
    }

    async init(): Promise<void> {}

    async close(): Promise<void> {}

    async readNote(path: string): Promise<string | null> {
        const fullPath = await this.safePath(path, "note");
        try {
            return await readFile(fullPath, "utf-8");
        } catch {
            return null;
        }
    }

    async writeNote(path: string, content: string): Promise<boolean> {
        const fullPath = await this.safePath(path, "note");
        try {
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, content, "utf-8");
            return true;
        } catch {
            return false;
        }
    }

    async deleteNote(path: string): Promise<boolean> {
        const fullPath = await this.safePath(path, "note");
        try {
            await unlink(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    async moveNote(from: string, to: string): Promise<boolean> {
        const fromPath = await this.safePath(from, "note");
        const toPath = await this.safePath(to, "note");
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
        const fullPath = await this.safePath(path, "note");
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
                const full = folder ? `${folder}${entry}` : entry;
                if (!isValidNotePath(full)) continue;
                entries.push(full);
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

    async writeAttachment(path: string, data: Uint8Array): Promise<boolean> {
        const fullPath = await this.safePath(path, "attachment");
        try {
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, data);
            return true;
        } catch {
            return false;
        }
    }

    async deleteAttachment(path: string): Promise<boolean> {
        const fullPath = await this.safePath(path, "attachment");
        try {
            await unlink(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    async moveAttachment(from: string, to: string): Promise<boolean> {
        const fromPath = await this.safePath(from, "attachment");
        const toPath = await this.safePath(to, "attachment");
        try {
            await mkdir(dirname(toPath), { recursive: true });
            await rename(fromPath, toPath);
            return true;
        } catch (e: any) {
            if (e.code !== "EXDEV") return false;
            // Cross-device: fall back to copy-delete
            try {
                const data = await readFile(fromPath);
                await writeFile(toPath, data);
                await unlink(fromPath);
                return true;
            } catch {
                return false;
            }
        }
    }

    async getAttachmentInfo(path: string): Promise<AttachmentInfo | null> {
        const fullPath = await this.safePath(path, "attachment");
        try {
            const s = await stat(fullPath);
            if (!s.isFile()) return null;
            return { path, size: s.size, ctime: s.birthtimeMs, mtime: s.mtimeMs };
        } catch {
            return null;
        }
    }

    async listAttachments(): Promise<AttachmentInfo[]> {
        const results: AttachmentInfo[] = [];
        try {
            // Dot-folders (.obsidian, .trash, .git) are never attachments; skip them while walking.
            for await (const entry of glob("**/*", { cwd: this.root, exclude: (p: any) => String(typeof p === "string" ? p : p.name).split(/[/\\]/).some((seg: string) => seg.startsWith(".")) })) {
                const path = entry.replace(/\\/g, "/");
                if (!isValidAttachmentPath(path)) continue;
                try {
                    const s = await stat(resolve(this.root, path));
                    if (s.isFile()) results.push({ path, size: s.size, ctime: s.birthtimeMs, mtime: s.mtimeMs });
                } catch {
                    // Vanished between listing and stat.
                }
            }
        } catch {
            return [];
        }
        return results.sort((a, b) => a.path.localeCompare(b.path));
    }
}
