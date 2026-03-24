import { FastMCP, GoogleProvider } from "fastmcp";
import { z } from "zod";
import { Vault } from "./vault.js";
import { makeDeepLink } from "./deeplink.js";

// --- Configuration from environment ---
const COUCHDB_URL = process.env.COUCHDB_URL ?? "http://localhost:5984";
const COUCHDB_USER = process.env.COUCHDB_USER ?? "admin";
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD ?? "password";
const COUCHDB_DATABASE = process.env.COUCHDB_DATABASE ?? "obsidian";
const COUCHDB_PASSPHRASE = process.env.COUCHDB_PASSPHRASE || undefined;
const VAULT_NAME = process.env.VAULT_NAME ?? "MyVault";
const PORT = parseInt(process.env.PORT ?? "8787");
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// --- Initialize vault ---
const vault = new Vault({
    couchdbUrl: COUCHDB_URL,
    couchdbUser: COUCHDB_USER,
    couchdbPassword: COUCHDB_PASSWORD,
    database: COUCHDB_DATABASE,
    passphrase: COUCHDB_PASSPHRASE,
});
await vault.init();
console.log("Vault connected.");

// --- MCP Server ---
const serverOptions: ConstructorParameters<typeof FastMCP>[0] = {
    name: "obsidian-sync-mcp",
    version: "0.1.0",
    instructions: "Access and manage an Obsidian vault. You can read, write, list, search, and delete markdown notes. Every response includes a deep link to open the note directly in Obsidian.",
};

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    serverOptions.auth = new GoogleProvider({
        baseUrl: BASE_URL,
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
    });
    console.log("OAuth enabled (Google).");
} else {
    console.log("OAuth disabled (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable).");
}

const server = new FastMCP(serverOptions);

// --- Tools ---

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
        const deepLink = makeDeepLink(VAULT_NAME, path);
        return `${content}\n\n---\n[Open in Obsidian](${deepLink})`;
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
        const deepLink = makeDeepLink(VAULT_NAME, path);
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
        const notes = await vault.listNotes(folder);
        if (notes.length === 0) {
            return folder ? `No notes found in folder: ${folder}` : "Vault is empty.";
        }
        const lines = notes.map((p) => {
            const deepLink = makeDeepLink(VAULT_NAME, p);
            return `- [${p}](${deepLink})`;
        });
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
        const results = await vault.searchVault(query);
        if (results.length === 0) {
            return `No results for: ${query}`;
        }
        const lines = results.map((r) => {
            const deepLink = makeDeepLink(VAULT_NAME, r.path);
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
        return ok ? `Deleted: ${path}` : `Failed to delete: ${path}`;
    },
});

// --- Start server ---
server.start({
    transportType: "httpStream",
    httpStream: { port: PORT, endpoint: "/mcp" },
});
console.log(`MCP server listening on port ${PORT}`);
