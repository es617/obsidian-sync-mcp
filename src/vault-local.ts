import { readFile, writeFile, unlink, mkdir, stat, lstat, realpath, rename, link, copyFile } from "fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { realpathSync, constants } from "fs";
import { glob } from "fs/promises";
import { parseFrontmatterAndLinks } from "./parse.js";
import { validateNotePath, isValidNotePath } from "./note-path.js";
import { validateAttachmentPath, isValidAttachmentPath } from "./attachment-path.js";
import { AttachmentExistsError, type VaultBackend, type NoteInfo, type NoteListing, type AttachmentInfo, type WriteOptions, type MoveOptions } from "./vault-backend.js";

export class LocalVault implements VaultBackend {
    private root: string;

    constructor(vaultPath: string) {
        this.root = realpathSync(resolve(vaultPath));
    }

    private async safePath(path: string, kind: "note" | "attachment" | "folder" = "folder", { noSymlink = false } = {}): Promise<string> {
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
        // Resolve symlinks and re-check (catches symlink escapes). A path
        // that doesn't exist yet resolves through its nearest existing
        // ancestor, so a symlinked parent can't redirect a write either.
        const real = await this.resolveExisting(full);
        if (!real.startsWith(this.root + sep)) {
            throw new Error("Path traversal blocked");
        }
        // The name was validated, but a symlink inside the vault can point at
        // a note, a dot-folder or another type, so the target must pass too.
        if (kind !== "folder" && !this.isValidKind(relative(this.root, real), kind)) {
            throw new Error("Path traversal blocked");
        }
        // realpath fails with ENOENT on a dangling symlink, so it resolves as
        // a new file, but a write would follow it and create outside the vault.
        if (await this.hasDanglingSymlink(full)) {
            throw new Error("Path traversal blocked");
        }
        // Writing or deleting through a symlink would act on its target, a
        // different path from the one the caller named.
        if (noSymlink && (await this.isSymlink(full))) {
            throw new Error(`Refusing to modify a symlink: ${path}`);
        }
        return real;
    }

    private isValidKind(rel: string, kind: "note" | "attachment"): boolean {
        const path = rel.split(sep).join("/");
        return kind === "note" ? isValidNotePath(path) : isValidAttachmentPath(path);
    }

    private async isSymlink(full: string): Promise<boolean> {
        try {
            return (await lstat(full)).isSymbolicLink();
        } catch (e: any) {
            if (e.code === "ENOENT") return false;
            throw e;
        }
    }

    /**
     * realpath of `full`, or for a path that doesn't exist yet the realpath of
     * its nearest existing ancestor joined with the rest.
     */
    private async resolveExisting(full: string): Promise<string> {
        const rest: string[] = [];
        let current = full;
        for (;;) {
            try {
                return join(await realpath(current), ...rest);
            } catch (e: any) {
                if (e.code !== "ENOENT") throw e;
                const parent = dirname(current);
                if (parent === current) return full; // reached filesystem root
                rest.unshift(basename(current));
                current = parent;
            }
        }
    }

    /** Whether `full` or one of its ancestors below the root is a symlink to nothing. */
    private async hasDanglingSymlink(full: string): Promise<boolean> {
        for (let current = full; current !== this.root; current = dirname(current)) {
            let s;
            try {
                s = await lstat(current);
            } catch (e: any) {
                if (e.code === "ENOENT") continue;
                throw e;
            }
            // The nearest existing entry decides: anything but a symlink is
            // real, and a resolvable symlink was checked by resolveExisting.
            if (!s.isSymbolicLink()) return false;
            try {
                await realpath(current);
                return false;
            } catch (e: any) {
                if (e.code === "ENOENT") return true;
                throw e;
            }
        }
        return false;
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

    async writeAttachment(path: string, data: Uint8Array, { overwrite = false }: WriteOptions = {}): Promise<boolean> {
        const fullPath = await this.safePath(path, "attachment", { noSymlink: true });
        try {
            await mkdir(dirname(fullPath), { recursive: true });
            // "wx" (O_EXCL) fails if the file exists, in the same step as the
            // create, so two concurrent creates can't both succeed.
            await writeFile(fullPath, data, { flag: overwrite ? "w" : "wx" });
            return true;
        } catch (e: any) {
            if (e.code === "EEXIST") throw new AttachmentExistsError(path);
            return false;
        }
    }

    async deleteAttachment(path: string): Promise<boolean> {
        const fullPath = await this.safePath(path, "attachment", { noSymlink: true });
        try {
            await unlink(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    async moveAttachment(from: string, to: string, { overwrite = false }: MoveOptions = {}): Promise<boolean> {
        const fromPath = await this.safePath(from, "attachment", { noSymlink: true });
        const toPath = await this.safePath(to, "attachment", { noSymlink: true });
        if (fromPath === toPath) {
            // Same file, which link below would refuse with EEXIST. rename is a
            // no-op here, or the case-only rename on a case-insensitive filesystem.
            try {
                await rename(fromPath, resolve(this.root, to));
                return true;
            } catch {
                return false;
            }
        }
        try {
            await mkdir(dirname(toPath), { recursive: true });
            if (overwrite) {
                await rename(fromPath, toPath);
            } else {
                // rename would replace an existing destination; link fails
                // with EEXIST instead.
                await link(fromPath, toPath);
                await unlink(fromPath);
            }
            return true;
        } catch (e: any) {
            if (e.code === "EEXIST") throw new AttachmentExistsError(to);
            // Cross-device, or a filesystem without hard links: copy, then delete.
            if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(e.code)) return false;
            try {
                await copyFile(fromPath, toPath, overwrite ? 0 : constants.COPYFILE_EXCL);
            } catch (copyErr: any) {
                if (copyErr.code === "EEXIST") throw new AttachmentExistsError(to);
                return false;
            }
            try {
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
                    // A symlink out of the vault would leak the target's name and
                    // size, and one to a note or dot-folder isn't an attachment.
                    const real = await realpath(resolve(this.root, path));
                    if (!real.startsWith(this.root + sep) || !this.isValidKind(relative(this.root, real), "attachment")) continue;
                    const s = await stat(real);
                    if (s.isFile()) results.push({ path, size: s.size, ctime: s.birthtimeMs, mtime: s.mtimeMs });
                } catch {
                    // Vanished between listing and stat, or a dangling symlink.
                }
            }
        } catch {
            return [];
        }
        return results.sort((a, b) => a.path.localeCompare(b.path));
    }
}
