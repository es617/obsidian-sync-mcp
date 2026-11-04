import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    validateAttachmentPath,
    isValidAttachmentPath,
    parseAttachmentExtensions,
    attachmentExtension,
    SUPPORTED_ATTACHMENT_EXTENSIONS,
} from "./attachment-path.js";

describe("validateAttachmentPath", () => {
    it("accepts supported media files", () => {
        for (const p of ["a.png", "Attachments/screenshot.PNG", "docs/2026/report.pdf", "audio/memo.m4a", "x/y/z.webm"]) {
            assert.doesNotThrow(() => validateAttachmentPath(p), p);
        }
    });

    it("rejects notes and text-like or executable formats", () => {
        for (const p of ["a.md", "a.svg", "a.html", "plugin.js", "data.json", "style.css", "board.canvas", "notes.txt", "noext", "x.png.md"]) {
            assert.equal(isValidAttachmentPath(p), false, p);
        }
    });

    it("applies the same shape rules as notes", () => {
        for (const p of ["", "/abs.png", "../up.png", "a/../b.png", "a:b.png", "ix:x.png", ".obsidian/x.png", "a/.hidden/x.png", ".png", "a//b.png", "nul\0.png"]) {
            assert.equal(isValidAttachmentPath(p), false, JSON.stringify(p));
        }
    });

    it("honours a narrowed allowlist", () => {
        const allowed = new Set(["png"]);
        assert.doesNotThrow(() => validateAttachmentPath("a.png", allowed));
        assert.throws(() => validateAttachmentPath("a.pdf", allowed), /extension must be one of png/);
    });
});

describe("attachmentExtension", () => {
    it("returns the lowercased last extension", () => {
        assert.equal(attachmentExtension("A/B.JPG"), "jpg");
        assert.equal(attachmentExtension("a.tar.gz"), "gz");
        assert.equal(attachmentExtension("noext"), "");
        assert.equal(attachmentExtension("dir.png/file"), "");
    });
});

describe("parseAttachmentExtensions", () => {
    it("defaults to every supported extension", () => {
        assert.deepEqual([...parseAttachmentExtensions(undefined)].sort(), [...SUPPORTED_ATTACHMENT_EXTENSIONS].sort());
        assert.equal(parseAttachmentExtensions("  ").size, SUPPORTED_ATTACHMENT_EXTENSIONS.length);
    });

    it("narrows, normalising case and leading dots", () => {
        assert.deepEqual([...parseAttachmentExtensions(" PNG, .jpg ,pdf,")].sort(), ["jpg", "pdf", "png"]);
    });

    it("refuses to widen the list", () => {
        assert.throws(() => parseAttachmentExtensions("png,svg,md"), /unsupported extensions: svg, md/);
    });
});
