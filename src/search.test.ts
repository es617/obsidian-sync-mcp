import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SearchIndex, snippetAround } from "./search.js";

let tmpDir: string;

before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "search-test-"));
});

after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

describe("SearchIndex", () => {
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

describe("SearchIndex persistence", () => {
    it("saves and loads mtimes and tags from disk", async () => {
        const path = join(tmpDir, "index.json");

        const idx1 = new SearchIndex(path);
        idx1.update("note1.md", "---\ntags: [foo]\n---\nHello world", 100);
        idx1.update("note2.md", "Goodbye world, see [[note1]]", 200);
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

        // Backlinks survive persistence
        assert.deepEqual(idx2.getBacklinks("note1.md"), ["note2.md"]);

        // Metadata survives persistence (no FlexSearch)
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

describe("SearchIndex content search (search_notes)", () => {
    function seeded(): SearchIndex {
        const idx = new SearchIndex();
        idx.update("marvin/labels.md", "---\ntags: [marvin]\n---\nEn kategori får sin label bara genom drag i appens Kanban-vy.", 200);
        idx.update("uppdrag/fix.md", "Labels på kategori sätts via update_category_or_project.\nKanban nämns också.", 300);
        idx.update("daily/plain.md", "Nothing of interest here.", 100);
        idx.update("notes/attachment.txt", "kanban in a non-markdown file", 400);
        return idx;
    }

    it("keeps content per path and drops it on remove", () => {
        const idx = seeded();
        assert.equal(idx.contentCount, 4);
        assert.equal(idx.getContent("daily/plain.md"), "Nothing of interest here.");
        idx.remove("daily/plain.md");
        assert.equal(idx.contentCount, 3);
        assert.equal(idx.getContent("daily/plain.md"), null);
    });

    it("terms are OR-combined, case-insensitive, ranked by distinct terms matched", () => {
        const { hits, total } = seeded().search({ terms: ["KANBAN", "labels på kategori"] });
        assert.equal(total, 2);
        assert.equal(hits[0].path, "uppdrag/fix.md");
        assert.equal(hits[0].matched, 2);
        assert.equal(hits[1].path, "marvin/labels.md");
        assert.equal(hits[1].matched, 1);
    });

    it("a term may contain spaces and matches a phrase in another word order only if present", () => {
        const { total } = seeded().search({ terms: ["drag i kanban"] });
        assert.equal(total, 0, "phrase with different word order does not match");
        assert.equal(seeded().search({ terms: ["drag i appens kanban"] }).total, 1);
    });

    it("term matching is case-insensitive for non-ASCII letters", () => {
        const { hits } = seeded().search({ terms: ["KATEGORI FÅR"] });
        assert.deepEqual(hits.map((h) => h.path), ["marvin/labels.md"]);
    });

    it("only markdown notes are searched", () => {
        const { hits } = seeded().search({ terms: ["non-markdown"] });
        assert.equal(hits.length, 0);
    });

    it("filters by folder, tag and modifiedAfter", () => {
        assert.deepEqual(seeded().search({ terms: ["kanban"], folder: "uppdrag" }).hits.map((h) => h.path), ["uppdrag/fix.md"]);
        assert.deepEqual(seeded().search({ terms: ["kanban"], tag: "marvin" }).hits.map((h) => h.path), ["marvin/labels.md"]);
        assert.deepEqual(seeded().search({ terms: ["kanban"], modifiedAfter: 250 }).hits.map((h) => h.path), ["uppdrag/fix.md"]);
    });

    it("limits hits but reports the total", () => {
        const { hits, total } = seeded().search({ terms: ["kanban"], limit: 1 });
        assert.equal(hits.length, 1);
        assert.equal(total, 2);
    });

    it("snippet is one collapsed line around the first match", () => {
        const { hits } = seeded().search({ terms: ["update_category"] });
        assert.equal(hits[0].snippet, "Labels på kategori sätts via update_category_or_project. Kanban nämns också.");
        assert.ok(!hits[0].snippet.includes("\n"));
    });

    it("snippetAround marks cut ends with an ellipsis", () => {
        const text = "a".repeat(200) + "MATCH" + "b".repeat(200);
        const s = snippetAround(text, 200, 5, 10);
        assert.equal(s, "…" + "a".repeat(10) + "MATCH" + "b".repeat(10) + "…");
    });

    it("state starts building and clear() resets it", () => {
        const idx = new SearchIndex();
        assert.equal(idx.state, "building");
        idx.state = "ready";
        idx.update("a.md", "x");
        idx.clear();
        assert.equal(idx.state, "building");
        assert.equal(idx.contentCount, 0);
    });
    it("searches path and frontmatter title first and ranks such hits on top", () => {
        const idx = seeded();
        idx.update("MCP TEST/MCP TEST.md", "2026-09-20 16:02", 50);
        idx.update("notes/titled.md", "---\ntitle: Kanban board setup\n---\nBody without the word.", 60);
        const { hits, total } = idx.search({ terms: ["kanban"] });
        assert.equal(total, 3);
        assert.ok(hits[0].nameHit, "name hit first");
        assert.ok(!hits[1].nameHit && !hits[2].nameHit, "content-only hits after");
        // marvin/labels.md matches "kanban" only in its body; the title hit and the path-free body hit are ranked by nameHit
        assert.equal(hits[0].path, "notes/titled.md");
        assert.ok(hits[0].snippet.includes("Kanban board setup"), "the title sits in the frontmatter, so the content snippet shows it");
        const byPath = idx.search({ terms: ["mcp test"] });
        assert.equal(byPath.total, 1);
        assert.equal(byPath.hits[0].path, "MCP TEST/MCP TEST.md");
        assert.equal(byPath.hits[0].nameHit, true);
        assert.equal(byPath.hits[0].snippet, "", "name-only hit carries no content snippet");
        const titled = idx.search({ terms: ["board setup"] });
        assert.equal(titled.hits[0].path, "notes/titled.md");
        assert.equal(titled.hits[0].nameHit, true);
    });

    it("a term is applied to path/title as well", () => {
        const idx = seeded();
        idx.update("MCP TEST/MCP TEST.md", "nothing", 50);
        const { hits } = idx.search({ terms: ["mcp test/"] });
        assert.deepEqual(hits.map((h) => h.path), ["MCP TEST/MCP TEST.md"]);
        assert.equal(hits[0].nameHit, true);
    });

    it("a term counts once even when it hits both name and content", () => {
        const idx = new SearchIndex();
        idx.update("kanban/kanban.md", "kanban kanban", 1);
        const { hits } = idx.search({ terms: ["kanban"] });
        assert.equal(hits[0].matched, 1);
        assert.equal(hits[0].nameHit, true);
        assert.ok(hits[0].snippet.includes("kanban"));
    });
});
