// Folder-scoped write permissions (WRITE_FOLDERS env var).
//
// WRITE_FOLDERS is a comma-separated list of `folder[:permissions]` entries,
// e.g. `MCP,Raw:create,Notes:create+update`. Each write a tool makes is one of
// three actions on a path, checked against the folder that contains it:
//
//   create  a file at a path where none exists (incl. a move destination)
//   update  change an existing file (overwrite, edit)
//   delete  remove a file (incl. a move source)
//
// A folder listed without permissions gets all three. Reads are never
// restricted. When WRITE_FOLDERS is set, paths outside every listed folder are
// read-only; `/` stands for the vault root. The most specific folder wins.

export type WriteAction = "create" | "update" | "delete";
export const WRITE_ACTIONS: readonly WriteAction[] = ["create", "update", "delete"];

export interface WriteRule {
    /** Vault-relative folder without leading/trailing slashes; "" is the vault root. */
    folder: string;
    allow: ReadonlySet<WriteAction>;
}

/** Parsed WRITE_FOLDERS, or null when writes are unrestricted. */
export type WriteScope = readonly WriteRule[] | null;

const ALL: ReadonlySet<WriteAction> = new Set(WRITE_ACTIONS);
const NONE: ReadonlySet<WriteAction> = new Set();

/**
 * Parse the WRITE_FOLDERS env var. Unset or empty means unrestricted (null).
 * Throws on an unknown permission or a folder listed twice, so a typo can't
 * silently change what agents may do.
 */
export function parseWriteFolders(raw: string | undefined): WriteScope {
    if (raw === undefined) return null;
    const rules: WriteRule[] = [];
    const seen = new Set<string>();
    for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
        // Obsidian forbids ':' in file and folder names, so it can't be part of a folder.
        const colon = entry.lastIndexOf(":");
        const rawFolder = colon === -1 ? entry : entry.slice(0, colon);
        const folder = rawFolder.trim().replace(/^\/+|\/+$/g, "");
        if (folder === "" && rawFolder.trim() === "") {
            throw new Error(`WRITE_FOLDERS: '${entry}' has no folder. Use '/' for the vault root.`);
        }
        let allow = ALL;
        if (colon !== -1) {
            const perms = entry.slice(colon + 1).split("+").map((p) => p.trim());
            for (const p of perms) {
                if (!(WRITE_ACTIONS as readonly string[]).includes(p)) {
                    throw new Error(
                        `WRITE_FOLDERS: unknown permission '${p}' in '${entry}'. ` +
                        `Use ${WRITE_ACTIONS.join(", ")}, joined with '+' (e.g. '${rawFolder.trim()}:create+update').`,
                    );
                }
            }
            allow = new Set(perms as WriteAction[]);
        }
        if (seen.has(folder)) throw new Error(`WRITE_FOLDERS: '${folder || "/"}' is listed more than once.`);
        seen.add(folder);
        rules.push({ folder, allow });
    }
    return rules.length > 0 ? rules : null;
}

/** Strip leading slashes; null when the path contains a traversal segment. */
function normalizePath(path: string): string | null {
    const normalized = path.replace(/^\/+/, "");
    // Backends reject traversal too; deny here so the scope check can't be reasoned around.
    // Split on backslash as well: on Windows "MCP/..\x" resolves as traversal.
    if (normalized.split(/[/\\]/).includes("..")) return null;
    return normalized;
}

function contains(folder: string, path: string): boolean {
    return folder === "" || path.startsWith(folder + "/");
}

function mostSpecific(rules: readonly WriteRule[], path: string, key: (s: string) => string): WriteRule | null {
    const p = key(path);
    let best: WriteRule | null = null;
    for (const rule of rules) {
        if (contains(key(rule.folder), p) && (!best || rule.folder.length > best.folder.length)) best = rule;
    }
    return best;
}

const fold = (s: string) => s.normalize("NFC").toLowerCase();

/**
 * The rule that governs `path` and what it allows there.
 *
 * Matching is case-sensitive, but LiveSync vaults and macOS/Windows file
 * systems are not: "raw/a.md" can name the file "Raw/a.md". So the rule is
 * looked up both exactly and case-folded, and only the actions both allow are
 * granted. Otherwise `/,Raw:create` would let "raw/a.md" overwrite Raw/a.md.
 */
function resolve(path: string, scope: WriteScope): { allow: ReadonlySet<WriteAction>; rule: WriteRule | null } {
    if (scope === null) return { allow: ALL, rule: null };
    const normalized = normalizePath(path);
    if (normalized === null) return { allow: NONE, rule: null };
    const exact = mostSpecific(scope, normalized, (s) => s);
    const folded = mostSpecific(scope, normalized, fold);
    if (!exact || !folded) return { allow: NONE, rule: null };
    if (exact === folded) return { allow: exact.allow, rule: exact };
    const allow = new Set([...exact.allow].filter((a) => folded.allow.has(a)));
    return { allow, rule: folded.folder.length >= exact.folder.length ? folded : exact };
}

/** The write actions allowed on `path`. */
export function allowedActions(path: string, scope: WriteScope): ReadonlySet<WriteAction> {
    return resolve(path, scope).allow;
}

const folderLabel = (folder: string) => (folder === "" ? "/" : folder + "/");

/** e.g. "MCP/, Inbox/, Raw/ (create only)". */
export function describeFolders(scope: readonly WriteRule[]): string {
    return scope
        .map((r) => {
            const label = folderLabel(r.folder);
            if (r.allow.size === ALL.size) return label;
            return `${label} (${WRITE_ACTIONS.filter((a) => r.allow.has(a)).join("+")} only)`;
        })
        .join(", ");
}

/** Sentence appended to write tool descriptions; empty when writes are unrestricted. */
export function describeWriteScope(scope: WriteScope): string {
    if (scope === null) return "";
    const limited = scope.some((r) => r.allow.size < ALL.size);
    const legend = limited
        ? " create = add new files, update = change existing files, delete = delete or move files away; the most specific folder applies."
        : "";
    return ` Writes are only allowed inside: ${describeFolders(scope)}.${legend}`;
}

const VERB: Record<WriteAction, string> = { create: "created", update: "changed", delete: "deleted or moved" };

/**
 * Refusal message when `action` on `path` is not allowed, or null when it is.
 * Call this before looking at whether the file exists, so a refusal reads the
 * same either way.
 */
export function checkWrite(path: string, action: WriteAction, scope: WriteScope): string | null {
    const { allow, rule } = resolve(path, scope);
    if (allow.has(action)) return null;
    if (!rule || allow.size === 0) {
        return `Write access denied: '${path}' is outside the writable folders (${describeFolders(scope ?? [])}).`;
    }
    const allowed = WRITE_ACTIONS.filter((a) => allow.has(a)).join("+");
    return `Write access denied: ${folderLabel(rule.folder)} allows only ${allowed}, so '${path}' can't be ${VERB[action]}.`;
}
