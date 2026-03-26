import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SearchIndex } from "./search.js";

let tmpDir: string;

before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "search-test-"));
});

after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

describe("SearchIndex", () => {
    it("indexes and searches notes", () => {
        const idx = new SearchIndex();
        idx.update("hello.md", "The quick brown fox jumps over the lazy dog");
        idx.update("world.md", "Lorem ipsum dolor sit amet");

        const results = idx.search("quick brown");
        assert.equal(results.length, 1);
        assert.equal(results[0], "hello.md");
    });

    it("returns empty for no match", () => {
        const idx = new SearchIndex();
        idx.update("note.md", "Some content here");
        assert.deepEqual(idx.search("nonexistent_xyz"), []);
    });

    it("updates existing note", () => {
        const idx = new SearchIndex();
        idx.update("note.md", "old content with keyword alpha");
        idx.update("note.md", "new content with keyword beta");

        assert.equal(idx.search("alpha").length, 0);
        assert.equal(idx.search("beta").length, 1);
    });

    it("removes a note", () => {
        const idx = new SearchIndex();
        idx.update("note.md", "searchable content");
        idx.remove("note.md");
        assert.deepEqual(idx.search("searchable"), []);
        assert.equal(idx.size, 0);
    });

    it("caps results at 50", () => {
        const idx = new SearchIndex();
        for (let i = 0; i < 100; i++) {
            idx.update(`note-${i}.md`, `findme content number ${i}`);
        }
        const results = idx.search("findme");
        assert.ok(results.length <= 50);
    });

    it("tracks size correctly", () => {
        const idx = new SearchIndex();
        assert.equal(idx.size, 0);
        idx.update("a.md", "content");
        assert.equal(idx.size, 1);
        idx.update("b.md", "content");
        assert.equal(idx.size, 2);
        idx.remove("a.md");
        assert.equal(idx.size, 1);
    });

    it("stores and retrieves mtimes", () => {
        const idx = new SearchIndex();
        idx.update("note.md", "content", 1234567890);
        const notes = idx.listWithMtime();
        assert.equal(notes.length, 1);
        assert.equal(notes[0].mtime, 1234567890);
    });

    it("extracts and retrieves tags from content", () => {
        const idx = new SearchIndex();
        idx.update("tagged.md", "---\ntags: [project, urgent]\n---\n\nSome #inline content", 100);
        const tags = idx.getTags("tagged.md");
        assert.ok(tags.includes("project"));
        assert.ok(tags.includes("urgent"));
        assert.ok(tags.includes("inline"));
    });

    it("lists all tags with counts", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "---\ntags: [project, urgent]\n---\n", 100);
        idx.update("b.md", "---\ntags: [project]\n---\n", 200);
        idx.update("c.md", "No tags here", 300);
        const allTags = idx.listAllTags();
        assert.equal(allTags[0].tag, "project");
        assert.equal(allTags[0].count, 2);
        assert.equal(allTags[1].tag, "urgent");
        assert.equal(allTags[1].count, 1);
    });

    it("clears tags on remove", () => {
        const idx = new SearchIndex();
        idx.update("tagged.md", "---\ntags: [foo]\n---\n", 100);
        assert.deepEqual(idx.getTags("tagged.md"), ["foo"]);
        idx.remove("tagged.md");
        assert.deepEqual(idx.getTags("tagged.md"), []);
    });

    it("updates tags when content changes", () => {
        const idx = new SearchIndex();
        idx.update("note.md", "---\ntags: [old]\n---\n", 100);
        assert.deepEqual(idx.getTags("note.md"), ["old"]);
        idx.update("note.md", "---\ntags: [new]\n---\n", 200);
        assert.deepEqual(idx.getTags("note.md"), ["new"]);
    });
});

describe("SearchIndex persistence", () => {
    it("saves and loads mtimes and tags from disk", async () => {
        const path = join(tmpDir, "index.json");

        const idx1 = new SearchIndex(path);
        idx1.update("note1.md", "---\ntags: [foo]\n---\nHello world", 100);
        idx1.update("note2.md", "Goodbye world", 200);
        await idx1.saveToDisk();

        const idx2 = new SearchIndex(path);
        const loaded = await idx2.loadFromDisk();
        assert.ok(loaded);
        assert.equal(idx2.size, 2);

        const notes = idx2.listWithMtime();
        assert.equal(notes.length, 2);
        assert.ok(notes.some((n) => n.path === "note1.md" && n.mtime === 100));
        assert.ok(notes.some((n) => n.path === "note2.md" && n.mtime === 200));

        assert.deepEqual(idx2.getTags("note1.md"), ["foo"]);
        assert.deepEqual(idx2.getTags("note2.md"), []);
    });

    it("saves and loads encrypted when passphrase set", async () => {
        const path = join(tmpDir, "encrypted-index.json");

        const idx1 = new SearchIndex(path, "mypassphrase");
        idx1.update("secret.md", "classified content", 999);
        await idx1.saveToDisk();

        // Verify file is not plaintext
        const { readFile } = await import("fs/promises");
        const raw = await readFile(path, "utf-8");
        assert.ok(!raw.includes("secret.md"));
        assert.ok(!raw.includes("classified"));

        const idx2 = new SearchIndex(path, "mypassphrase");
        const loaded = await idx2.loadFromDisk();
        assert.ok(loaded);
        assert.equal(idx2.size, 1);
    });

    it("returns false when no persisted index exists", async () => {
        const idx = new SearchIndex(join(tmpDir, "nonexistent.json"));
        assert.equal(await idx.loadFromDisk(), false);
    });

    it("returns false when no persist path configured", async () => {
        const idx = new SearchIndex();
        assert.equal(await idx.loadFromDisk(), false);
    });
});
