import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { planFilesystemIndexSync, SearchIndex } from "./search.js";
import { FullTextIndex } from "./full-text-search.js";

let tmpDir: string;

before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "search-test-"));
});

after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

describe("SearchIndex", () => {
    it("plans local startup reads only for new or mtime-changed notes", () => {
        const plan = planFilesystemIndexSync(
            [
                { path: "unchanged.md", mtime: 100 },
                { path: "same-content-new-mtime.md", mtime: 100 },
                { path: "deleted.md", mtime: 50 },
            ],
            [
                { path: "unchanged.md", mtime: 100 },
                { path: "same-content-new-mtime.md", mtime: 200 },
                { path: "new.md", mtime: 300 },
            ],
        );
        assert.deepEqual(plan, {
            remove: ["deleted.md"],
            read: [
                { path: "same-content-new-mtime.md", mtime: 200 },
                { path: "new.md", mtime: 300 },
            ],
            unchanged: 1,
        });
    });

    it("removes every persisted note when the local vault becomes empty", () => {
        assert.deepEqual(planFilesystemIndexSync([
            { path: "a.md", mtime: 1 },
            { path: "b.md", mtime: 2 },
        ], []), {
            remove: ["a.md", "b.md"],
            read: [],
            unchanged: 0,
        });
    });

    it("routes metadata updates and deletes into the full-text index", async () => {
        const fullText = await FullTextIndex.open(":memory:");
        const idx = new SearchIndex(fullText);
        try {
            idx.update("note.md", "provider recovery evidence", 100);
            assert.deepEqual(
                idx.searchNotes({ query: "provider" }).map((result) => result.path),
                ["note.md"],
            );
            idx.remove("note.md");
            assert.equal(idx.searchNotes({ query: "provider" }).length, 0);
        } finally {
            idx.close();
        }
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

    it("extracts outgoing links", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "See [[b]] and [[folder/c]]", 100);
        assert.deepEqual(idx.getLinks("a.md"), ["b", "folder/c"]);
    });

    it("builds backlinks from wikilinks", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[b]]", 100);
        idx.update("c.md", "Also links to [[b]]", 200);
        const backlinks = idx.getBacklinks("b.md");
        assert.ok(backlinks.includes("a.md"));
        assert.ok(backlinks.includes("c.md"));
    });

    it("matches backlinks by filename without extension", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[Project X]]", 100);
        const backlinks = idx.getBacklinks("Project X.md");
        assert.deepEqual(backlinks, ["a.md"]);
    });

    it("matches backlinks by full path", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[projects/todo]]", 100);
        const backlinks = idx.getBacklinks("projects/todo.md");
        assert.deepEqual(backlinks, ["a.md"]);
    });

    it("clears backlinks when source is removed", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[b]]", 100);
        assert.deepEqual(idx.getBacklinks("b.md"), ["a.md"]);
        idx.remove("a.md");
        assert.deepEqual(idx.getBacklinks("b.md"), []);
    });

    it("matches backlinks case-insensitively", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[welcome]]", 100);
        const backlinks = idx.getBacklinks("Welcome.md");
        assert.deepEqual(backlinks, ["a.md"]);
    });

    it("updates backlinks when source content changes", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[b]]", 100);
        assert.deepEqual(idx.getBacklinks("b.md"), ["a.md"]);
        idx.update("a.md", "Now links to [[c]]", 200);
        assert.deepEqual(idx.getBacklinks("b.md"), []);
        assert.deepEqual(idx.getBacklinks("c.md"), ["a.md"]);
    });
});

describe("SearchIndex SQLite persistence", () => {
    it("persists metadata, links, and the checkpoint in the search database", async () => {
        const path = join(tmpDir, "index.sqlite");
        const firstDb = await FullTextIndex.open(path);
        const idx1 = new SearchIndex(firstDb);
        idx1.update("note1.md", "---\ntags: [foo]\n---\nHello world", 100);
        idx1.update("note2.md", "Goodbye world, see [[note1]]", 200);
        idx1.since = "checkpoint-42";
        idx1.close();

        const secondDb = await FullTextIndex.open(path);
        const idx2 = new SearchIndex(secondDb);
        assert.equal(idx2.size, 2);

        const notes = idx2.listWithMtime();
        assert.equal(notes.length, 2);
        assert.ok(notes.some((n) => n.path === "note1.md" && n.mtime === 100));
        assert.ok(notes.some((n) => n.path === "note2.md" && n.mtime === 200));

        assert.deepEqual(idx2.getTags("note1.md"), ["foo"]);
        assert.deepEqual(idx2.getTags("note2.md"), []);

        // Backlinks survive persistence
        assert.deepEqual(idx2.getBacklinks("note1.md"), ["note2.md"]);
        assert.equal(idx2.since, "checkpoint-42");
        idx2.close();
    });

    it("reports build progress with current note and chunk counts", async () => {
        const db = await FullTextIndex.open(":memory:");
        const idx = new SearchIndex(db);
        idx.update("note.md", "# Heading\n\nBody", 1);
        idx.setBuildStatus("building", 1, 4);
        assert.deepEqual(idx.status, {
            state: "building",
            processed: 1,
            total: 4,
            message: undefined,
            notes: 1,
            chunks: 1,
        });
        idx.close();
    });
});
