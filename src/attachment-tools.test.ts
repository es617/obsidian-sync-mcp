import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerAttachmentTools, decodeBase64Strict, formatBytes, estimateBase64Tokens, type AttachmentToolOptions } from "./attachment-tools.js";
import { UploadRegistry, UPLOAD_ROUTE_PREFIX, mountAttachmentUpload } from "./uploads.js";
import { Hono } from "hono";
import { memoryAttachments } from "./attachment-test-fixtures.js";
import { SUPPORTED_ATTACHMENT_EXTENSIONS } from "./attachment-path.js";
import { SearchIndex } from "./search.js";
import { AttachmentTooLargeError, AttachmentMoveIncompleteError } from "./vault-backend.js";
import { parseWriteFolders } from "./write-scope.js";

type Tool = { name: string; description: string; parameters: any; execute: (args: any) => Promise<string> };

function setup(overrides: Partial<AttachmentToolOptions> = {}) {
    const { vault, files } = memoryAttachments();
    const registry = new UploadRegistry();
    const tools: Tool[] = [];
    const server = { addTool: (t: Tool) => tools.push(t) };
    const searchIndex = new SearchIndex();
    searchIndex.state = "ready";
    /** Make `note` embed the given attachment names. */
    const embed = (note: string, ...targets: string[]) => searchIndex.update(note, targets.map((t) => `![[${t}]]`).join("\n"));
    registerAttachmentTools(server as any, {
        vault,
        searchIndex,
        vaultName: "V",
        readOnly: false,
        writeFolders: null,
        allowedExtensions: new Set(SUPPORTED_ATTACHMENT_EXTENSIONS),
        maxBytes: 1000,
        base64MaxBytes: 10,
        registry,
        baseUrl: "https://mcp.example.com/",
        ...overrides,
    });
    const call = (name: string, args: any) => {
        const tool = tools.find((t) => t.name === name);
        assert.ok(tool, `${name} registered`);
        return tool.execute(tool.parameters.parse(args));
    };
    /** Put a file in the fake vault and the index, as a sync would. */
    const put = (path: string, size: number, mtime = 2) => {
        files.set(path, { data: new Uint8Array(size), ctime: 1, mtime });
        searchIndex.updateAttachment(path, size, mtime);
    };
    return { tools, files, registry, call, embed, put, searchIndex, vault };
}

const b64 = (arr: number[]) => Buffer.from(arr).toString("base64");

describe("attachment tool registration", () => {
    it("registers all tools, and only metadata in read-only mode", () => {
        assert.deepEqual(setup().tools.map((t) => t.name).sort(), [
            "create_attachment_upload", "delete_attachment", "get_attachment_metadata", "list_attachments", "move_attachment", "write_attachment",
        ]);
        assert.deepEqual(setup({ readOnly: true }).tools.map((t) => t.name).sort(), ["get_attachment_metadata", "list_attachments"]);
    });
});

