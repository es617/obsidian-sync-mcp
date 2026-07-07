/**
 * Shared search-index sync helpers.
 *
 * Kept dependency-free (no livesync-commonlib imports) so the delete-vs-empty
 * routing is unit-testable in isolation.
 */

export interface IndexTarget {
    update(path: string, content: string, mtime?: number): void;
    remove(path: string): void;
}

/**
 * Derive index content from a LiveSync change doc.
 *
 * Returns `null` ONLY when the note is deleted. An existing note with no body
 * yields `""` so a zero-byte note stays distinguishable from a deletion —
 * without this, a note that serializes with no `data` array would look deleted.
 */
export function deriveContent(doc: { deleted?: boolean; data?: unknown }): string | null {
    if (doc.deleted) return null;
    return "data" in doc && Array.isArray(doc.data) ? doc.data.join("") : "";
}

/**
 * Route a change into the index: `null` content removes (the note was deleted),
 * any string — including `""` — upserts. Using `content !== null` (rather than a
 * truthiness check) keeps zero-byte notes indexed instead of dropping them
 * (issues #5 / #6).
 */
export function applyIndexChange(index: IndexTarget, path: string, content: string | null, mtime?: number): void {
    if (content !== null) {
        index.update(path, content, mtime);
    } else {
        index.remove(path);
    }
}
