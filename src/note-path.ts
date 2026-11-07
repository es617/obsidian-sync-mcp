/**
 * Shared validation for note paths, applied by both the CouchDB and local
 * backends before any read, write, delete or move.
 *
 * The note model is markdown-only: `list_notes` only ever surfaces `*.md`
 * files; binary attachments have their own validator (attachment-path.ts)
 * built on validateVaultPathShape below. Enforcing that here keeps
 * the tools from reaching anything that isn't a note, which closes two real
 * problems:
 *   - CouchDB mode: a path like `obsydian_livesync_version` or a `ix:`/`ps:`
 *     prefixed id would otherwise become a document id and overwrite LiveSync's
 *     own control documents, stopping sync on every device.
 *   - Local mode: a path like `.obsidian/plugins/x/main.js` would otherwise
 *     write executable plugin code into the vault, and `.obsidian/.../data.json`
 *     would expose LiveSync credentials.
 *
 * Rules: vault-relative, ends in `.md`, no `..`, no leading `/`, no `:` (its
 * only use here is LiveSync's internal id prefixes), no NUL, and no path
 * segment (split on either slash) that starts with `.` (hidden files and the
 * `.obsidian` config dir). Root-level LiveSync control flag files are also
 * rejected even though they are `.md`.
 */

// LiveSync's note-shaped control files, all at the vault root. Writing one and
// letting it sync triggers a vault-wide rebuild/fetch on every device, so they
// are not writable through the note tools. Compared lowercase because LiveSync
// lowercases ids when case-insensitive handling is on.
const RESERVED_ROOT_FILES = new Set([
    "redflag.md",
    "redflag2.md",
    "redflag3.md",
    "flag_rebuild.md",
    "flag_fetch.md",
]);

/**
 * The rules every vault path must pass, note or attachment: vault-relative,
 * no `..`, no leading `/`, no `:`, no NUL, no empty segment and no segment
 * starting with `.`. `kind` only names the path in error messages.
 */
export function validateVaultPathShape(path: string, kind: string): void {
    const problem = vaultPathShapeProblem(path);
    if (problem !== null) throw new Error(`Invalid ${kind} path${problem}`);
}

/**
 * Why `path` fails validateVaultPathShape, as the suffix of its error message
 * ("" when there is no detail), or null when it passes. Non-throwing so hot
 * paths like link parsing don't pay for an exception per rejected target.
 */
export function vaultPathShapeProblem(path: string): string | null {
    if (!path || path.length > 1000) return "";
    if (path.startsWith("/") || path.includes("\0") || path.includes("..")) return "";
    if (path.includes(":")) return ": ':' is not allowed";
    for (const segment of path.split(/[/\\]/)) {
        if (segment === "") return ": empty path segment";
        if (segment.startsWith(".")) return ": dot-folders and hidden files (e.g. .obsidian) are not allowed";
    }
    return null;
}

export function validateNotePath(path: string): void {
    validateVaultPathShape(path, "note");
    if (!path.endsWith(".md")) {
        throw new Error("Invalid note path: must be a vault-relative path ending in .md");
    }
    // Root-level control flag files (no folder segment).
    if (!path.includes("/") && !path.includes("\\") && RESERVED_ROOT_FILES.has(path.toLowerCase())) {
        throw new Error("Invalid note path: reserved LiveSync control file");
    }
}

/** Boolean form of validateNotePath, for filtering listings and the index. */
export function isValidNotePath(path: string): boolean {
    try {
        validateNotePath(path);
        return true;
    } catch {
        return false;
    }
}
