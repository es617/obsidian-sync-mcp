import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, unlink, readFile } from "fs/promises";
import { watch } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";

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

    it("blocks listNotes with traversal", async () => {
        await assert.rejects(() => vault.listNotes("../../etc"), /Path traversal blocked/);
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

describe("moveNote", () => {
    it("moves a note to a new path", async () => {
        await vault.writeNote("move/src.md", "content");
        assert.equal(await vault.moveNote("move/src.md", "move/dest.md"), true);
        assert.equal(await vault.readNote("move/src.md"), null);
        assert.equal(await vault.readNote("move/dest.md"), "content");
    });

    it("moves across folders", async () => {
        await vault.writeNote("folder-a/note.md", "hello");
        assert.equal(await vault.moveNote("folder-a/note.md", "folder-b/note.md"), true);
        assert.equal(await vault.readNote("folder-b/note.md"), "hello");
    });

    it("returns false if source doesn't exist", async () => {
        assert.equal(await vault.moveNote("nope.md", "dest.md"), false);
    });
});

describe("getMetadata", () => {
    it("returns metadata for a note with frontmatter and tags", async () => {
        await vault.writeNote("meta/test.md", `---
title: Test
tags: [foo, bar]
---

# Hello #inline-tag

See [[Other Note]]
`);
        const meta = await vault.getMetadata("meta/test.md");
        assert.ok(meta);
        assert.equal(meta!.path, "meta/test.md");
        assert.ok(meta!.size > 0);
        assert.ok(meta!.ctime > 0);
        assert.ok(meta!.mtime > 0);
        assert.equal(meta!.frontmatter.title, "Test");
        assert.ok(meta!.tags.includes("foo"));
        assert.ok(meta!.tags.includes("bar"));
        assert.ok(meta!.tags.includes("inline-tag"));
        assert.ok(meta!.links.includes("Other Note"));
    });

    it("returns null for non-existent note", async () => {
        assert.equal(await vault.getMetadata("nope.md"), null);
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

describe("file watcher integration", () => {
    it("detects new file and updates search index", async () => {
        const watchDir = await mkdtemp(join(tmpdir(), "watch-test-"));
        const searchIndex = new SearchIndex();

        // Start watcher (same logic as main.ts)
        const watcher = watch(watchDir, { recursive: true }, async (_event, filename) => {
            if (!filename || !filename.endsWith(".md")) return;
            const notePath = filename.replace(/\\/g, "/");
            try {
                const content = await readFile(join(watchDir, notePath), "utf-8");
                searchIndex.update(notePath, content);
            } catch {
                searchIndex.remove(notePath);
            }
        });

        try {
            // Write a file externally (simulating Obsidian editing)
            await writeFile(join(watchDir, "external.md"), "external edit keyword banana");
            // Wait for watcher to pick it up
            await new Promise((r) => setTimeout(r, 500));

            const results = searchIndex.search("banana");
            assert.equal(results.length, 1);
            assert.equal(results[0].path, "external.md");

            // Delete the file
            await unlink(join(watchDir, "external.md"));
            await new Promise((r) => setTimeout(r, 500));

            assert.deepEqual(searchIndex.search("banana"), []);
        } finally {
            watcher.close();
            await rm(watchDir, { recursive: true, force: true });
        }
    });

    it("ignores non-md files", async () => {
        const watchDir = await mkdtemp(join(tmpdir(), "watch-test-"));
        const searchIndex = new SearchIndex();

        const watcher = watch(watchDir, { recursive: true }, async (_event, filename) => {
            if (!filename || !filename.endsWith(".md")) return;
            const notePath = filename.replace(/\\/g, "/");
            try {
                const content = await readFile(join(watchDir, notePath), "utf-8");
                searchIndex.update(notePath, content);
            } catch {
                searchIndex.remove(notePath);
            }
        });

        try {
            await writeFile(join(watchDir, "image.png"), "not a note");
            await new Promise((r) => setTimeout(r, 500));
            assert.equal(searchIndex.size, 0);
        } finally {
            watcher.close();
            await rm(watchDir, { recursive: true, force: true });
        }
    });

    it("detects files in subdirectories", async () => {
        const watchDir = await mkdtemp(join(tmpdir(), "watch-test-"));
        const searchIndex = new SearchIndex();

        const watcher = watch(watchDir, { recursive: true }, async (_event, filename) => {
            if (!filename || !filename.endsWith(".md")) return;
            const notePath = filename.replace(/\\/g, "/");
            try {
                const content = await readFile(join(watchDir, notePath), "utf-8");
                searchIndex.update(notePath, content);
            } catch {
                searchIndex.remove(notePath);
            }
        });

        try {
            await mkdir(join(watchDir, "sub", "dir"), { recursive: true });
            await writeFile(join(watchDir, "sub", "dir", "deep.md"), "deep nested content mango");
            await new Promise((r) => setTimeout(r, 500));

            const results = searchIndex.search("mango");
            assert.equal(results.length, 1);
            assert.ok(results[0].path.includes("deep.md"));
        } finally {
            watcher.close();
            await rm(watchDir, { recursive: true, force: true });
        }
    });
});
