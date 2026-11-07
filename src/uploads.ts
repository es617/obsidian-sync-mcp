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
 * when the handle is created, and overwrite is checked again at write time.
 */

import { randomBytes } from "crypto";
import type { Hono } from "hono";
import { AttachmentExistsError, type VaultBackend } from "./vault-backend.js";

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
    /** Handles taken whose body is still being read or written; see take and release. */
    private inFlight = 0;
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
        // An upload still streaming its body holds memory too, so it counts
        // against the cap until the route releases it.
        if (this.handles.size + this.inFlight >= this.maxPending) {
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

    /** Return the handle without using it up, or null when unknown or expired. */
    peek(token: string): UploadHandle | null {
        const handle = this.handles.get(token);
        return handle && handle.expiresAt > this.now() ? handle : null;
    }

    /**
     * Remove and return the handle (single use), or null when unknown or
     * expired. A returned handle stays counted against the cap until release().
     */
    take(token: string): UploadHandle | null {
        const handle = this.handles.get(token);
        if (!handle) return null;
        this.handles.delete(token);
        if (handle.expiresAt <= this.now()) return null;
        this.inFlight++;
        return handle;
    }

    /** Free the slot of a handle returned by take, once its upload has finished. */
    release(): void {
        if (this.inFlight > 0) this.inFlight--;
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
    /** Called when the backend write throws. The client only gets a generic 500. */
    onError?: (path: string, err: unknown) => void;
}

export function mountAttachmentUpload(app: Hono, { registry, vault, onWritten, onError }: UploadRouteOptions): void {
    const handler = async (c: any) => {
        const token = c.req.param("token") ?? "";
        const unknown = () => c.json({ error: "Unknown, used or expired upload URL. Call create_attachment_upload again." }, 404);
        const peeked = registry.peek(token);
        if (!peeked) return unknown();
        // Refused from the header alone, the URL stays usable for a retry.
        // Once the body is read the handle is used up, whatever the outcome.
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > peeked.maxBytes) {
            return c.json({ error: `Upload exceeds the limit of ${peeked.maxBytes} bytes` }, 413);
        }
        const handle = registry.take(token);
        if (!handle) return unknown();
        try {
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
                // Overwrite is checked again here: a file may have appeared since the handle was made.
                const ok = await vault.writeAttachment(handle.path, data, { overwrite: handle.overwrite });
                if (!ok) return c.json({ error: `Failed to write attachment: ${handle.path}` }, 500);
            } catch (err) {
                if (err instanceof AttachmentExistsError) {
                    return c.json({ error: `Attachment already exists: ${handle.path}` }, 409);
                }
                // The message can name the CouchDB host, so it stays in the server log.
                onError?.(handle.path, err);
                return c.json({ error: `Failed to write attachment: ${handle.path}` }, 500);
            }
            onWritten?.(handle.path, data.byteLength);
            return c.json({ path: handle.path, size: data.byteLength, embed: `![[${handle.path}]]` }, 201);
        } finally {
            registry.release();
        }
    };
    // PUT only. The route is outside the Host/Origin guard and mcp-proxy sends
    // permissive CORS headers, so a web page could POST here without a
    // preflight. A cross-origin PUT needs one, and mcp-proxy allows only GET
    // and POST, so the browser never sends it.
    app.put(`${UPLOAD_ROUTE_PREFIX}:token`, handler);
}
