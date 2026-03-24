import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join, dirname, resolve } from "path";
import { glob } from "fs/promises";

export class LocalVault {
    private root: string;

    constructor(vaultPath: string) {
        this.root = resolve(vaultPath);
    }

    private safePath(path: string): string {
        const full = resolve(this.root, path);
        if (!full.startsWith(this.root + "/")) {
            throw new Error("Path traversal blocked");
        }
        return full;
    }

    async init(): Promise<void> {}

    async close(): Promise<void> {}

    async readNote(path: string): Promise<string | null> {
        try {
            return await readFile(this.safePath(path), "utf-8");
        } catch {
            return null;
        }
    }

    async writeNote(path: string, content: string): Promise<boolean> {
        try {
            const fullPath = this.safePath(path);
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, content, "utf-8");
            return true;
        } catch {
            return false;
        }
    }

    async deleteNote(path: string): Promise<boolean> {
        try {
            await unlink(this.safePath(path));
            return true;
        } catch {
            return false;
        }
    }

    async listNotes(folder?: string): Promise<string[]> {
        if (folder && !folder.endsWith("/")) folder += "/";
        const searchDir = folder ? join(this.root, folder) : this.root;
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
