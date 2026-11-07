/**
 * MCP tools for binary attachments (images, PDFs, audio, video).
 *
 * Large files go through create_attachment_upload: the tool returns a
 * single-use URL and the agent sends the raw bytes there out of band (see
 * uploads.ts). write_attachment takes base64 inline, for small files only,
 * because every byte of a tool argument is a model output token.
 */

import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import { AttachmentExistsError, type VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";
import { isPathWritable } from "./write-scope.js";
import { validateAttachmentPath, attachmentExtension } from "./attachment-path.js";
import { UPLOAD_ROUTE_PREFIX, type UploadRegistry } from "./uploads.js";

export const LIST_ATTACHMENTS_DEFAULT_LIMIT = 100;

export const ATTACHMENT_WRITE_TOOLS = ["create_attachment_upload", "write_attachment", "delete_attachment", "move_attachment"] as const;

export interface AttachmentToolOptions {
    vault: VaultBackend;
    searchIndex: SearchIndex;
    vaultName: string;
    readOnly: boolean;
    writeFolders: string[] | null;
    allowedExtensions: ReadonlySet<string>;
    /** Largest file accepted by the upload URL. */
    maxBytes: number;
    /** Largest decoded file accepted inline by write_attachment. */
    base64MaxBytes: number;
    registry: UploadRegistry;
    /** Public base URL of this server, used to build upload URLs. */
    baseUrl: string;
}

/** Rough output-token cost of sending `bytes` as base64 (~3.3 characters per token). */
export function estimateBase64Tokens(bytes: number): number {
    return Math.ceil((Math.ceil(bytes / 3) * 4) / 3.3);
}

export function formatTokens(n: number): string {
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Decode base64 (optionally a `data:...;base64,` URL) strictly. Buffer.from
 * silently skips invalid characters, which would store a corrupt file.
 */
export function decodeBase64Strict(input: string): Uint8Array {
    let s = input.trim();
    const dataUrl = s.match(/^data:[^,]*;base64,/i);
    if (dataUrl) s = s.slice(dataUrl[0].length);
    s = s.replace(/\s+/g, "");
    if (s.length % 4 === 1 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) {
        throw new Error("content_base64 is not valid base64");
    }
    return new Uint8Array(Buffer.from(s, "base64"));
}

export function registerAttachmentTools(server: FastMCP, opts: AttachmentToolOptions) {
    const { vault, searchIndex, vaultName, readOnly, writeFolders, allowedExtensions, maxBytes, base64MaxBytes, registry } = opts;
    const baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const extList = [...allowedExtensions].sort().join(", ");
    const writeScopeNote = writeFolders
        ? ` Writes are only allowed inside: ${writeFolders.map((f) => f + "/").join(", ")}.`
        : "";
    const embedNote = " Add it to a note with an embed such as ![[path]] (edit_note).";

    /** Validate against the configured allowlist; returns an error message or null. */
    const checkPath = (path: string): string | null => {
        try {
            validateAttachmentPath(path, allowedExtensions);
            return null;
        } catch (err) {
            return (err as Error).message;
        }
    };
    const checkWritable = (path: string): string | null =>
        checkPath(path) ??
        (isPathWritable(path, writeFolders)
            ? null
            : `Write access denied: '${path}' is outside the writable folders (${writeFolders!.map((f) => f + "/").join(", ")}).`);

    server.addTool({
        name: "get_attachment_metadata",
        description:
            `Get size and timestamps of an attachment (${extList}) and the notes that embed or link it.`,
        parameters: z.object({
            path: z.string().describe("Vault-relative attachment path, e.g. 'Attachments/screenshot.png'"),
        }),
        execute: async ({ path }) => {
            const invalid = checkPath(path);
            if (invalid) return invalid;
            const info = await vault.getAttachmentInfo(path);
            if (!info) return `Attachment not found: ${path}`;
            const lines = [
                `**${path}**`,
                `Size: ${info.size} bytes (${formatBytes(info.size)})`,
                `Created: ${new Date(info.ctime).toISOString()}`,
                `Modified: ${new Date(info.mtime).toISOString()}`,
                `Embed: ![[${path}]]`,
            ];
            const backlinks = searchIndex.getAttachmentReferences(path);
            if (backlinks.length > 0) lines.push(`\nEmbedded or linked in: ${backlinks.join(", ")}`);
            lines.push(`\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`);
            return lines.join("\n");
        },
    });

    server.addTool({
        name: "list_attachments",
        description:
            `List attachments (${extList}) with size, modification time and how many notes embed or link each. ` +
            "Use it to see where the vault keeps attachments and how they are named before adding one, to find an existing file to embed, " +
            "or with unreferenced=true to find files no note uses any more. Returns up to 100 by default.",
        parameters: z.object({
            folder: z.string().optional().describe("Only attachments under this folder, e.g. 'Attachments'."),
            name: z.string().optional().describe("Case-insensitive substring of the path, e.g. 'screenshot'."),
            extension: z.string().optional().describe("Only this file type, e.g. 'png' or 'pdf'."),
            unreferenced: z.boolean().optional().describe("Only attachments that no note embeds or links (by file name, so a name used anywhere counts as referenced)."),
            sort_by: z.enum(["name", "modified", "size"]).optional().describe("'name' (default), 'modified' (newest first) or 'size' (largest first)."),
            limit: z.coerce.number().int().positive().optional().describe(`Max entries, default ${LIST_ATTACHMENTS_DEFAULT_LIMIT}.`),
        }),
        execute: async ({ folder, name, extension, unreferenced, sort_by, limit }) => {
            const refs = searchIndex.attachmentReferenceMap();
            let items = searchIndex
                .listAttachments(folder)
                .filter((a) => allowedExtensions.has(attachmentExtension(a.path)))
                .map((a) => ({ ...a, refs: searchIndex.getAttachmentReferences(a.path, refs) }));
            const total = items.length;
            const filters: string[] = [];
            if (name) {
                const lower = name.toLowerCase();
                items = items.filter((a) => a.path.toLowerCase().includes(lower));
                filters.push(`name="${name}"`);
            }
            if (extension) {
                const ext = extension.toLowerCase().replace(/^\./, "");
                items = items.filter((a) => attachmentExtension(a.path) === ext);
                filters.push(`extension="${ext}"`);
            }
            if (unreferenced) {
                items = items.filter((a) => a.refs.length === 0);
                filters.push("unreferenced");
            }
            if (sort_by === "modified") items.sort((a, b) => b.mtime - a.mtime);
            if (sort_by === "size") items.sort((a, b) => b.size - a.size);

            const scope = folder ? ` in ${folder.replace(/\/+$/, "")}/` : "";
            const building = searchIndex.state === "ready" ? "" : " The index is still being built, so this list may be incomplete.";
            if (items.length === 0) {
                const why = filters.length ? ` match ${filters.join(", ")}` : "";
                return `No attachments${scope}${why}. ${total} attachments${scope} in the index.${building}`;
            }
            const cap = limit ?? LIST_ATTACHMENTS_DEFAULT_LIMIT;
            const shown = items.slice(0, cap);
            const header =
                `${items.length} attachment${items.length === 1 ? "" : "s"}${scope}` +
                (filters.length ? ` matching ${filters.join(", ")} (of ${total})` : "") +
                `, ${formatBytes(items.reduce((n, a) => n + a.size, 0))} in total` +
                (shown.length < items.length ? `, showing the first ${shown.length}` : "") +
                `.${building}`;
            const lines = shown.map((a) => {
                const date = a.mtime ? new Date(a.mtime).toISOString().slice(0, 16) : "";
                const used = a.refs.length === 0 ? "unreferenced" : a.refs.length === 1 ? `in ${a.refs[0]}` : `in ${a.refs.length} notes`;
                return `- ${date} ${formatBytes(a.size)} [${a.path}](${makeDeepLink(vaultName, a.path)}) — ${used}`;
            });
            return [header, ...lines].join("\n");
        },
    });

    if (readOnly) return;

    server.addTool({
        name: "create_attachment_upload",
        description:
            `Preferred way to add an image, PDF, audio or video file (${extList}) to the vault, up to ${formatBytes(maxBytes)}. ` +
            "Returns a one-time URL; send the raw file bytes to it with HTTP PUT, e.g. `curl -fsS -X PUT --data-binary @file.png '<url>'` (no other auth needed). " +
            "Use this whenever you can run a command or make an HTTP request (shell, code execution, a script): it takes milliseconds at any size, " +
            `while write_attachment spends output tokens on every byte. The URL works once and expires after ${Math.round(registry.ttlMs / 60000)} minutes.` +
            embedNote + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative destination path, e.g. 'Attachments/screenshot.png'. The extension decides how Obsidian shows the file."),
            size: z.coerce.number().int().positive().optional().describe("Exact file size in bytes, if known. The upload is rejected when it differs, which catches truncated uploads."),
            overwrite: z.boolean().optional().describe("Replace an existing file at path. Default false."),
        }),
        execute: async ({ path, size, overwrite }) => {
            const denied = checkWritable(path);
            if (denied) return denied;
            if (size !== undefined && size > maxBytes) {
                return `File is ${formatBytes(size)}, over the upload limit of ${formatBytes(maxBytes)}.`;
            }
            if (!overwrite && (await vault.getAttachmentInfo(path))) {
                return `Attachment already exists: ${path}. Pass overwrite=true to replace it, or choose another path.`;
            }
            let handle;
            try {
                handle = registry.create({ path, overwrite: !!overwrite, expectedSize: size, maxBytes });
            } catch (err) {
                return (err as Error).message;
            }
            const url = `${baseUrl}${UPLOAD_ROUTE_PREFIX}${handle.token}`;
            return [
                `Upload URL for ${path} (single use, expires ${new Date(handle.expiresAt).toISOString()}, max ${formatBytes(size ?? maxBytes)}):`,
                url,
                "",
                "Send the raw bytes with PUT, for example:",
                `curl -fsS -X PUT --data-binary @/path/to/local/file '${url}'`,
                "",
                `A 201 response with JSON {"path", "size", "embed"} means the file is saved. Then embed it in a note with: ![[${path}]]`,
            ].join("\n");
        },
    });

    // base64 inflates by 4/3; allow a little slack for whitespace and a data: prefix.
    const base64MaxChars = Math.ceil(base64MaxBytes / 3) * 4 + 1024;
    server.addTool({
        name: "write_attachment",
        description:
            `Fallback for clients that cannot make HTTP requests: save a tiny attachment (${extList}) from base64, up to ${formatBytes(base64MaxBytes)}. ` +
            `A file at that limit is about ${formatTokens(estimateBase64Tokens(base64MaxBytes))} output tokens, minutes of generation, and one wrong character corrupts it. ` +
            "If you can run curl or any HTTP client, or the file exists on a disk you can read, use create_attachment_upload instead." +
            embedNote + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative destination path, e.g. 'Attachments/diagram.png'"),
            content_base64: z.string().max(base64MaxChars).describe("File content as base64 (a data: URL is accepted too)"),
            overwrite: z.boolean().optional().describe("Replace an existing file at path. Default false."),
        }),
        execute: async ({ path, content_base64, overwrite }) => {
            const denied = checkWritable(path);
            if (denied) return denied;
            let data: Uint8Array;
            try {
                data = decodeBase64Strict(content_base64);
            } catch (err) {
                return (err as Error).message;
            }
            if (data.byteLength === 0) return "content_base64 is empty.";
            if (data.byteLength > base64MaxBytes) {
                return `File is ${formatBytes(data.byteLength)}, over the inline limit of ${formatBytes(base64MaxBytes)}. Use create_attachment_upload instead.`;
            }
            let ok: boolean;
            try {
                ok = await vault.writeAttachment(path, data, { overwrite: !!overwrite });
            } catch (err) {
                if (err instanceof AttachmentExistsError) {
                    return `Attachment already exists: ${path}. Pass overwrite=true to replace it, or choose another path.`;
                }
                throw err;
            }
            if (!ok) return `Failed to write attachment: ${path}`;
            searchIndex.updateAttachment(path, data.byteLength, Date.now());
            return `Attachment saved: ${path} (${formatBytes(data.byteLength)})\nEmbed: ![[${path}]]\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`;
        },
    });

    server.addTool({
        name: "delete_attachment",
        description: "Delete an attachment from the vault. Notes that embed it are not changed." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative attachment path to delete"),
        }),
        execute: async ({ path }) => {
            const denied = checkWritable(path);
            if (denied) return denied;
            if (!(await vault.getAttachmentInfo(path))) return `Attachment not found: ${path}`;
            const ok = await vault.deleteAttachment(path);
            if (!ok) return `Failed to delete: ${path}`;
            searchIndex.removeAttachment(path);
            const backlinks = searchIndex.getAttachmentReferences(path);
            return backlinks.length > 0
                ? `Deleted: ${path}\nThese notes still embed or link it: ${backlinks.join(", ")}`
                : `Deleted: ${path}`;
        },
    });

    server.addTool({
        name: "move_attachment",
        description:
            "Move or rename an attachment. Embeds in notes are not updated; edit them afterwards if needed." + writeScopeNote,
        parameters: z.object({
            from: z.string().describe("Current path, e.g. 'Attachments/old.png'"),
            to: z.string().describe("New path, e.g. 'Attachments/2026/new.png'"),
            overwrite: z.boolean().optional().describe("Replace an existing file at the destination. Default false."),
        }),
        execute: async ({ from, to, overwrite }) => {
            const denied = checkWritable(from) ?? checkWritable(to);
            if (denied) return denied;
            const source = await vault.getAttachmentInfo(from);
            if (!source) return `Attachment not found: ${from}`;
            let ok: boolean;
            try {
                ok = await vault.moveAttachment(from, to, { overwrite: !!overwrite });
            } catch (err) {
                if (err instanceof AttachmentExistsError) {
                    return `Attachment already exists: ${to}. Pass overwrite=true to replace it.`;
                }
                throw err;
            }
            if (!ok) return `Failed to move: ${from} → ${to}`;
            searchIndex.removeAttachment(from);
            searchIndex.updateAttachment(to, source.size, Date.now());
            const backlinks = searchIndex.getAttachmentReferences(from);
            const note = backlinks.length > 0 ? `\nThese notes still embed the old path: ${backlinks.join(", ")}` : "";
            return `Moved: ${from} → ${to}\nEmbed: ![[${to}]]${note}\n[Open in Obsidian](${makeDeepLink(vaultName, to)})`;
        },
    });
}
