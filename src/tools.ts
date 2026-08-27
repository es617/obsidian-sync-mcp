import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import type { VaultBackend } from "./vault-backend.js";
import type { SearchBuildStatus, SearchIndex } from "./search.js";
import { isPathWritable } from "./write-scope.js";

const debugLogging = process.env.LOG_LEVEL === "debug";

const WRITE_TOOLS = ["write_note", "edit_note", "delete_note", "move_note"] as const;

export function formatIndexStatusNotice(status: SearchBuildStatus): string {
    if (status.state === "ready") return "";
    if (status.state === "error") {
        return "⚠ Search index update failed. Index-backed results, counts, and backlinks may be stale or incomplete.";
    }
    const progress = status.total && status.total > 0
        ? ` (${Math.min(100, Math.round(status.processed / status.total * 100))}% complete)`
        : status.processed > 0 ? ` (${status.processed} changes processed)` : "";
    return status.state === "building"
        ? `⚠ Search index is building${progress}. Index-backed results, counts, and backlinks are incomplete.`
        : `⚠ Search index is catching up${progress}. Index-backed results, counts, and backlinks may omit recent changes.`;
}

function withIndexStatusNotice(value: string, searchIndex: SearchIndex): string {
    const notice = formatIndexStatusNotice(searchIndex.status);
    return notice ? `${notice}\n\n${value}` : value;
}

