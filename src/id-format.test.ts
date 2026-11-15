import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyIds, isNamespacedId } from "./id-format.js";

/**
 * Regression tests for the obfuscation mismatch behind issues #4 and #10:
 * a vault with "Obfuscate properties" enabled has `f:`-prefixed document IDs,
 * and the server must detect this rather than trust the configured flag.
 */

describe("classifyIds", () => {
    it("classifies f:-prefixed ids as obfuscated", () => {
        assert.equal(classifyIds(["f:abc123", "f:def456"]), "obfuscated");
    });

    it("classifies path-based ids as plain", () => {
        assert.equal(classifyIds(["inbox/тест.md", "daily/2026-07-21.md"]), "plain");
    });

    it("classifies a mix of both as mixed", () => {
        assert.equal(classifyIds(["f:abc123", "inbox/note.md"]), "mixed");
    });

    it("classifies no ids as empty", () => {
        assert.equal(classifyIds([]), "empty");
    });

    it("treats a path that merely contains f: as plain", () => {
        assert.equal(classifyIds(["notes/f: prefix study.md"]), "plain");
    });
});

describe("classifyIds — LiveSync namespaced file documents (#62)", () => {
    it("ignores obfuscated internal-file ids (i:f:...) instead of counting them as plain", () => {
        // The reporter's vault: the head of the feed is mostly i:f: docs, with one f: note.
        const ids = [...Array.from({ length: 19 }, (_, i) => `i:f:${i}`), "f:abc123"];
        assert.equal(classifyIds(ids), "obfuscated");
    });

    it("ignores plaintext namespaced ids on a plaintext vault", () => {
        assert.equal(classifyIds(["i:.obsidian/app.json", "ix:something", "ps:legacy", "notes/a.md"]), "plain");
    });

    it("a sample of only namespaced ids is empty", () => {
        assert.equal(classifyIds(["i:f:abc", "ix:f:def", "i:.obsidian/app.json"]), "empty");
    });

    it("isNamespacedId recognises the namespace prefixes only", () => {
        for (const id of ["i:f:abc", "ix:abc", "ps:abc"]) assert.ok(isNamespacedId(id), id);
        for (const id of ["f:abc", "inbox/i: notes.md", "notes/ps.md"]) assert.ok(!isNamespacedId(id), id);
    });
});
