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
        assert.equal(results[0].path, "hello.md");
        assert.ok(results[0].snippet.includes("quick brown"));
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

    it("includes snippet with context", () => {
        const padding = "x ".repeat(100);
        const idx = new SearchIndex();
        idx.update("note.md", `${padding}NEEDLE${padding}`);
        const results = idx.search("NEEDLE");
        assert.equal(results.length, 1);
        assert.ok(results[0].snippet.startsWith("..."));
        assert.ok(results[0].snippet.includes("NEEDLE"));
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
});

describe("SearchIndex persistence", () => {
    it("saves and loads from disk", async () => {
        const path = join(tmpDir, "index.json");

        // Create and save
        const idx1 = new SearchIndex(path);
        idx1.update("note1.md", "Hello world");
        idx1.update("note2.md", "Goodbye world");
        await idx1.saveToDisk();

        // Load into fresh instance
        const idx2 = new SearchIndex(path);
        const loaded = await idx2.loadFromDisk();
        assert.ok(loaded);
        assert.equal(idx2.size, 2);

        // Search works on loaded index
        const results = idx2.search("Hello");
        assert.equal(results.length, 1);
        assert.equal(results[0].path, "note1.md");
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