export function registerTools(
    server: FastMCP,
    vault: VaultBackend,
    searchIndex: SearchIndex,
    vaultName: string,
    readOnly = false,
    writeFolders: string[] | null = null,
) {
    if (readOnly) {
        console.log(`READ_ONLY mode: write tools disabled (${WRITE_TOOLS.join(", ")}).`);
    } else if (writeFolders) {
        console.log(`WRITE_FOLDERS: writes restricted to ${writeFolders.map((f) => f + "/").join(", ")}.`);
    }
    const writeScopeNote = writeFolders
        ? ` Writes are only allowed inside: ${writeFolders.map((f) => f + "/").join(", ")}.`
        : "";
    const denyWrite = (path: string) =>
        `Write access denied: '${path}' is outside the writable folders (${writeFolders!.map((f) => f + "/").join(", ")}).`;
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
            "Read the content of a note from the Obsidian vault. Returns the markdown content and a deep link to open it in Obsidian.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
        }),
        execute: async ({ path }) => {
            const content = await vault.readNote(path);
            if (content === null) {
                return `Note not found: ${path}`;
            }
            const deepLink = makeDeepLink(vaultName, path);
            return `[Open in Obsidian](${deepLink})\n\n---\n\n${content}`;
        },
    });

    if (!readOnly) server.addTool({
        name: "write_note",
        description:
            "Write or update a note in the Obsidian vault. Creates the note if it doesn't exist. Replaces the entire content if it does — read first if you need to preserve existing content." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
            content: z.string().describe("Full markdown content for the note"),
        }),
        execute: async ({ path, content }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            const ok = await vault.writeNote(path, content);
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
            if (notes.length === 0) {
                notes = await vault.listNotesWithMtime(folder);
            }
            if (name) {
                const lower = name.toLowerCase();
                notes = notes.filter((n) => n.path.toLowerCase().includes(lower));
            }
            if (tag) {
                notes = notes.filter((n) => searchIndex.getTags(n.path).includes(tag));
            }
            if (modified_after) {
                const cutoff = new Date(modified_after).getTime();
                if (isNaN(cutoff)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
                notes = notes.filter((n) => n.mtime >= cutoff);
            }
            if (notes.length === 0) {
                const empty = searchIndex.status.state === "ready"
                    ? (folder ? `No notes found in folder: ${folder}` : "Vault is empty.")
                    : (folder ? `No indexed notes found in folder: ${folder}` : "No indexed notes are available yet.");
                return withIndexStatusNotice(empty, searchIndex);
            }
            if (sort_by === "modified") {
                notes.sort((a, b) => b.mtime - a.mtime);
            }
            const cap = limit ?? 100;
            const total = notes.length;
            const capped = notes.slice(0, cap);
            const lines = capped.map((n) => {
                const deepLink = makeDeepLink(vaultName, n.path);
                const date = n.mtime ? new Date(n.mtime).toISOString().slice(0, 16) : "";
                return `- ${date} [${n.path}](${deepLink})`;
            });
            if (total > cap) {
                lines.push(`\n... and ${total - cap} more. Use a folder filter or limit to narrow results.`);
            }
            return withIndexStatusNotice(lines.join("\n"), searchIndex);
        },
    });

    if (searchIndex.fullTextEnabled) server.addTool({
        name: "search_notes",
        description:
            "Search note titles, aliases, headings, tags, and body text using the disk-backed full-text index. Returns ranked paths with matching snippets. Exact title, alias, filename, and path matches rank first, so a known note name is a good query. Use list_notes only to browse a folder or tag without a text query.",
        parameters: z.object({
            query: z
                .string()
                .describe("Words or phrase to find in note content and metadata."),
            folder: z
                .string()
                .optional()
                .describe("Restrict results to this vault-relative folder."),
            tag: z
                .string()
                .optional()
                .describe("Require this exact tag in addition to the text query."),
            modified_after: z
                .string()
                .optional()
                .describe("Only include notes modified after this ISO date."),
            mode: z
                .enum(["all", "any", "phrase"])
                .optional()
                .describe("Match all words (default), any word, or the exact token phrase."),
            limit: z.coerce
                .number()
                .int()
                .min(1)
                .max(50)
                .optional()
                .describe("Maximum ranked results. Default 10; maximum 50."),
        }),
        execute: async ({ query, folder, tag, modified_after, mode, limit }) => {
            let modifiedAfter: number | undefined;
            if (modified_after) {
                modifiedAfter = new Date(modified_after).getTime();
                if (isNaN(modifiedAfter)) {
                    return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
                }
            }

            try {
                const status = searchIndex.status;
                const statusNotice = formatIndexStatusNotice(status);
                const results = searchIndex.searchNotes({
                    query,
                    folder,
                    tag,
                    modifiedAfter,
                    mode,
                    limit,
                });
                if (results.length === 0) {
                    return `${statusNotice ? `${statusNotice}\n\n` : ""}No notes found matching: ${query}`;
                }

                const rendered = results.map((result) => {
                    const deepLink = makeDeepLink(vaultName, result.path);
                    const date = result.mtime
                        ? ` (${new Date(result.mtime).toISOString().slice(0, 10)})`
                        : "";
                    const location = result.breadcrumb ? ` — ${result.breadcrumb}` : "";
                    const snippet = result.snippet ? `\n  ${result.snippet}` : "";
                    return `- [${result.path}](${deepLink})${date}${location}${snippet}`;
                }).join("\n");
                return statusNotice ? `${statusNotice}\n\n${rendered}` : rendered;
            } catch (error) {
                return `Invalid search query: ${(error as Error).message}`;
            }
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
                const empty = searchIndex.status.state === "ready"
                    ? "Vault is empty."
                    : "No indexed folders are available yet.";
                return withIndexStatusNotice(empty, searchIndex);
            }
            const sorted = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            return withIndexStatusNotice(
                sorted.map(([f, count]) => `- ${f} (${count} notes)`).join("\n"),
                searchIndex,
            );
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
                const empty = searchIndex.status.state === "ready"
                    ? "No tags found in the vault."
                    : "No indexed tags are available yet.";
                return withIndexStatusNotice(empty, searchIndex);
            }
            return withIndexStatusNotice(
                tags.map(({ tag, count }) => `- #${tag} (${count} notes)`).join("\n"),
                searchIndex,
            );
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
        }),
        execute: async ({ path, content: newContent, operation, old_text }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            const existing = await vault.readNote(path);
            if (existing === null) {
                return `Note not found: ${path}`;
            }

            let updated: string;
            const op = operation ?? "append";

            if (op === "replace") {
                if (!old_text) {
                    return "old_text is required for replace operation.";
                }
                const idx = existing.indexOf(old_text);
                if (idx === -1) {
                    return "old_text not found in note.";
                }
                if (existing.indexOf(old_text, idx + 1) !== -1) {
                    return "old_text matches multiple times. Provide a longer, unique string.";
                }
                updated = existing.slice(0, idx) + newContent + existing.slice(idx + old_text.length);
            } else if (op === "prepend") {
                // Insert after frontmatter if present
                const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
                if (fmMatch) {
                    const afterFm = fmMatch[0].length;
                    updated = existing.slice(0, afterFm) + newContent + "\n" + existing.slice(afterFm);
                } else {
                    updated = newContent + "\n" + existing;
                }
            } else {
                // append
                updated = existing.endsWith("\n") ? existing + newContent : existing + "\n" + newContent;
            }

            const ok = await vault.writeNote(path, updated);
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
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            const ok = await vault.deleteNote(path);
            if (ok) searchIndex.remove(path);
            return ok ? `Deleted: ${path}` : `Failed to delete: ${path}`;
        },
    });

    if (!readOnly) server.addTool({
        name: "move_note",
        description:
            "Move or rename a note. Use this to rename a note within the same folder, move it to a different folder, or both at once. Creates destination folders automatically." + writeScopeNote,
        parameters: z.object({
            from: z.string().describe("Current path, e.g. 'daily/old-name.md'"),
            to: z.string().describe("New path, e.g. 'projects/new-name.md'"),
        }),
        execute: async ({ from, to }) => {
            // Moving out of a folder deletes there; moving in writes there — both ends must be writable.
            if (!isPathWritable(from, writeFolders)) return denyWrite(from);
            if (!isPathWritable(to, writeFolders)) return denyWrite(to);
            const content = await vault.readNote(from);
            const ok = await vault.moveNote(from, to);
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
            return withIndexStatusNotice(lines.join("\n"), searchIndex);
        },
    });
}
