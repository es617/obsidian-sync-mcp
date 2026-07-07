import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { deriveContent, applyIndexChange, type IndexTarget } from "./index-sync.js";

/**
 * Regression tests for zero-byte notes being dropped from the search index
 * (issues #5 cold-start and #6 list_notes). A deleted note must be removed; an
 * empty-but-present note must be indexed. The old `if (content)` truthiness
 * check conflated the two and dropped empty notes.
 */

// Minimal stand-in for SearchIndex.
class FakeIndex implements IndexTarget {
    private paths = new Set<string>();
    update(path: string) { this.paths.add(path); }
    remove(path: string) { this.paths.delete(path); }
    has(path: string) { return this.paths.has(path); }
    get size() { return this.paths.size; }
}

describe("deriveContent — delete vs empty", () => {
    it("returns null for a deleted note", () => {
        assert.equal(deriveContent({ deleted: true, data: [""] }), null);
    });
    it("returns '' for an existing empty note (data: [])", () => {
        assert.equal(deriveContent({ data: [] }), "");
    });
    it("returns '' for an existing note with no data array", () => {
        assert.equal(deriveContent({}), "");
    });
    it("returns the joined body for a normal note", () => {
        assert.equal(deriveContent({ data: ["# Title\n", "body"] }), "# Title\nbody");
    });
});

describe("applyIndexChange — routing", () => {
    let index: FakeIndex;
    beforeEach(() => { index = new FakeIndex(); });

    it("indexes an empty note instead of dropping it", () => {
        applyIndexChange(index, "empty.md", "");
        assert.ok(index.has("empty.md"), "empty note should be indexed");
    });

    it("removes a note on delete (null content)", () => {
        applyIndexChange(index, "gone.md", "seed"); // present first
        applyIndexChange(index, "gone.md", null);
        assert.ok(!index.has("gone.md"), "deleted note should be removed");
    });

    it("indexes a normal note", () => {
        applyIndexChange(index, "note.md", "text");
        assert.ok(index.has("note.md"));
    });

    it("reproduces issue #5: 1 content note + 3 empty notes all index", () => {
        // End-to-end of the cold-start routing over a mixed batch.
        const changes: Array<[string, string | null]> = [
            ["alpha.md", "# Alpha\ncontent"],
            ["beta.md", ""],
            ["gamma.md", ""],
            ["delta.md", ""],
        ];
        for (const [path, content] of changes) applyIndexChange(index, path, content);
        assert.equal(index.size, 4, `expected all 4 notes indexed, got ${index.size}`);
    });
});
