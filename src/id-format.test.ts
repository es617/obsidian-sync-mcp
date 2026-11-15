import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyIds, isNamespacedId, ID_SAMPLE_MINIMUM } from "./id-format.js";

/**
 * Regression tests for the obfuscation mismatch behind issues #4 and #10:
 * a vault with "Obfuscate properties" enabled has `f:`-prefixed document IDs,
 * and the server must detect this rather than trust the configured flag —
 * without letting internal-file documents or a tiny sample flip it (#62).
 */

const many = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i));
const obf = (n: number) => many(n, (i) => `f:${i.toString(16).padStart(64, "0")}`);
const plain = (n: number) => many(n, (i) => `notes/note-${i}.md`);

describe("classifyIds", () => {
    it("classifies f:-prefixed ids as obfuscated", () => {
        assert.equal(classifyIds(obf(ID_SAMPLE_MINIMUM)), "obfuscated");
    });

    it("classifies path-based ids as plain", () => {
        assert.equal(classifyIds([...plain(ID_SAMPLE_MINIMUM - 2), "inbox/тест.md", "daily/2026-07-21.md"]), "plain");
    });

    it("classifies a mix of both as mixed", () => {
        assert.equal(classifyIds([...obf(30), "inbox/note.md"]), "mixed");
    });

    it("reports a mix as mixed even below the minimum", () => {
        assert.equal(classifyIds(["f:abc123", "inbox/note.md"]), "mixed");
    });

    it("classifies no ids as empty", () => {
        assert.equal(classifyIds([]), "empty");
    });

    it("treats a path that merely contains f: as plain", () => {
        assert.equal(classifyIds([...plain(ID_SAMPLE_MINIMUM - 1), "notes/f: prefix study.md"]), "plain");
    });

    it("is insufficient below the minimum, so the configured setting is kept", () => {
        assert.equal(classifyIds(obf(ID_SAMPLE_MINIMUM - 1)), "insufficient");
        assert.equal(classifyIds(plain(3)), "insufficient");
    });

    it("the lean of a small sample is available with minimum 1", () => {
        assert.equal(classifyIds(obf(3), 1), "obfuscated");
        assert.equal(classifyIds(plain(3), 1), "plain");
    });
});

describe("classifyIds — LiveSync internal-file documents (#62)", () => {
    it("ignores obfuscated internal-file ids (i:f:...) instead of counting them as plain", () => {
        // The reporter's vault: the head of the feed is mostly i:f: docs, with few f: notes.
        const ids = [...many(19, (i) => `i:f:${i.toString(16).padStart(64, "0")}`), ...obf(ID_SAMPLE_MINIMUM)];
        assert.equal(classifyIds(ids), "obfuscated");
    });

    it("ignores plaintext internal-file ids on a plaintext vault", () => {
        assert.equal(classifyIds(["i:.obsidian/app.json", "ix:something", "ps:legacy", ...plain(ID_SAMPLE_MINIMUM)]), "plain");
    });

    it("a sample of only internal-file ids is empty", () => {
        assert.equal(classifyIds(["i:f:abc", "i:.obsidian/app.json"]), "empty");
    });

    it("isNamespacedId recognises the namespace prefixes only", () => {
        assert.ok(isNamespacedId("i:f:abc"));
        assert.ok(isNamespacedId("ix:abc"));
        assert.ok(isNamespacedId("ps:abc"));
        assert.ok(!isNamespacedId("f:abc"));
        assert.ok(!isNamespacedId("inbox/i: notes.md"));
    });
});
