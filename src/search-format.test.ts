import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeHits, describeQuery, describeSync, formatServerTime, seqPrefix, type SyncStatus } from "./search-format.js";

/**
 * The index-status line is what a client uses to judge whether a hit can be
 * trusted as current, so its wording is pinned here against fixed instants.
 */

const JAN = Date.parse("2026-01-15T12:00:00Z");
const JUL = Date.parse("2026-07-15T12:00:00Z");

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
    return {
        mode: "couchdb",
        state: "ready",
        seq: "39995-g1AAAACReJzLYWBgYMpgTmHg",
        syncedAt: JUL,
        now: JUL,
        notes: 358,
        withContent: 358,
        unreadable: 0,
        ...overrides,
    };
}

describe("formatServerTime", () => {
    it("prints local zone and UTC side by side, CET in winter", () => {
        assert.equal(formatServerTime(JAN, "Europe/Stockholm"), "2026-01-15 13:00 CET (12:00Z)");
    });
    it("prints CEST in summer", () => {
        assert.equal(formatServerTime(JUL, "Europe/Stockholm"), "2026-07-15 14:00 CEST (12:00Z)");
    });
    it("uses 00 not 24 at midnight", () => {
        const midnight = Date.parse("2026-07-15T22:00:00Z");
        assert.equal(formatServerTime(midnight, "Europe/Stockholm"), "2026-07-16 00:00 CEST (22:00Z)");
    });
});

describe("seqPrefix", () => {
    it("keeps the numeric prefix of a CouchDB sequence", () => {
        assert.equal(seqPrefix("39995-g1AAAACReJzLYWBg"), "39995");
        assert.equal(seqPrefix("12"), "12");
        assert.equal(seqPrefix(""), "none");
    });
});

describe("describeSync", () => {
    it("ready: sequence, time, age, coverage", () => {
        assert.equal(
            describeSync(status()),
            "Index caught up with CouchDB seq 39995 — 2026-07-15 14:00 CEST (12:00Z), 0 min; 358 of 358 notes with content.",
        );
    });
    it("ready: names documents that could not be read", () => {
        assert.match(describeSync(status({ unreadable: 2 })), /; 2 documents could not be read\.$/);
        assert.match(describeSync(status({ unreadable: 1 })), /; 1 document could not be read\.$/);
    });
    it("ready: shows partial content coverage rather than hiding it", () => {
        assert.match(describeSync(status({ withContent: 300 })), /300 of 358 notes with content/);
    });
    it("ready: age counts minutes since the sequence last advanced", () => {
        assert.match(describeSync(status({ syncedAt: JUL - 7 * 60_000 })), /, 7 min;/);
    });
    it("building: says not caught up", () => {
        const line = describeSync(status({ state: "building", notes: 57, withContent: 57 }));
        assert.match(line, /^Index: still building \(57 notes so far\), not caught up — 2026-07-15 14:00 CEST \(12:00Z\); results may be incomplete\.$/);
    });
    it("failed: says not caught up", () => {
        assert.match(describeSync(status({ state: "failed" })), /^Index: rebuild failed at startup .* not caught up/);
    });
    it("catch-up error: keeps the last sequence and its age, flags staleness", () => {
        const line = describeSync(status({ error: "socket hang up", syncedAt: JUL - 3 * 60_000 }));
        assert.equal(
            line,
            "Index: catch-up failed (socket hang up); last caught up with CouchDB seq 39995 — 2026-07-15 13:57 CEST (11:57Z), 3 min ago; results may be stale.",
        );
    });
    it("local vault: no sequence, coverage stated", () => {
        assert.equal(
            describeSync(status({ mode: "local", notes: 3, withContent: 3 })),
            "Index: local vault, no sequence — 2026-07-15 14:00 CEST (12:00Z); 3 of 3 notes with content.",
        );
    });
});

describe("describeQuery / describeHits", () => {
    const link = (p: string) => `obsidian://open?vault=V&file=${encodeURIComponent(p)}`;
    it("quotes terms", () => {
        assert.equal(describeQuery(["drag i kanban", "kanban"]), '"drag i kanban", "kanban"');
    });
    it("zero hits say what was searched", () => {
        assert.equal(describeHits([], 0, '"x"', link), 'No notes match "x".');
    });
    it("hits: header, path line with deep link, indented snippet, never the body", () => {
        const text = describeHits(
            [{ path: "a/b.md", mtime: JUL, matched: 2, nameHit: false, snippet: "…around the match…" }],
            1,
            '"x"',
            link,
        );
        const lines = text.split("\n");
        assert.equal(lines[0], '1 note matches "x". Call read_note on a hit before relying on it.');
        assert.equal(lines[1], "- 2026-07-15T12:00 [a/b.md](obsidian://open?vault=V&file=a%2Fb.md)");
        assert.equal(lines[2], "  …around the match…");
    });
    it("says when the limit cut hits", () => {
        const text = describeHits(
            [{ path: "a.md", mtime: 0, matched: 1, nameHit: false, snippet: "s" }],
            21,
            '"x"',
            link,
        );
        assert.match(text, /^21 notes match "x" \(showing 1; narrow with folder, tag or modified_after\)\./);
    });
    it("marks hits by path or title and counts them in the header", () => {
        const text = describeHits(
            [
                { path: "MCP TEST/MCP TEST.md", mtime: 0, matched: 1, nameHit: true, snippet: "" },
                { path: "a.md", mtime: 0, matched: 1, nameHit: true, snippet: "body says MCP TEST too" },
                { path: "b.md", mtime: 0, matched: 1, nameHit: false, snippet: "only the body" },
            ],
            3,
            '"mcp test"',
            link,
        );
        const lines = text.split("\n");
        assert.equal(lines[0], '3 notes match "mcp test". 2 hits by path or title listed first. Call read_note on a hit before relying on it.');
        assert.equal(lines[2], "  [path/title match]");
        assert.equal(lines[4], "  [path/title] body says MCP TEST too");
        assert.equal(lines[6], "  only the body");
    });
});
