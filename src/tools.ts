import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import { NoteExistsError, NoteNotFoundError, RevisionMismatchError, UpdateRetriesExhaustedError, type VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";
import { allowedActions, checkWrite, describeFolders, describeWriteScope, type WriteScope } from "./write-scope.js";
import { describeListing, describeNoMatch } from "./list-format.js";
import { describeHits, describeQuery, describeSync, type SyncStatus } from "./search-format.js";

const debugLogging = process.env.LOG_LEVEL === "debug";

/** Runs a CouchDB catch-up before a search; undefined in local (VAULT_PATH) mode. */
export type SyncBeforeSearch = () => Promise<{ unreadable: number; error?: string }>;

export const SEARCH_MAX_HITS = 20;
/** Each term is one more regex pass over every note (synchronous), so the count is capped. */
export const SEARCH_MAX_TERMS = 20;
/** Each term is compiled into a regex; a very long one overflows the stack (~10 KB with flags iu) or blocks the event loop, so its length is capped. */
export const SEARCH_MAX_TERM_LENGTH = 200;

/** Trim, drop empty terms, cut each to SEARCH_MAX_TERM_LENGTH and clamp to SEARCH_MAX_TERMS — a backstop behind the schema's .max(). */
export function cleanSearchTerms(terms: string[] | undefined): string[] {
    return (terms ?? [])
        .map((t) => t.trim().slice(0, SEARCH_MAX_TERM_LENGTH))
        .filter((t) => t.length > 0)
        .slice(0, SEARCH_MAX_TERMS);
}

const WRITE_TOOLS = ["write_note", "edit_note", "delete_note", "move_note"] as const;

/**
 * edit_note rounds when another writer changes the note between its read and
 * its write (CouchDB mode): at least this many, then more until
 * EDIT_MIN_RETRY_MS has passed or 5 x this many rounds have run, whichever
 * comes first (on a fast database usually the round cap). write_note uses the
 * same budget to replace an existing note. Edits queued on one server are
 * written together (see Vault.updateNote) and don't spend rounds on each
 * other; rounds are lost to other instances, and to a write_note, move_note
 * or delete_note of the note on this one, which takes the note's lock ahead
 * of edits still queued. A refused edit answers "Failed to edit note" and
 * writes nothing; it is never silently dropped.
 */
export const EDIT_MAX_ATTEMPTS = 10;
/** edit_note keeps retrying past EDIT_MAX_ATTEMPTS until this much time has passed or 5 x the attempts have run. */
export const EDIT_MIN_RETRY_MS = 3000;

export const NO_REVISIONS_MESSAGE =
    "expected_revision needs CouchDB mode: this vault has no revisions. Nothing was written.";

/** An edit that can't be applied to the note's current text. */
class EditRefused extends Error {}

/** Apply one edit_note operation to a note's text; throws EditRefused when it can't be applied. */
export function applyEdit(existing: string, op: "append" | "prepend" | "replace", newContent: string, oldText?: string): string {
    if (op === "replace") {
        if (!oldText) throw new EditRefused("old_text is required for replace operation.");
        const idx = existing.indexOf(oldText);
        if (idx === -1) throw new EditRefused("old_text not found in note.");
        if (existing.indexOf(oldText, idx + 1) !== -1) {
            throw new EditRefused("old_text matches multiple times. Provide a longer, unique string.");
        }
        return existing.slice(0, idx) + newContent + existing.slice(idx + oldText.length);
    }
    if (op === "prepend") {
        // Insert after frontmatter if present
        const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
        if (fmMatch) {
            const afterFm = fmMatch[0].length;
            return existing.slice(0, afterFm) + newContent + "\n" + existing.slice(afterFm);
        }
        return newContent + "\n" + existing;
    }
    return existing.endsWith("\n") ? existing + newContent : existing + "\n" + newContent;
}

function describeMismatch(err: RevisionMismatchError): string {
    return `Revision mismatch: ${err.path} is at revision ${err.current}, not ${err.expected}. Nothing was written; read the note again and reapply your change.`;
}

// Shaped like a CouchDB revision (`<generation>-<hex>`): the value is echoed in
// the mismatch answer, so an empty, huge or multi-line value is refused here.
const expectedRevisionParam = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[1-9]\d*-[0-9a-f]+$/, "expected_revision must be a revision from read_note or get_note_metadata, like 12-3f9c...")
    .optional()
    .describe("Optional, CouchDB mode: the revision from read_note or get_note_metadata. The write only happens if the note is still at that revision; otherwise nothing is written and the current revision is returned.");

