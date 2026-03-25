import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import type { VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";

export function registerTools(
    server: FastMCP,
    vault: VaultBackend,
    searchIndex: SearchIndex,
    vaultName: string,
) {
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

    server.addTool({
        name: "write_note",
        description:
            "Write or update a note in the Obsidian vault. Creates the note if it doesn't exist, overwrites if it does.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
            content: z.string().describe("Full markdown content for the note"),
        }),
        execute: async ({ path, content }) => {
            const ok = await vault.writeNote(path, content);
            if (!ok) {
                return `Failed to write note: ${path}`;
            }
            searchIndex.update(path, content);
            const deepLink = makeDeepLink(vaultName, path);
            return `Note saved: ${path}\n[Open in Obsidian](${deepLink})`;
        },
    });

    server.addTool({
        name: "list_notes",
        description: "List all markdown notes in the vault, optionally filtered to a folder.",
        parameters: z.object({
            folder: z
                .string()
                .optional()
                .describe("Folder to filter by, e.g. 'daily/' or 'projects/'. Omit for all notes."),
        }),
        execute: async ({ folder }) => {
            let notes = searchIndex.listPaths(folder);
            if (notes.length === 0) {
                notes = await vault.listNotes(folder);
            }
            if (notes.length === 0) {
                return folder ? `No notes found in folder: ${folder}` : "Vault is empty.";
            }
            const total = notes.length;
            const capped = notes.slice(0, 500);
            const lines = capped.map((p) => {
                const deepLink = makeDeepLink(vaultName, p);
                return `- [${p}](${deepLink})`;
            });
            if (total > 500) {
                lines.push(`\n... and ${total - 500} more. Use a folder filter to narrow results.`);
            }
            return lines.join("\n");
        },
    });

    server.addTool({
        name: "search_vault",
        description: "Search for a text query across all notes in the vault. Returns matching notes with snippets.",
        parameters: z.object({
            query: z.string().describe("Text to search for (case-insensitive)"),
        }),
        execute: async ({ query }) => {
            const results = searchIndex.search(query);
            if (results.length === 0) {
                return `No results for: ${query}`;
            }
            const lines = results.map((r) => {
                const deepLink = makeDeepLink(vaultName, r.path);
                return `### [${r.path}](${deepLink})\n\`\`\`\n${r.snippet}\n\`\`\``;
            });
            return lines.join("\n\n");
        },
    });

    server.addTool({
        name: "delete_note",
        description: "Delete a note from the Obsidian vault.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note to delete"),
        }),
        execute: async ({ path }) => {
            const ok = await vault.deleteNote(path);
            if (ok) searchIndex.remove(path);
            return ok ? `Deleted: ${path}` : `Failed to delete: ${path}`;
        },
    });

    server.addTool({
        name: "move_note",
        description:
            "Move or rename a note. Use this to rename a note within the same folder, move it to a different folder, or both at once. Creates destination folders automatically.",
        parameters: z.object({
            from: z.string().describe("Current path, e.g. 'daily/old-name.md'"),
            to: z.string().describe("New path, e.g. 'projects/new-name.md'"),
        }),
        execute: async ({ from, to }) => {
            const content = await vault.readNote(from);
            const ok = await vault.moveNote(from, to);
            if (!ok) {
                return `Failed to move: ${from} → ${to}`;
            }
            searchIndex.remove(from);
            if (content) searchIndex.update(to, content);
            const deepLink = makeDeepLink(vaultName, to);
            return `Moved: ${from} → ${to}\n[Open in Obsidian](${deepLink})`;
        },
    });

    server.addTool({
        name: "get_note_metadata",
        description:
            "Get metadata about a note without reading its full content. Returns frontmatter properties, tags (both frontmatter and inline #tags), internal links ([[wikilinks]] and markdown links), file size, and timestamps.",
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
                lines.push(`\nLinks: ${meta.links.join(", ")}`);
            }
            lines.push(`\n[Open in Obsidian](${deepLink})`);
            return lines.join("\n");
        },
    });
}
