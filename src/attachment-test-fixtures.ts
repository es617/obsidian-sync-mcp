// Shared test fixture for the attachment tests (not a test file itself).
import type { VaultBackend, AttachmentInfo } from "./vault-backend.js";

/** In-memory attachment store; only the attachment methods are used here. */
export function memoryAttachments() {
    const files = new Map<string, { data: Uint8Array; ctime: number; mtime: number }>();
    const vault = {
        writeAttachment: async (path: string, data: Uint8Array) => {
            const ctime = files.get(path)?.ctime ?? 1;
            files.set(path, { data, ctime, mtime: 2 });
            return true;
        },
        deleteAttachment: async (path: string) => files.delete(path),
        moveAttachment: async (from: string, to: string) => {
            const f = files.get(from);
            if (!f) return false;
            files.set(to, f);
            files.delete(from);
            return true;
        },
        getAttachmentInfo: async (path: string): Promise<AttachmentInfo | null> => {
            const f = files.get(path);
            return f ? { path, size: f.data.byteLength, ctime: f.ctime, mtime: f.mtime } : null;
        },
    } as unknown as VaultBackend;
    return { vault, files };
}