// Claude Code persists any MCP tool result above ~50 000 characters to a file
// and hands the model a 2 kB preview instead of the text. A tool can raise its
// own threshold (hard ceiling 500 000) by declaring
// `_meta["anthropic/maxResultSizeChars"]` in its tools/list entry; text from
// such a tool is then also exempt from MAX_MCP_OUTPUT_TOKENS. See
// https://code.claude.com/docs/en/mcp#raise-the-limit-for-a-specific-tool
// read_note returns whole notes, so it declares 100 000: enough for a large
// note to arrive in one piece, small enough to keep one read inside a sane
// context budget. Other clients ignore the key.
export const READ_NOTE_MAX_RESULT_SIZE_CHARS = 100_000;

export function registerTools(
    server: FastMCP,
    vault: VaultBackend,
    searchIndex: SearchIndex,
    vaultName: string,
    readOnly = false,
    writeFolders: WriteScope = null,
    syncBeforeSearch?: SyncBeforeSearch,
) {
    if (readOnly) {
        console.log(`READ_ONLY mode: write tools disabled (${WRITE_TOOLS.join(", ")}).`);
    } else if (writeFolders) {
        console.log(`WRITE_FOLDERS: writes restricted to ${describeFolders(writeFolders)}.`);
    }
    const writeScopeNote = describeWriteScope(writeFolders);
    const _addTool = server.addTool.bind(server);
    server.addTool = (tool: any) => {
        const original = tool.execute;
        tool.execute = async (args: any, ctx: any) => {
            if (debugLogging) console.log(`[tool] ${tool.name}(${JSON.stringify(args)})`);
            const start = performance.now();
            const result = await original(args, ctx);
            if (debugLogging) console.log(`[tool] ${tool.name} → ${((performance.now() - start)).toFixed(0)}ms`);
            return result;
        };
        return _addTool(tool);
    };
    server.addTool({
        name: "read_note",
        description:
            "Read the content of a note from the Obsidian vault. Returns the markdown content and a deep link to open it in Obsidian; in CouchDB mode also the note's revision, which write_note and edit_note accept as expected_revision.",
        _meta: { "anthropic/maxResultSizeChars": READ_NOTE_MAX_RESULT_SIZE_CHARS },
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
        }),
        execute: async ({ path }) => {
            // Text and revision come from one fetch, so the revision names exactly this text.
            const revised = vault.readNoteRevision ? await vault.readNoteRevision(path) : null;
            const content = revised ? revised.content : await vault.readNote(path);
            if (content === null) {
                return `Note not found: ${path}`;
            }
            const deepLink = makeDeepLink(vaultName, path);
            const revisionLine = revised ? `\nRevision: ${revised.revision}` : "";
            return `[Open in Obsidian](${deepLink})${revisionLine}\n\n---\n\n${content}`;
        },
    });

    if (!readOnly) server.addTool({
        name: "write_note",
        description:
            "Write or update a note in the Obsidian vault. Creates the note if it doesn't exist. Replaces the entire content if it does — read first if you need to preserve existing content." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
            content: z.string().describe("Full markdown content for the note"),
            expected_revision: expectedRevisionParam,
        }),
        execute: async ({ path, content, expected_revision }) => {
            if (expected_revision !== undefined) {
                // A revision names an existing note, so this is an update.
                const denied = checkWrite(path, "update", writeFolders);
                if (denied) return denied;
                if (!vault.updateNote) return NO_REVISIONS_MESSAGE;
                try {
                    const { revision } = await vault.updateNote(path, () => content, { expectedRevision: expected_revision });
                    searchIndex.update(path, content, Date.now());
                    return `Note saved: ${path}\nRevision: ${revision}\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`;
                } catch (err) {
                    if (err instanceof RevisionMismatchError) return describeMismatch(err);
                    if (err instanceof NoteNotFoundError) return `Note not found: ${path}`;
                    throw err;
                }
            }
            // Whether this is a create or an update depends on the note existing,
            // so pass what's allowed down and let the backend decide in the same
            // step as the write.
            const allow = allowedActions(path, writeFolders);
            const canCreate = allow.has("create");
            const canUpdate = allow.has("update");
            if (!canCreate && !canUpdate) return checkWrite(path, "create", writeFolders)!;
            const mode = canCreate && canUpdate ? "upsert" : canCreate ? "create" : "update";
            let ok: boolean;
            try {
                // CouchDB mode replaces an existing note with a revision-checked put,
                // retried within edit_note's budget.
                ok = await vault.writeNote(path, content, { mode, maxAttempts: EDIT_MAX_ATTEMPTS, minRetryMs: EDIT_MIN_RETRY_MS });
            } catch (err) {
                if (err instanceof NoteExistsError) {
                    return `${checkWrite(path, "update", writeFolders)} The note already exists; choose a new path.`;
                }
                if (err instanceof NoteNotFoundError) return checkWrite(path, "create", writeFolders)!;
                if (err instanceof UpdateRetriesExhaustedError) {
                    return `Failed to write note: ${path} kept changing during ${err.attempts} attempts. Nothing was written; try again.`;
                }
                throw err;
            }
            if (!ok) {
                return `Failed to write note: ${path}`;
            }
            searchIndex.update(path, content, Date.now());
            const deepLink = makeDeepLink(vaultName, path);
            return `Note saved: ${path}\n[Open in Obsidian](${deepLink})`;
        },
    });

    server.addTool({
        name: "list_notes",
        description: "List markdown notes in the vault with modification timestamps. Examples: list_notes(sort_by='modified', limit=10) for 10 most recent notes. list_notes(name='meeting') to find notes by name. list_notes(folder='daily') for a specific folder. list_notes(tag='project') for notes with a specific tag. Returns up to 100 notes by default.",
        parameters: z.object({
            folder: z
                .string()
                .optional()
                .describe("Folder to filter by, e.g. 'daily' or 'projects'. Omit for all notes."),
            name: z
                .string()
                .optional()
                .describe("Filter by name (case-insensitive substring match on path), e.g. 'meeting' or 'project-x'."),
            tag: z
                .string()
                .optional()
                .describe("Filter by tag, e.g. 'project' or 'daily'. Use list_tags to discover available tags."),
            sort_by: z
                .enum(["name", "modified"])
                .optional()
                .describe("Sort order: 'name' (default) or 'modified' (most recent first)."),
            modified_after: z
                .string()
                .optional()
                .describe("Only include notes modified after this ISO date, e.g. '2026-03-25' or '2026-03-25T10:00'."),
            limit: z.coerce
                .number()
                .optional()
                .describe("Max number of notes to return. Default 100."),
        }),
        execute: async ({ folder, name, tag, sort_by, modified_after, limit }) => {
            // Use search index (works with encrypted vaults), fall back to vault
            let notes = searchIndex.listWithMtime(folder);
            let vaultTotal: number | null = searchIndex.size;
            let servedByVault = false;
            if (notes.length === 0) {
                notes = await vault.listNotesWithMtime(folder);
                servedByVault = notes.length > 0;
                // The fallback only tells us the vault total when it was unscoped.
                if (vaultTotal === 0) vaultTotal = folder ? null : notes.length;
            }
            const folderTotal = folder ? notes.length : null;
            const filters: string[] = [];
            if (name) {
                const lower = name.toLowerCase();
                notes = notes.filter((n) => n.path.toLowerCase().includes(lower));
                filters.push(`name="${name}"`);
            }
            if (tag) {
                notes = notes.filter((n) => searchIndex.getTags(n.path).includes(tag));
                filters.push(`tag="${tag}"`);
            }
            if (modified_after) {
                const cutoff = new Date(modified_after).getTime();
                if (isNaN(cutoff)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
                notes = notes.filter((n) => n.mtime >= cutoff);
                filters.push(`modified_after="${modified_after}"`);
            }
            const index = { state: searchIndex.state, size: searchIndex.size, servedByVault };
            if (notes.length === 0) {
                return describeNoMatch({ vaultTotal, folder, folderTotal, filters, index });
            }
            const sortBy = sort_by === "modified" ? "modified" : "name";
            if (sortBy === "modified") {
                notes.sort((a, b) => b.mtime - a.mtime);
            }
            const cap = limit ?? 100;
            const total = notes.length;
            const capped = notes.slice(0, cap);
            const header = describeListing({
                shown: capped.length,
                matched: total,
                vaultTotal,
                folder,
                folderTotal,
                filters,
                sortBy,
                limit: cap,
                omitted: notes.slice(cap).map((n) => n.path),
                index,
            });
            const lines = capped.map((n) => {
                const deepLink = makeDeepLink(vaultName, n.path);
                const date = n.mtime ? new Date(n.mtime).toISOString().slice(0, 16) : "";
                return `- ${date} [${n.path}](${deepLink})`;
            });
            return [header, ...lines].join("\n");
        },
    });

    server.addTool({
        name: "search_notes",
        description:
            "Search note contents for terms, case-insensitive.\n" +
            "Paths and frontmatter titles are searched first and such hits rank on top, marked [path/title]; content hits follow. " +
            "Returns paths with one context line each, never the note body: call read_note on a hit before relying on it. " +
            "Give `terms` (a note matches when ANY term occurs — OR, so list synonyms, field names and other-language wordings; a term may contain spaces; ranked by how many terms match) " +
            "Filters: folder, tag, modified_after. " +
            "The first line of every response is the index status: the CouchDB sequence the index is caught up with after a catch-up run just before the search, " +
            "the server time (local zone and UTC), its age in minutes, how many notes carry content, and any documents that could not be read.",
        parameters: z.object({
            terms: z
                .array(z.string().max(SEARCH_MAX_TERM_LENGTH))
                .max(SEARCH_MAX_TERMS)
                .optional()
                .describe(`Case-insensitive substrings, at most ${SEARCH_MAX_TERMS} of at most ${SEARCH_MAX_TERM_LENGTH} characters each; a note matches when any of them occurs. E.g. ['drag i kanban', 'kanban', 'labels på kategori'].`),
            folder: z
                .string()
                .optional()
                .describe("Folder to search in, e.g. 'projects'. Omit for the whole vault."),
            tag: z
                .string()
                .optional()
                .describe("Only notes carrying this tag, e.g. 'project'."),
            modified_after: z
                .string()
                .optional()
                .describe("Only notes modified after this ISO date, e.g. '2026-03-25' or '2026-03-25T10:00'."),
            limit: z.coerce
                .number()
                .optional()
                .describe(`Max hits to return, default and maximum ${SEARCH_MAX_HITS}.`),
        }),
        execute: async ({ terms, folder, tag, modified_after, limit }) => {
            const cleanTerms = cleanSearchTerms(terms);
            if (cleanTerms.length === 0) {
                return "Give at least one term.";
            }
            let modifiedAfter: number | undefined;
            if (modified_after) {
                modifiedAfter = new Date(modified_after).getTime();
                if (isNaN(modifiedAfter)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
            }
            const cap = Math.max(1, Math.min(SEARCH_MAX_HITS, limit ?? SEARCH_MAX_HITS));

            // Catch up first, so a hit can never predate the vault (see main.ts).
            const sync = syncBeforeSearch ? await syncBeforeSearch() : { unreadable: 0 };
            const status: SyncStatus = {
                mode: syncBeforeSearch ? "couchdb" : "local",
                state: searchIndex.state,
                seq: searchIndex.since,
                syncedAt: searchIndex.lastSyncAt,
                now: Date.now(),
                notes: searchIndex.size,
                withContent: searchIndex.contentCount,
                unreadable: sync.unreadable,
                error: sync.error,
            };
            const { hits, total } = searchIndex.search({ terms: cleanTerms, folder, tag, modifiedAfter, limit: cap });
            const query = describeQuery(cleanTerms);
            return `${describeSync(status)}\n${describeHits(hits, total, query, (p) => makeDeepLink(vaultName, p))}`;
        },
    });

    server.addTool({
        name: "list_folders",
        description:
            "List all folders in the vault. Use this to discover folder names before writing or listing notes. Returns the folder tree with note counts.",
        parameters: z.object({}),
        execute: async () => {
            let paths = searchIndex.listPaths();
            if (paths.length === 0) {
                paths = await vault.listNotes();
            }
            const folders = new Map<string, number>();
            for (const p of paths) {
                const lastSlash = p.lastIndexOf("/");
                if (lastSlash === -1) {
                    folders.set("(root)", (folders.get("(root)") ?? 0) + 1);
                } else {
                    const folder = p.slice(0, lastSlash);
                    folders.set(folder, (folders.get(folder) ?? 0) + 1);
                    // Ensure all parent folders appear in the list
                    let parent = folder;
                    while (parent.includes("/")) {
                        parent = parent.slice(0, parent.lastIndexOf("/"));
                        if (!folders.has(parent)) folders.set(parent, 0);
                    }
                }
            }
            if (folders.size === 0) {
                return "Vault is empty.";
            }
            const sorted = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            return sorted.map(([f, count]) => `- ${f} (${count} notes)`).join("\n");
        },
    });

    server.addTool({
        name: "list_tags",
        description:
            "List all tags used in the vault, sorted by frequency. Use this to discover tags before filtering with list_notes.",
        parameters: z.object({}),
        execute: async () => {
            const tags = searchIndex.listAllTags();
            if (tags.length === 0) {
                return "No tags found in the vault.";
            }
            return tags.map(({ tag, count }) => `- #${tag} (${count} notes)`).join("\n");
        },
    });



    if (!readOnly) server.addTool({
        name: "edit_note",
        description:
            "Edit a note without rewriting it. Use 'append' (default) to add content to the end, 'prepend' to add after frontmatter, or 'replace' to swap old_text with new content. For replace, the old_text must match exactly once." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-25.md'"),
            content: z.string().describe("Text to append, prepend, or use as replacement for old_text"),
            operation: z
                .enum(["append", "prepend", "replace"])
                .optional()
                .describe("'append' (default): add to end. 'prepend': add after frontmatter. 'replace': swap old_text with content."),
            old_text: z
                .string()
                .optional()
                .describe("Required for replace operation. Exact text to find and replace. Must match exactly once."),
            expected_revision: expectedRevisionParam,
        }),
        execute: async ({ path, content: newContent, operation, old_text, expected_revision }) => {
            const denied = checkWrite(path, "update", writeFolders);
            if (denied) return denied;
            const op = operation ?? "append";

            if (vault.updateNote) {
                // CouchDB mode: the edit is applied to the text it was read with and
                // written only if the note is still at that revision. When another
                // writer got in between, the edit is re-applied to the new text
                // (a replace re-checks old_text each time), so nobody's edit is lost.
                try {
                    const { content: updated, revision, attempts } = await vault.updateNote(
                        path,
                        (existing) => applyEdit(existing, op, newContent, old_text),
                        { expectedRevision: expected_revision, maxAttempts: EDIT_MAX_ATTEMPTS, minRetryMs: EDIT_MIN_RETRY_MS },
                    );
                    if (debugLogging && attempts > 1) console.log(`[tool] edit_note applied after ${attempts} attempts`);
                    searchIndex.update(path, updated, Date.now());
                    return `Note edited (${op}): ${path}\nRevision: ${revision}\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`;
                } catch (err) {
                    if (err instanceof EditRefused) return err.message;
                    if (err instanceof NoteNotFoundError) return `Note not found: ${path}`;
                    if (err instanceof RevisionMismatchError) return describeMismatch(err);
                    if (err instanceof UpdateRetriesExhaustedError) {
                        return `Failed to edit note: ${path} kept changing during ${err.attempts} attempts. Nothing was written; try again.`;
                    }
                    throw err;
                }
            }
            if (expected_revision !== undefined) return NO_REVISIONS_MESSAGE;

            const existing = await vault.readNote(path);
            if (existing === null) {
                return `Note not found: ${path}`;
            }
            let updated: string;
            try {
                updated = applyEdit(existing, op, newContent, old_text);
            } catch (err) {
                if (err instanceof EditRefused) return err.message;
                throw err;
            }

            let ok: boolean;
            try {
                // "update": a note deleted since it was read isn't recreated.
                ok = await vault.writeNote(path, updated, { mode: "update" });
            } catch (err) {
                if (err instanceof NoteNotFoundError) return `Note not found: ${path}`;
                throw err;
            }
            if (!ok) {
                return `Failed to edit note: ${path}`;
            }
            searchIndex.update(path, updated, Date.now());
            const deepLink = makeDeepLink(vaultName, path);
            return `Note edited (${op}): ${path}\n[Open in Obsidian](${deepLink})`;
        },
    });

    if (!readOnly) server.addTool({
        name: "delete_note",
        description: "Delete a note from the Obsidian vault." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note to delete"),
        }),
        execute: async ({ path }) => {
            const denied = checkWrite(path, "delete", writeFolders);
            if (denied) return denied;
            // The sync layer reports success even when nothing existed at the
            // path, so "Deleted" would claim a cleanup that never happened.
            // readNote returns "" for an empty note and null only when absent.
            const existing = await vault.readNote(path);
            if (existing === null) return `Note not found: ${path}`;
            const ok = await vault.deleteNote(path);
            if (ok) searchIndex.remove(path);
            return ok ? `Deleted: ${path}` : `Failed to delete: ${path}`;
        },
    });

    if (!readOnly) server.addTool({
        name: "move_note",
        description:
            "Move or rename a note. Use this to rename a note within the same folder, move it to a different folder, or both at once. Creates destination folders automatically. Never replaces an existing note at the destination." + writeScopeNote,
        parameters: z.object({
            from: z.string().describe("Current path, e.g. 'daily/old-name.md'"),
            to: z.string().describe("New path, e.g. 'projects/new-name.md'"),
        }),
        execute: async ({ from, to }) => {
            // A move deletes at the source and creates at the destination.
            const denied = checkWrite(from, "delete", writeFolders) ?? checkWrite(to, "create", writeFolders);
            if (denied) return denied;
            const content = await vault.readNote(from);
            let ok: boolean;
            try {
                ok = await vault.moveNote(from, to);
            } catch (err) {
                if (err instanceof NoteExistsError) return `A note already exists at ${to}. Choose another path.`;
                throw err;
            }
            if (!ok) {
                return `Failed to move: ${from} → ${to}`;
            }
            searchIndex.remove(from);
            // content === "" is an empty-but-present note: keep it indexed at the new path.
            if (content !== null) searchIndex.update(to, content, Date.now());
            const deepLink = makeDeepLink(vaultName, to);
            return `Moved: ${from} → ${to}\n[Open in Obsidian](${deepLink})`;
        },
    });

    server.addTool({
        name: "get_note_metadata",
        description:
            "Get metadata about a note without reading its full content. Returns frontmatter, tags, outgoing links, backlinks (notes that link to this one), size, and timestamps. Use this to navigate the knowledge graph.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'projects/my-project.md'"),
        }),
        execute: async ({ path }) => {
            const meta = await vault.getMetadata(path);
            if (!meta) {
                return `Note not found: ${path}`;
            }
            const deepLink = makeDeepLink(vaultName, path);
            const lines = [
                `**${path}**`,
                `Size: ${meta.size} bytes`,
                `Created: ${new Date(meta.ctime).toISOString()}`,
                `Modified: ${new Date(meta.mtime).toISOString()}`,
            ];
            if (meta.revision) lines.push(`Revision: ${meta.revision}`);
            if (meta.frontmatterError) {
                lines.push(`\nFrontmatter: not read, it isn't valid YAML (${meta.frontmatterError})`);
            }
            if (Object.keys(meta.frontmatter).length > 0) {
                lines.push(`\nFrontmatter:`);
                for (const [k, v] of Object.entries(meta.frontmatter)) {
                    lines.push(`  ${k}: ${v}`);
                }
            }
            if (meta.tags.length > 0) {
                lines.push(`\nTags: ${meta.tags.map((t) => `#${t}`).join(", ")}`);
            }
            if (meta.links.length > 0) {
                lines.push(`\nOutgoing links: ${meta.links.join(", ")}`);
            }
            const backlinks = searchIndex.getBacklinks(path);
            if (backlinks.length > 0) {
                lines.push(`\nBacklinks: ${backlinks.join(", ")}`);
            }
            lines.push(`\n[Open in Obsidian](${deepLink})`);
            return lines.join("\n");
        },
    });
}
