import { readFile, writeFile, unlink, mkdir, stat, lstat, realpath, rename, link, copyFile } from "fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { realpathSync, constants } from "fs";
import { glob } from "fs/promises";
import { parseFrontmatterAndLinks } from "./parse.js";
import { validateNotePath, isValidNotePath } from "./note-path.js";
import { validateAttachmentPath, isValidAttachmentPath } from "./attachment-path.js";
import { AttachmentExistsError, AttachmentMoveIncompleteError, NoteExistsError, NoteNotFoundError, type NoteWriteOptions, type VaultBackend, type NoteInfo, type NoteListing, type AttachmentInfo, type WriteOptions, type MoveOptions } from "./vault-backend.js";

// Not defined on Windows, which has no symlinks a non-admin can create anyway.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class LocalVault implements VaultBackend {
    private root: string;
    /** fs calls used by moveNoReplace, replaceable in tests to simulate failures. */
    protected linkFile = link;
    protected unlinkSource = unlink;

    private refuseSymlinkWrites: boolean;

    /**
     * `refuseSymlinkWrites`: refuse to write, delete or move through a symlink
     * (file or folder) anywhere on the path. Set when WRITE_FOLDERS is, because
     * the permission check sees the requested path: a symlink MCP/alias.md ->
     * Raw/a.md would otherwise let a write in MCP/ change a create-only note.
     */
    constructor(vaultPath: string, { refuseSymlinkWrites = false }: { refuseSymlinkWrites?: boolean } = {}) {
        this.root = realpathSync(resolve(vaultPath));
        this.refuseSymlinkWrites = refuseSymlinkWrites;
    }

    /**
     * safePath for a write, delete or move. With refuseSymlinkWrites, the
     * resolved path must be the requested one; only case and Unicode form may
     * differ (case-insensitive file systems return the on-disk spelling).
     */
    private async writePath(path: string, kind: "note" | "attachment", options: { noSymlink?: boolean } = {}): Promise<string> {
        const real = await this.safePath(path, kind, options);
        if (this.refuseSymlinkWrites) {
            const same = (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "").normalize("NFC").toLowerCase();
            if (same(relative(this.root, real).split(sep).join("/")) !== same(path)) {
                throw new Error(`Refusing to modify a file through a symlink while WRITE_FOLDERS is set: ${path}`);
            }
        }
        return real;
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

    /**
     * mkdir for an attachment write to `fullPath` (from safePath), then check
     * the path again: a folder swapped for a symlink since would redirect the
     * write. Returns false when mkdir fails.
     */
    private async mkdirChecked(path: string, fullPath: string): Promise<boolean> {
        try {
            await mkdir(dirname(fullPath), { recursive: true });
        } catch {
            return false;
        }
        if ((await this.safePath(path, "attachment", { noSymlink: true })) !== fullPath) {
            throw new Error("Path traversal blocked");
        }
        return true;
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

    async writeNote(path: string, content: string, { mode = "upsert" }: NoteWriteOptions = {}): Promise<boolean> {
        const fullPath = await this.writePath(path, "note");
        // O_EXCL refuses an existing file and a missing O_CREAT refuses a
        // missing one, each in the same step as the write.
        const flag =
            mode === "create" ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
            : mode === "update" ? constants.O_WRONLY | constants.O_TRUNC
            : "w";
        try {
            if (mode !== "update") await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, content, { encoding: "utf-8", flag });
            return true;
        } catch (e: any) {
            if (mode === "create" && e.code === "EEXIST") throw new NoteExistsError(path);
            if (mode === "update" && e.code === "ENOENT") throw new NoteNotFoundError(path);
            return false;
        }
    }

    async deleteNote(path: string): Promise<boolean> {
        const fullPath = await this.writePath(path, "note");
        try {
            await unlink(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    /** True when both paths name the same file (same device and inode). */
    private async sameFile(a: string, b: string): Promise<boolean> {
        try {
            const [sa, sb] = await Promise.all([stat(a), stat(b)]);
            return sa.dev === sb.dev && sa.ino === sb.ino;
        } catch {
            return false;
        }
    }

    /**
     * Move `fromPath` to `toPath` without replacing anything there: hard-link,
     * or copy where links aren't supported, then remove the source. rename()
     * can't be used because it replaces an existing destination.
     *
     * - "moved": done.
     * - "exists": something else is already at the destination.
     * - "failed": nothing changed. If removing the source failed after the link,
     *   the link is undone: two names for one file would let a write to the
     *   source change the destination.
     * - "copy-left": the copy exists but the source couldn't be removed; the two
     *   are independent files.
     *
     * `requested` is the destination as the caller spelled it (absolute).
     */
    private async moveNoReplace(fromPath: string, toPath: string, requested: string): Promise<"moved" | "exists" | "failed" | "copy-left"> {
        let linked = true;
        try {
            await this.linkFile(fromPath, toPath);
        } catch (e: any) {
            if (e.code === "EEXIST") {
                // A case-insensitive mount whose realpath keeps the requested case
                // (WSL /mnt/c, Docker Desktop bind mounts) makes a case-only rename
                // look like a move onto an existing file: it's the source itself.
                if (fromPath.toLowerCase() === toPath.toLowerCase() && (await this.sameFile(fromPath, toPath))) {
                    try {
                        await rename(fromPath, requested);
                        return "moved";
                    } catch {
                        return "failed";
                    }
                }
                return "exists";
            }
            if (e.code === "ENOENT") return "failed";
            // Cross-device, or a filesystem without hard links (codes vary: EXDEV,
            // EPERM, ENOTSUP, ENOSYS on some FUSE mounts...): copy, then delete.
            linked = false;
            try {
                await copyFile(fromPath, toPath, constants.COPYFILE_EXCL);
            } catch (copyErr: any) {
                return copyErr.code === "EEXIST" ? "exists" : "failed";
            }
        }
        try {
            await this.unlinkSource(fromPath);
            return "moved";
        } catch {
            if (!linked) return "copy-left";
            if (await this.sameFile(fromPath, toPath)) await unlink(toPath).catch(() => {});
            return "failed";
        }
    }

    async moveNote(from: string, to: string): Promise<boolean> {
        const fromPath = await this.writePath(from, "note");
        const toPath = await this.writePath(to, "note");
        if (fromPath === toPath) {
            // Same file: a no-op, or a case-only rename on a case-insensitive
            // filesystem, where toPath is the realpath and has the old case.
            try {
                await rename(fromPath, resolve(this.root, to));
                return true;
            } catch {
                return false;
            }
        }
        try {
            await mkdir(dirname(toPath), { recursive: true });
        } catch {
            return false;
        }
        const result = await this.moveNoReplace(fromPath, toPath, resolve(this.root, to));
        if (result === "exists") throw new NoteExistsError(to);
        if (result === "copy-left") {
            // Report a failed move with nothing changed, rather than two copies.
            await unlink(toPath).catch(() => {});
            return false;
        }
        return result === "moved";
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
        const fullPath = await this.writePath(path, "attachment", { noSymlink: true });
        if (!(await this.mkdirChecked(path, fullPath))) return false;
        try {
            // O_EXCL fails if the file exists, in the same step as the create,
            // so two concurrent creates can't both succeed. O_NOFOLLOW refuses
            // a symlink put in place since safePath checked.
            const flag = constants.O_WRONLY | constants.O_CREAT | (overwrite ? constants.O_TRUNC : constants.O_EXCL) | NOFOLLOW;
            await writeFile(fullPath, data, { flag });
            return true;
        } catch (e: any) {
            if (e.code === "EEXIST") throw new AttachmentExistsError(path);
            if (e.code === "ELOOP") throw new Error(`Refusing to modify a symlink: ${path}`);
            return false;
        }
    }

    async deleteAttachment(path: string): Promise<boolean> {
        const fullPath = await this.writePath(path, "attachment", { noSymlink: true });
        try {
            await unlink(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    async moveAttachment(from: string, to: string, { overwrite = false }: MoveOptions = {}): Promise<boolean> {
        const fromPath = await this.writePath(from, "attachment", { noSymlink: true });
        const toPath = await this.writePath(to, "attachment", { noSymlink: true });
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
        if (!(await this.mkdirChecked(to, toPath))) return false;
        if (overwrite) {
            try {
                await rename(fromPath, toPath);
                return true;
            } catch (e: any) {
                if (e.code !== "EXDEV") return false;
            }
            // Cross-device: copy over the destination, then delete the source.
            try {
                await copyFile(fromPath, toPath);
            } catch {
                return false;
            }
            try {
                await unlink(fromPath);
                return true;
            } catch {
                throw new AttachmentMoveIncompleteError(from, to);
            }
        }
        const result = await this.moveNoReplace(fromPath, toPath, resolve(this.root, to));
        if (result === "exists") throw new AttachmentExistsError(to);
        if (result === "copy-left") throw new AttachmentMoveIncompleteError(from, to);
        return result === "moved";
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
