/**
 * Validation for attachment paths (images, PDFs, audio, video).
 *
 * Attachments get the same shape rules as notes (see note-path.ts) — no `..`,
 * no `:`, no dot-folders — so they cannot reach LiveSync control documents or
 * `.obsidian/`. On top of that the extension must be on an allowlist of binary
 * media types Obsidian can embed. Text-like formats (`.md`, `.svg`, `.html`,
 * `.js`, `.json`, `.css`, `.canvas`, ...) are never attachments: they are
 * either notes, executable in Obsidian, or stored by LiveSync as plain text.
 */

import { validateVaultPathShape } from "./note-path.js";

/** Binary formats Obsidian embeds natively. SVG is left out on purpose: it is text and can carry script. */
export const SUPPORTED_ATTACHMENT_EXTENSIONS: readonly string[] = [
    // images
    "avif", "bmp", "gif", "jpeg", "jpg", "png", "webp",
    // audio
    "flac", "m4a", "mp3", "ogg", "wav", "3gp",
    // video
    "mkv", "mov", "mp4", "ogv", "webm",
    // documents
    "pdf",
];

/**
 * Parse ATTACHMENT_EXTENSIONS into an allowlist. Unset means every supported
 * extension. The variable can only narrow the list: an unsupported entry is an
 * error rather than a silent widening of what may be written.
 */
export function parseAttachmentExtensions(raw: string | undefined): Set<string> {
    if (raw === undefined || raw.trim() === "") return new Set(SUPPORTED_ATTACHMENT_EXTENSIONS);
    const requested = raw
        .split(",")
        .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
        .filter(Boolean);
    const unsupported = requested.filter((e) => !SUPPORTED_ATTACHMENT_EXTENSIONS.includes(e));
    if (unsupported.length > 0) {
        throw new Error(
            `ATTACHMENT_EXTENSIONS contains unsupported extensions: ${unsupported.join(", ")}. ` +
            `Supported: ${SUPPORTED_ATTACHMENT_EXTENSIONS.join(", ")}.`,
        );
    }
    return new Set(requested);
}

/** Lowercased extension without the dot, or "" when there is none. */
export function attachmentExtension(path: string): string {
    const name = path.split(/[/\\]/).pop() ?? "";
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function validateAttachmentPath(path: string, allowed: ReadonlySet<string> = new Set(SUPPORTED_ATTACHMENT_EXTENSIONS)): void {
    validateVaultPathShape(path, "attachment");
    const ext = attachmentExtension(path);
    if (!ext || !allowed.has(ext)) {
        throw new Error(
            `Invalid attachment path: extension must be one of ${[...allowed].sort().join(", ")}`,
        );
    }
}

export function isValidAttachmentPath(path: string, allowed?: ReadonlySet<string>): boolean {
    try {
        validateAttachmentPath(path, allowed);
        return true;
    } catch {
        return false;
    }
}
