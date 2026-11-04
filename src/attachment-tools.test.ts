import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerAttachmentTools, decodeBase64Strict, formatBytes, type AttachmentToolOptions } from "./attachment-tools.js";
import { UploadRegistry, UPLOAD_ROUTE_PREFIX } from "./uploads.js";
import { memoryAttachments } from "./attachment-test-fixtures.js";
import { SUPPORTED_ATTACHMENT_EXTENSIONS } from "./attachment-path.js";
import { SearchIndex } from "./search.js";

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
    return { tools, files, registry, call, embed, put, searchIndex };
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
        const { call, files } = setup({ writeFolders: ["MCP"], allowedExtensions: new Set(["png"]) });
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
        const { call, files } = setup({ writeFolders: ["MCP"] });
        files.set("x.png", { data: new Uint8Array(1), ctime: 1, mtime: 1 });
        assert.match(await call("delete_attachment", { path: "x.png" }), /Write access denied/);
        assert.equal(files.size, 1);
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
