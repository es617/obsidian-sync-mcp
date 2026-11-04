/**
 * Short-lived upload handles for attachments.
 *
 * Sending a file through an MCP tool argument means the model has to emit
 * every byte as base64 output tokens, which tops out around a few hundred KB.
 * Instead, `create_attachment_upload` mints a single-use handle bound to one
 * vault path, and the agent PUTs the raw bytes to
 * `/attachments/upload/<token>` out of band (e.g. with curl). The write goes
 * through the same backend as every other tool, so in CouchDB mode the file is
 * chunked and encrypted by livesync-commonlib like a file added in Obsidian.
 *
 * The token is the credential for the upload route: 32 random bytes, valid for
 * one request and a few minutes, and only for the path it was minted for. All
 * policy (path validation, WRITE_FOLDERS, size limit, overwrite) is decided
 * when the handle is created and re-checked where it can change (overwrite).
 */

import { randomBytes } from "crypto";
import type { Hono } from "hono";
import type { VaultBackend } from "./vault-backend.js";

export const UPLOAD_ROUTE_PREFIX = "/attachments/upload/";

export interface UploadHandle {
    token: string;
    path: string;
    overwrite: boolean;
    /** Exact byte count the upload must have, when the agent declared one. */
    expectedSize?: number;
    maxBytes: number;
    expiresAt: number;
}

export interface UploadRegistryOptions {
    ttlMs?: number;
    maxPending?: number;
    now?: () => number;
}

export class UploadRegistry {
    private handles = new Map<string, UploadHandle>();
    readonly ttlMs: number;
    private readonly maxPending: number;
    private readonly now: () => number;

    constructor(opts: UploadRegistryOptions = {}) {
        this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
        this.maxPending = opts.maxPending ?? 100;
        this.now = opts.now ?? Date.now;
    }

    get pending(): number {
        this.prune();
        return this.handles.size;
    }

    create(spec: { path: string; overwrite: boolean; expectedSize?: number; maxBytes: number }): UploadHandle {
        this.prune();
        if (this.handles.size >= this.maxPending) {
            throw new Error(`Too many pending uploads (${this.maxPending}). Use or let expire the existing upload URLs first.`);
        }
        const handle: UploadHandle = {
            ...spec,
            token: randomBytes(32).toString("base64url"),
            expiresAt: this.now() + this.ttlMs,
        };
        this.handles.set(handle.token, handle);
        return handle;
    }

    /** Remove and return the handle (single use), or null when unknown or expired. */
    take(token: string): UploadHandle | null {
        const handle = this.handles.get(token);
        if (!handle) return null;
        this.handles.delete(token);
        return handle.expiresAt > this.now() ? handle : null;
    }

    prune(): void {
        const now = this.now();
        for (const [token, handle] of this.handles) {
            if (handle.expiresAt <= now) this.handles.delete(token);
        }
    }
}

export class BodyTooLargeError extends Error {
    constructor(limit: number) {
        super(`Upload exceeds the limit of ${limit} bytes`);
    }
}

/** Read a request body into memory, aborting as soon as it passes `limit` bytes. */
export async function readBodyLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
    if (!body) return new Uint8Array(0);
    const reader = body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) {
                await reader.cancel().catch(() => {});
                throw new BodyTooLargeError(limit);
            }
            parts.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

export interface UploadRouteOptions {
    registry: UploadRegistry;
    vault: VaultBackend;
    /** Called after a successful write, e.g. for logging. */
    onWritten?: (path: string, size: number) => void;
}

export function mountAttachmentUpload(app: Hono, { registry, vault, onWritten }: UploadRouteOptions): void {
    const handler = async (c: any) => {
        const handle = registry.take(c.req.param("token") ?? "");
        if (!handle) {
            return c.json({ error: "Unknown, used or expired upload URL. Call create_attachment_upload again." }, 404);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > handle.maxBytes) {
            return c.json({ error: `Upload exceeds the limit of ${handle.maxBytes} bytes` }, 413);
        }
        let data: Uint8Array;
        try {
            data = await readBodyLimited(c.req.raw.body, handle.maxBytes);
        } catch (err) {
            if (err instanceof BodyTooLargeError) return c.json({ error: err.message }, 413);
            return c.json({ error: "Failed to read the upload body" }, 400);
        }
        if (data.byteLength === 0) {
            return c.json({ error: "Empty upload body. Send the raw file bytes, e.g. curl --data-binary @file" }, 400);
        }
        if (handle.expectedSize !== undefined && data.byteLength !== handle.expectedSize) {
            return c.json({ error: `Upload is ${data.byteLength} bytes but ${handle.expectedSize} were declared` }, 400);
        }
        try {
            // Re-check: something may have been written there since the handle was made.
            if (!handle.overwrite && (await vault.getAttachmentInfo(handle.path))) {
                return c.json({ error: `Attachment already exists: ${handle.path}` }, 409);
            }
            const ok = await vault.writeAttachment(handle.path, data);
            if (!ok) return c.json({ error: `Failed to write attachment: ${handle.path}` }, 500);
        } catch (err) {
            return c.json({ error: `Failed to write attachment: ${(err as Error).message}` }, 500);
        }
        onWritten?.(handle.path, data.byteLength);
        return c.json({ path: handle.path, size: data.byteLength, embed: `![[${handle.path}]]` }, 201);
    };
    app.put(`${UPLOAD_ROUTE_PREFIX}:token`, handler);
    app.post(`${UPLOAD_ROUTE_PREFIX}:token`, handler);
}