describe("create_attachment_upload", () => {
    it("returns a single-use URL under the base URL bound to the path", async () => {
        const { call, registry } = setup();
        const out = await call("create_attachment_upload", { path: "Attachments/a.png", size: 5 });
        const url = out.match(/https:\/\/\S+/)?.[0];
        assert.ok(url?.startsWith(`https://mcp.example.com${UPLOAD_ROUTE_PREFIX}`), out);
        assert.match(out, /curl -fsS -X PUT --data-binary @/);
        const handle = registry.take(url!.slice(url!.lastIndexOf("/") + 1).replace(/'$/, ""));
        assert.equal(handle?.path, "Attachments/a.png");
        assert.equal(handle?.expectedSize, 5);
        assert.equal(handle?.overwrite, false);
    });

    it("validates path, extension allowlist, write scope, size and existing files", async () => {
        const { call, files } = setup({ writeFolders: parseWriteFolders("MCP"), allowedExtensions: new Set(["png"]) });
        assert.match(await call("create_attachment_upload", { path: "MCP/a.md" }), /Invalid attachment path/);
        assert.match(await call("create_attachment_upload", { path: "MCP/a.pdf" }), /extension must be one of png/);
        assert.match(await call("create_attachment_upload", { path: "Other/a.png" }), /Write access denied/);
        assert.match(await call("create_attachment_upload", { path: "MCP/a.png", size: 1001 }), /over the upload limit/);
        files.set("MCP/a.png", { data: new Uint8Array(1), ctime: 1, mtime: 1 });
        assert.match(await call("create_attachment_upload", { path: "MCP/a.png" }), /already exists/);
        assert.match(await call("create_attachment_upload", { path: "MCP/a.png", overwrite: true }), /Upload URL/);
    });
});

describe("write_attachment", () => {
    it("decodes base64 and writes the file", async () => {
        const { call, files, searchIndex } = setup();
        const out = await call("write_attachment", { path: "a.png", content_base64: b64([1, 2, 3]) });
        assert.deepEqual(searchIndex.listAttachments(), [{ path: "a.png", size: 3, mtime: searchIndex.listAttachments()[0].mtime }]);
        assert.match(out, /Attachment saved: a.png/);
        assert.match(out, /!\[\[a.png\]\]/);
        assert.deepEqual(files.get("a.png")?.data, new Uint8Array([1, 2, 3]));
    });

    it("accepts a data: URL", async () => {
        const { call, files } = setup();
        await call("write_attachment", { path: "a.png", content_base64: `data:image/png;base64,${b64([9])}` });
        assert.deepEqual(files.get("a.png")?.data, new Uint8Array([9]));
    });

    it("refuses oversize, invalid, empty and existing content", async () => {
        const { call, files } = setup();
        assert.match(await call("write_attachment", { path: "a.png", content_base64: b64(Array.from({ length: 11 }, () => 0)) }), /over the inline limit/);
        assert.match(await call("write_attachment", { path: "a.png", content_base64: "not base64!" }), /not valid base64/);
        assert.match(await call("write_attachment", { path: "a.png", content_base64: "" }), /empty/);
        files.set("a.png", { data: new Uint8Array(1), ctime: 1, mtime: 1 });
        assert.match(await call("write_attachment", { path: "a.png", content_base64: b64([1]) }), /already exists/);
        assert.equal(files.get("a.png")?.data.byteLength, 1);
    });
});

describe("delete_attachment / move_attachment / get_attachment_metadata", () => {
    it("move refuses to clobber and reports stale embeds", async () => {
        const { call, files, embed, put, searchIndex } = setup();
        put("a.png", 4);
        put("b.png", 1);
        embed("note.md", "a.png");
        assert.match(await call("move_attachment", { from: "a.png", to: "b.png" }), /already exists/);
        const out = await call("move_attachment", { from: "a.png", to: "c.png" });
        assert.match(out, /Moved: a.png → c.png/);
        assert.match(out, /still embed the old path: note.md/);
        assert.equal(files.has("a.png"), false);
        assert.deepEqual(searchIndex.listAttachments().map((a) => [a.path, a.size]), [["b.png", 1], ["c.png", 4]], "index follows the move");
    });

    it("move passes the size limit to the backend and explains a refusal", async () => {
        const { call, files, put, vault } = setup();
        put("big.mp4", 1500);
        const seen: any[] = [];
        const original = vault.moveAttachment.bind(vault);
        vault.moveAttachment = async (from, to, options) => {
            seen.push(options);
            if (options?.maxBytes !== undefined && files.get(from)!.data.byteLength > options.maxBytes) {
                throw new AttachmentTooLargeError(from, files.get(from)!.data.byteLength, options.maxBytes);
            }
            return original(from, to, options);
        };
        assert.match(await call("move_attachment", { from: "big.mp4", to: "x.mp4" }), /over the 1000 B limit for moving it here/);
        assert.deepEqual(seen, [{ overwrite: false, maxBytes: 1000 }]);
        assert.ok(files.has("big.mp4") && !files.has("x.mp4"));
    });

    it("move refuses a file of unknown size when there is a limit", async () => {
        const { call, put, vault } = setup();
        put("odd.mp4", 10);
        vault.moveAttachment = async (from, _to, options) => {
            throw new AttachmentTooLargeError(from, NaN, options!.maxBytes!);
        };
        assert.match(await call("move_attachment", { from: "odd.mp4", to: "x.mp4" }), /of unknown size, so it may be over the 1000 B limit/);
    });

    it("move reports a copy left behind when the source could not be deleted", async () => {
        const { call, files, put, vault, searchIndex } = setup();
        put("a.png", 4);
        vault.moveAttachment = async (from, to) => {
            files.set(to, files.get(from)!);
            throw new AttachmentMoveIncompleteError(from, to);
        };
        assert.match(await call("move_attachment", { from: "a.png", to: "b.png" }), /Copied a.png to b.png, but could not delete a.png/);
        assert.deepEqual(searchIndex.listAttachments().map((a) => a.path), ["a.png", "b.png"]);
        // A plain failure is not reported as a copy, even when both files exist.
        vault.moveAttachment = async () => false;
        assert.match(await call("move_attachment", { from: "a.png", to: "b.png", overwrite: true }), /^Failed to move: a.png → b.png$/);
    });

    it("metadata and delete report missing files", async () => {
        const { call, files, embed, put, searchIndex } = setup();
        assert.match(await call("get_attachment_metadata", { path: "x.png" }), /Attachment not found/);
        assert.match(await call("delete_attachment", { path: "x.png" }), /Attachment not found/);
        put("x.png", 2048);
        embed("n.md", "x.png");
        const meta = await call("get_attachment_metadata", { path: "x.png" });
        assert.match(meta, /Size: 2048 bytes \(2\.0 KB\)/);
        assert.match(meta, /Embedded or linked in: n.md/);
        assert.match(await call("delete_attachment", { path: "x.png" }), /Deleted: x.png\nThese notes still embed/);
        assert.equal(files.size, 0);
        assert.equal(searchIndex.attachmentCount, 0, "index follows the delete");
    });

    it("delete honours WRITE_FOLDERS", async () => {
        const { call, files } = setup({ writeFolders: parseWriteFolders("MCP") });
        files.set("x.png", { data: new Uint8Array(1), ctime: 1, mtime: 1 });
        assert.match(await call("delete_attachment", { path: "x.png" }), /Write access denied/);
        assert.equal(files.size, 1);
    });
});

describe("WRITE_FOLDERS permissions", () => {
    const createOnly = () => setup({ writeFolders: parseWriteFolders("MCP,Raw:create") });

    it("create-only: new files are allowed, replacing one is not", async () => {
        const { call, files } = createOnly();
        assert.match(await call("write_attachment", { path: "Raw/a.png", content_base64: b64([1]) }), /Attachment saved/);
        const again = await call("write_attachment", { path: "Raw/a.png", content_base64: b64([2]) });
        assert.match(again, /already exists: Raw\/a.png\. Choose another path\./, "no overwrite=true hint where update isn't allowed");
        assert.match(await call("write_attachment", { path: "Raw/a.png", content_base64: b64([2]), overwrite: true }), /Raw\/ allows only create, so 'Raw\/a.png' can't be changed/);
        assert.deepEqual(files.get("Raw/a.png")?.data, new Uint8Array([1]));
        assert.match(await call("create_attachment_upload", { path: "Raw/b.png" }), /Upload URL/);
        assert.match(await call("create_attachment_upload", { path: "Raw/a.png", overwrite: true }), /can't be changed/, "refused when the URL is created");
    });

    it("create-only: delete and move out are refused, move in is allowed", async () => {
        const { call, files, put } = createOnly();
        put("Raw/a.png", 1);
        put("MCP/b.png", 1);
        assert.match(await call("delete_attachment", { path: "Raw/a.png" }), /can't be deleted or moved/);
        assert.match(await call("move_attachment", { from: "Raw/a.png", to: "MCP/a.png" }), /can't be deleted or moved/);
        assert.match(await call("move_attachment", { from: "MCP/b.png", to: "Raw/a.png" }), /already exists: Raw\/a.png\. Choose another path/);
        assert.match(await call("move_attachment", { from: "MCP/b.png", to: "Raw/a.png", overwrite: true }), /can't be changed/);
        assert.match(await call("move_attachment", { from: "MCP/b.png", to: "Raw/b.png" }), /Moved: MCP\/b.png → Raw\/b.png/);
        assert.deepEqual([...files.keys()].sort(), ["Raw/a.png", "Raw/b.png"]);
    });

    it("tool descriptions list the permissions", () => {
        const tool = createOnly().tools.find((t) => t.name === "write_attachment")!;
        assert.match(tool.description, /Writes are only allowed inside: MCP\/, Raw\/ \(create only\)\./);
    });
});

describe("helpers", () => {
    it("decodeBase64Strict rejects garbage that Buffer would skip", () => {
        assert.deepEqual(decodeBase64Strict(" AQID \n"), new Uint8Array([1, 2, 3]));
        assert.throws(() => decodeBase64Strict("AQ*D"), /not valid base64/);
        assert.throws(() => decodeBase64Strict("A=QD"), /not valid base64/);
        assert.throws(() => decodeBase64Strict("AQIDB"), /not valid base64/);
    });

    it("formatBytes", () => {
        assert.equal(formatBytes(500), "500 B");
        assert.equal(formatBytes(1536), "1.5 KB");
        assert.equal(formatBytes(20 * 1024 * 1024), "20.0 MB");
    });
});

describe("list_attachments", () => {
    function populated() {
        const ctx = setup({ allowedExtensions: new Set(["png", "jpg", "pdf"]) });
        ctx.put("Attachments/shot.png", 3000, 30);
        ctx.put("Attachments/old.jpg", 500, 10);
        ctx.put("Attachments/sub/diagram.png", 100, 20);
        ctx.put("docs/report.pdf", 9000, 40);
        ctx.put("media/clip.mp4", 50, 50); // indexed but not on the configured allowlist
        ctx.embed("daily/today.md", "shot.png");
        ctx.searchIndex.update("projects/p.md", "![](Attachments/sub/diagram.png)\n[r](<docs/report.pdf>)");
        ctx.embed("daily/other.md", "Attachments/shot.png");
        return ctx;
    }
    const paths = (out: string) => [...out.matchAll(/\[([^\]]+)\]\(obsidian:/g)].map((m) => m[1]);

    it("lists by name with size, date and references, hiding extensions not allowed", async () => {
        const out = await populated().call("list_attachments", {});
        assert.deepEqual(paths(out), ["Attachments/old.jpg", "Attachments/shot.png", "Attachments/sub/diagram.png", "docs/report.pdf"]);
        assert.match(out, /^4 attachments/);
        assert.match(out, /2\.9 KB \[Attachments\/shot\.png\].* — in 2 notes/);
        assert.match(out, /\[Attachments\/sub\/diagram\.png\].* — in projects\/p\.md/);
        assert.match(out, /\[Attachments\/old\.jpg\].* — unreferenced/);
    });

    it("filters by folder, name and extension", async () => {
        const { call } = populated();
        assert.deepEqual(paths(await call("list_attachments", { folder: "Attachments/sub" })), ["Attachments/sub/diagram.png"]);
        assert.deepEqual(paths(await call("list_attachments", { name: "SHOT" })), ["Attachments/shot.png"]);
        assert.deepEqual(paths(await call("list_attachments", { extension: ".PDF" })), ["docs/report.pdf"]);
    });

    it("finds unreferenced files, counting embeds by file name and markdown links", async () => {
        const out = await populated().call("list_attachments", { unreferenced: true });
        assert.deepEqual(paths(out), ["Attachments/old.jpg"]);
        assert.match(out, /^1 attachment matching unreferenced \(of 4\), 500 B in total\./);
    });

    it("does not report a file embedded with a #page anchor as unreferenced", async () => {
        const ctx = populated();
        ctx.searchIndex.update("daily/reading.md", "![[old.jpg#crop]]");
        assert.deepEqual(paths(await ctx.call("list_attachments", { unreferenced: true })), []);
    });

    it("sorts by modified and size, and limits", async () => {
        const { call } = populated();
        assert.deepEqual(paths(await call("list_attachments", { sort_by: "modified" })), ["docs/report.pdf", "Attachments/shot.png", "Attachments/sub/diagram.png", "Attachments/old.jpg"]);
        assert.deepEqual(paths(await call("list_attachments", { sort_by: "size", limit: 2 })), ["docs/report.pdf", "Attachments/shot.png"]);
        assert.match(await call("list_attachments", { sort_by: "size", limit: 2 }), /showing the first 2/);
    });

    it("says why nothing matched, and warns while the index builds", async () => {
        const ctx = populated();
        assert.match(await ctx.call("list_attachments", { name: "nope" }), /^No attachments match name="nope"\. 4 attachments in the index\.$/);
        ctx.searchIndex.state = "building";
        assert.match(await ctx.call("list_attachments", {}), /still being built/);
    });

    it("is available in read-only mode", async () => {
        const { tools } = setup({ readOnly: true });
        assert.ok(tools.some((t) => t.name === "list_attachments"));
    });
});

describe("steering towards the upload URL", () => {
    it("write_attachment calls itself a fallback and points at create_attachment_upload with a token cost", () => {
        const { tools } = setup({ base64MaxBytes: 32 * 1024 });
        const write = tools.find((t) => t.name === "write_attachment")!;
        const upload = tools.find((t) => t.name === "create_attachment_upload")!;
        assert.match(write.description, /^Fallback for clients that cannot make HTTP requests/);
        assert.match(write.description, /up to 32 KB\./);
        assert.match(write.description, /about 13k output tokens/);
        assert.match(write.description, /use create_attachment_upload instead/);
        assert.match(upload.description, /^Preferred way/);
    });

    it("estimateBase64Tokens", () => {
        assert.equal(estimateBase64Tokens(3), 2);
        assert.ok(Math.abs(estimateBase64Tokens(262_144) - 106_000) < 1000, "256 KB is ~106k tokens");
    });
});

describe("WRITE_FOLDERS: every attachment tool under every permission set", () => {
    const scoped = (raw: string | null) => setup({ writeFolders: raw === null ? null : parseWriteFolders(raw) });
    const one = b64([1]);
    const two = b64([2]);

    it("unset: write, overwrite, move onto an existing file with overwrite, delete", async () => {
        const { call, files, tools } = scoped(null);
        assert.match(await call("write_attachment", { path: "x/a.png", content_base64: one }), /^Attachment saved/);
        assert.equal(await call("write_attachment", { path: "x/a.png", content_base64: two }), "Attachment already exists: x/a.png. Pass overwrite=true to replace it, or choose another path.");
        assert.match(await call("write_attachment", { path: "x/a.png", content_base64: two, overwrite: true }), /^Attachment saved/);
        assert.match(await call("write_attachment", { path: "y/b.png", content_base64: one }), /^Attachment saved/);
        assert.match(await call("move_attachment", { from: "y/b.png", to: "x/a.png", overwrite: true }), /^Moved/);
        assert.match(await call("delete_attachment", { path: "x/a.png" }), /^Deleted/);
        assert.equal(files.size, 0);
        for (const t of tools) assert.doesNotMatch(t.description, /Writes are only allowed/, t.name);
    });

    it("create-only: exact messages, and the same refusal whether or not the file exists", async () => {
        const { call, put } = scoped("MCP,Raw:create");
        put("Raw/a.png", 1);
        assert.equal(await call("create_attachment_upload", { path: "Raw/a.png" }), "Attachment already exists: Raw/a.png. Choose another path.");
        assert.equal(await call("write_attachment", { path: "Raw/a.png", content_base64: one }), "Attachment already exists: Raw/a.png. Choose another path.");
        for (const p of ["Raw/a.png", "Raw/missing.png"]) {
            assert.equal(await call("delete_attachment", { path: p }), `Write access denied: Raw/ allows only create, so '${p}' can't be deleted or moved.`);
            assert.equal(await call("move_attachment", { from: p, to: "MCP/x.png" }), `Write access denied: Raw/ allows only create, so '${p}' can't be deleted or moved.`);
            assert.equal(await call("write_attachment", { path: p, content_base64: one, overwrite: true }), `Write access denied: Raw/ allows only create, so '${p}' can't be changed.`);
            assert.equal(await call("create_attachment_upload", { path: p, overwrite: true }), `Write access denied: Raw/ allows only create, so '${p}' can't be changed.`);
        }
    });

    it("create-only: a rename within the folder is refused", async () => {
        const { call, put, files } = scoped("Raw:create");
        put("Raw/a.png", 1);
        assert.match(await call("move_attachment", { from: "Raw/a.png", to: "Raw/b.png" }), /'Raw\/a.png' can't be deleted or moved/);
        assert.deepEqual([...files.keys()], ["Raw/a.png"]);
    });

    it("create+update: overwrite=true works and the hint offers it; delete and move out are refused", async () => {
        const { call, put, files } = scoped("MCP,Notes:create+update");
        put("Notes/a.png", 1);
        put("MCP/m.png", 3);
        assert.equal(await call("write_attachment", { path: "Notes/a.png", content_base64: two }), "Attachment already exists: Notes/a.png. Pass overwrite=true to replace it, or choose another path.");
        assert.match(await call("write_attachment", { path: "Notes/a.png", content_base64: two, overwrite: true }), /^Attachment saved/);
        assert.deepEqual(files.get("Notes/a.png")?.data, new Uint8Array([2]));
        assert.match(await call("create_attachment_upload", { path: "Notes/a.png", overwrite: true }), /^Upload URL/);
        assert.match(await call("move_attachment", { from: "MCP/m.png", to: "Notes/a.png" }), /already exists: Notes\/a.png\. Pass overwrite=true/);
        assert.match(await call("move_attachment", { from: "MCP/m.png", to: "Notes/a.png", overwrite: true }), /^Moved/);
        assert.match(await call("delete_attachment", { path: "Notes/a.png" }), /Notes\/ allows only create\+update, so 'Notes\/a.png' can't be deleted or moved/);
        assert.match(await call("move_attachment", { from: "Notes/a.png", to: "MCP/a.png" }), /can't be deleted or moved/);
        assert.equal(files.get("Notes/a.png")?.data.byteLength, 3);
    });

    it("delete-only: delete and move out work; nothing can be written there", async () => {
        const { call, put, files } = scoped("MCP,Trash:delete");
        put("Trash/a.png", 1);
        put("Trash/b.png", 1);
        put("MCP/m.png", 1);
        assert.equal(await call("write_attachment", { path: "Trash/c.png", content_base64: one }), "Write access denied: Trash/ allows only delete, so 'Trash/c.png' can't be created.");
        assert.match(await call("create_attachment_upload", { path: "Trash/c.png" }), /can't be created/);
        assert.match(await call("move_attachment", { from: "MCP/m.png", to: "Trash/m.png" }), /'Trash\/m.png' can't be created/);
        assert.match(await call("move_attachment", { from: "Trash/a.png", to: "MCP/a.png" }), /^Moved/);
        assert.match(await call("delete_attachment", { path: "Trash/b.png" }), /^Deleted: Trash\/b.png/);
        assert.deepEqual([...files.keys()].sort(), ["MCP/a.png", "MCP/m.png"]);
    });

    it("update-only: no new files", async () => {
        const { call } = scoped("Live:update");
        assert.equal(await call("write_attachment", { path: "Live/a.png", content_base64: one }), "Write access denied: Live/ allows only update, so 'Live/a.png' can't be created.");
        assert.match(await call("create_attachment_upload", { path: "Live/a.png" }), /can't be created/);
    });

    it("root rule '/' and the most specific folder", async () => {
        const { call, put } = scoped("/:create,Raw/scratch");
        put("a.png", 1);
        assert.match(await call("write_attachment", { path: "b.png", content_base64: one }), /^Attachment saved/);
        assert.match(await call("write_attachment", { path: "a.png", content_base64: one, overwrite: true }), /^Write access denied: \/ allows only create, so 'a.png' can't be changed/);
        assert.match(await call("delete_attachment", { path: "a.png" }), /can't be deleted or moved/);
        put("Raw/scratch/s.png", 1);
        assert.match(await call("write_attachment", { path: "Raw/scratch/s.png", content_base64: two, overwrite: true }), /^Attachment saved/);
        assert.match(await call("move_attachment", { from: "Raw/scratch/s.png", to: "Raw/s.png" }), /^Moved/);
        assert.match(await call("delete_attachment", { path: "Raw/s.png" }), /\/ allows only create/);
    });

    it("case variants of a create-only folder get create only", async () => {
        const { call, put } = scoped("/,Raw:create");
        put("raw/a.png", 1);
        assert.match(await call("write_attachment", { path: "raw/new.png", content_base64: one }), /^Attachment saved/);
        assert.match(await call("write_attachment", { path: "raw/a.png", content_base64: one, overwrite: true }), /Raw\/ allows only create, so 'raw\/a.png' can't be changed/);
        assert.match(await call("delete_attachment", { path: "RAW/a.png" }), /can't be deleted or moved/);
        assert.match(await call("create_attachment_upload", { path: "rAw/x.png", overwrite: true }), /can't be changed/);
    });

    it("move_attachment: source refusal before destination, each named", async () => {
        const { call } = scoped("MCP");
        assert.match(await call("move_attachment", { from: "Other/a.png", to: "Else/a.png" }), /^Write access denied: 'Other\/a.png' is outside/);
        assert.match(await call("move_attachment", { from: "MCP/a.png", to: "Else/a.png" }), /^Write access denied: 'Else\/a.png' is outside/);
    });

    it("path validation is reported before the permission check", async () => {
        const { call } = scoped("Raw:create");
        assert.match(await call("write_attachment", { path: "Raw/a.md", content_base64: one, overwrite: true }), /Invalid attachment path/);
        assert.match(await call("delete_attachment", { path: "Raw/a.md" }), /Invalid attachment path/);
    });

    it("descriptions on every write tool carry the scope and legend", () => {
        const { tools } = scoped("/,Raw:create");
        for (const name of ["create_attachment_upload", "write_attachment", "delete_attachment", "move_attachment"]) {
            const t = tools.find((x) => x.name === name)!;
            assert.ok(t.description.endsWith(" Writes are only allowed inside: /, Raw/ (create only). create = add new files, update = change existing files, delete = delete or move files away; the most specific folder applies."), name);
        }
    });
});

describe("upload URL flow under WRITE_FOLDERS (tool + PUT route)", () => {
    function flow(raw: string) {
        const ctx = setup({ writeFolders: parseWriteFolders(raw) });
        const app = new Hono();
        mountAttachmentUpload(app, { registry: ctx.registry, vault: ctx.vault });
        const urlOf = (out: string) => {
            const m = out.match(/https:\/\/mcp\.example\.com(\/attachments\/upload\/[A-Za-z0-9_-]+)/);
            assert.ok(m, out);
            return m[1];
        };
        const putTo = (route: string, body: Uint8Array) => app.request(route, { method: "PUT", body: body as BodyInit });
        return { ...ctx, urlOf, putTo };
    }

    it("create-only: a new file uploads; a second URL for it is refused once it exists", async () => {
        const { call, files, urlOf, putTo } = flow("MCP,Raw:create");
        const first = urlOf(await call("create_attachment_upload", { path: "Raw/a.png" }));
        const second = urlOf(await call("create_attachment_upload", { path: "Raw/a.png" }));
        assert.equal((await putTo(first, new Uint8Array([1]))).status, 201);
        assert.equal(await call("create_attachment_upload", { path: "Raw/a.png" }), "Attachment already exists: Raw/a.png. Choose another path.");
        // A URL minted before the file existed can't replace it: overwrite is rechecked at write time.
        const late = await putTo(second, new Uint8Array([2]));
        assert.equal(late.status, 409);
        assert.deepEqual(await late.json(), { error: "Attachment already exists: Raw/a.png" });
        assert.deepEqual(files.get("Raw/a.png")?.data, new Uint8Array([1]));
    });

    it("create-only: concurrent uploads to one new path — one 201, one 409", async () => {
        const { call, files, urlOf, putTo } = flow("Raw:create");
        const urls = [urlOf(await call("create_attachment_upload", { path: "Raw/r.png" })), urlOf(await call("create_attachment_upload", { path: "Raw/r.png" }))];
        const statuses = (await Promise.all(urls.map((u, i) => putTo(u, new Uint8Array([i + 1]))))).map((r) => r.status).sort();
        assert.deepEqual(statuses, [201, 409]);
        assert.equal(files.get("Raw/r.png")?.data.byteLength, 1);
    });

    it("create-only: overwrite is refused when the URL is created, so nothing is minted", async () => {
        const { call, registry } = flow("Raw:create");
        assert.match(await call("create_attachment_upload", { path: "Raw/a.png", overwrite: true }), /can't be changed/);
        assert.equal(registry.pending, 0);
    });

    it("create+update: an overwrite URL replaces the file", async () => {
        const { call, files, put, urlOf, putTo } = flow("Notes:create+update");
        put("Notes/a.png", 1);
        const url = urlOf(await call("create_attachment_upload", { path: "Notes/a.png", overwrite: true }));
        assert.equal((await putTo(url, new Uint8Array([7, 7]))).status, 201);
        assert.deepEqual(files.get("Notes/a.png")?.data, new Uint8Array([7, 7]));
    });

    it("outside the folders: refused, nothing minted", async () => {
        const { call, registry } = flow("Raw:create");
        assert.equal(await call("create_attachment_upload", { path: "Other/a.png" }), "Write access denied: 'Other/a.png' is outside the writable folders (Raw/ (create only)).");
        assert.equal(registry.pending, 0);
    });
});
