import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalVault } from "./vault-local.js";

let tmpDir: string;
let vault: LocalVault;

before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-test-"));
    vault = new LocalVault(tmpDir);
});

after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

describe("safePath — path traversal prevention", () => {
    it("blocks ../ traversal", async () => {
        await assert.rejects(() => vault.readNote("../etc/passwd"), /Path traversal blocked/);
    });

    it("blocks ../../ traversal", async () => {
        await assert.rejects(() => vault.readNote("../../etc/shadow"), /Path traversal blocked/);
    });

    it("blocks write with traversal", async () => {
        await assert.rejects(() => vault.writeNote("../evil.md", "pwned"), /Path traversal blocked/);
    });

    it("blocks delete with traversal", async () => {
        await assert.rejects(() => vault.deleteNote("../../important.md"), /Path traversal blocked/);
    });

    it("allows nested paths within vault", async () => {
        await vault.writeNote("sub/dir/note.md", "ok");
        assert.equal(await vault.readNote("sub/dir/note.md"), "ok");
    });
});

describe("readNote / writeNote", () => {
    it("returns null for non-existent note", async () => {
        assert.equal(await vault.readNote("nope.md"), null);
    });

    it("writes and reads back a note", async () => {
        await vault.writeNote("hello.md", "# Hello");
        assert.equal(await vault.readNote("hello.md"), "# Hello");
    });

    it("creates intermediate directories", async () => {
        await vault.writeNote("a/b/c/deep.md", "deep");
        assert.equal(await vault.readNote("a/b/c/deep.md"), "deep");
    });

    it("overwrites existing note", async () => {
        await vault.writeNote("overwrite.md", "v1");
        await vault.writeNote("overwrite.md", "v2");
        assert.equal(await vault.readNote("overwrite.md"), "v2");
    });

    it("handles unicode content", async () => {
        const content = "# 日本語テスト\n\nEmoji: 🎉";
        await vault.writeNote("unicode.md", content);
        assert.equal(await vault.readNote("unicode.md"), content);
    });
});

describe("deleteNote", () => {
    it("deletes an existing note", async () => {
        await vault.writeNote("del.md", "x");
        assert.equal(await vault.deleteNote("del.md"), true);
        assert.equal(await vault.readNote("del.md"), null);
    });

    it("returns false for non-existent note", async () => {
        assert.equal(await vault.deleteNote("nope.md"), false);
    });
});

describe("listNotes", () => {
    before(async () => {
        // Create a known set of files
        await vault.writeNote("list/a.md", "a");
        await vault.writeNote("list/b.md", "b");
        await vault.writeNote("list/sub/c.md", "c");
        // Non-md file should be excluded
        const txtPath = join(tmpDir, "list", "ignore.txt");
        await writeFile(txtPath, "not a note");
    });

    it("lists all .md files recursively", async () => {
        const notes = await vault.listNotes("list/");
        assert.ok(notes.includes("list/a.md"));
        assert.ok(notes.includes("list/b.md"));
        assert.ok(notes.includes("list/sub/c.md"));
        assert.ok(!notes.some((n) => n.includes(".txt")));
    });

    it("filters by folder", async () => {
        const notes = await vault.listNotes("list/sub/");
        assert.deepEqual(notes, ["list/sub/c.md"]);
    });

    it("normalizes folder without trailing slash", async () => {
        const with_ = await vault.listNotes("list/");
        const without = await vault.listNotes("list");
        assert.deepEqual(with_, without);
    });

    it("returns empty array for non-existent folder", async () => {
        assert.deepEqual(await vault.listNotes("nonexistent/"), []);
    });

    it("returns sorted results", async () => {
        const notes = await vault.listNotes("list/");
        const sorted = [...notes].sort();
        assert.deepEqual(notes, sorted);
    });
});

describe("searchVault", () => {
    before(async () => {
        await vault.writeNote("search/fox.md", "The quick brown fox jumps over the lazy dog");
        await vault.writeNote("search/bar.md", "Nothing interesting here");
    });

    it("finds case-insensitive match", async () => {
        const results = await vault.searchVault("QUICK");
        assert.equal(results.length, 1);
        assert.equal(results[0].path, "search/fox.md");
        assert.ok(results[0].snippet.includes("quick brown fox"));
    });

    it("returns empty array when nothing matches", async () => {
        assert.deepEqual(await vault.searchVault("zzz_nonexistent_zzz"), []);
    });

    it("caps results at 50", async () => {
        // Create 60 notes containing "findme"
        const dir = "search/cap";
        for (let i = 0; i < 60; i++) {
            await vault.writeNote(`${dir}/${i}.md`, `findme content ${i}`);
        }
        const results = await vault.searchVault("findme");
        assert.equal(results.length, 50);
    });

    it("includes ... prefix for mid-content matches", async () => {
        const padding = "x".repeat(200);
        await vault.writeNote("search/long.md", `${padding}NEEDLE${padding}`);
        const results = await vault.searchVault("NEEDLE");
        const match = results.find((r) => r.path === "search/long.md");
        assert.ok(match);
        assert.ok(match!.snippet.startsWith("..."));
        assert.ok(match!.snippet.endsWith("..."));
    });
});
