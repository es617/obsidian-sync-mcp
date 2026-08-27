import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SearchBuildStatus } from "./search.js";
import { formatIndexStatusNotice } from "./tools.js";

function status(
    state: SearchBuildStatus["state"],
    processed = 0,
    total?: number,
): SearchBuildStatus {
    return { state, processed, total, notes: processed, chunks: processed };
}

describe("index-backed tool status notices", () => {
    it("is silent only when the index is ready", () => {
        assert.equal(formatIndexStatusNotice(status("ready")), "");
    });

    it("labels initial-build results and counts as incomplete", () => {
        const notice = formatIndexStatusNotice(status("building", 1, 4));
        assert.match(notice, /building \(25% complete\)/);
        assert.match(notice, /results, counts, and backlinks are incomplete/);
    });

    it("labels catch-up results as potentially missing recent changes", () => {
        const notice = formatIndexStatusNotice(status("catching_up", 12));
        assert.match(notice, /catching up \(12 changes processed\)/);
        assert.match(notice, /may omit recent changes/);
    });

    it("labels failed updates as stale or incomplete without exposing errors", () => {
        const failed = { ...status("error"), message: "/private/vault/path failed" };
        const notice = formatIndexStatusNotice(failed);
        assert.match(notice, /stale or incomplete/);
        assert.doesNotMatch(notice, /private|vault|path failed/);
    });
});
