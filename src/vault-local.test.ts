import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, unlink, readFile } from "fs/promises";
import { watch, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LocalVault } from "./vault-local.js";
import { AttachmentExistsError } from "./vault-backend.js";
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
        await assert.rejects(() => vault.readNote("../etc/passwd"), /Invalid note path/);
    });

    it("blocks ../../ traversal", async () => {
        await assert.rejects(() => vault.readNote("../../etc/shadow"), /Invalid note path/);
    });

    it("blocks write with traversal", async () => {
        await assert.rejects(() => vault.writeNote("../evil.md", "pwned"), /Invalid note path/);
    });

    it("blocks delete with traversal", async () => {
        await assert.rejects(() => vault.deleteNote("../../important.md"), /Invalid note path/);
    });

    it("blocks listNotes with traversal", async () => {
        await assert.rejects(() => vault.listNotes("../../etc"), /Path traversal blocked/);
    });

    it("allows nested paths within vault", async () => {
        await vault.writeNote("sub/dir/note.md", "ok");
        assert.equal(await vault.readNote("sub/dir/note.md"), "ok");
    });
});

describe("note-path enforcement (GHSA-hfcr-mrh3-c584)", () => {
    it("rejects writing executable code into .obsidian", async () => {
        await assert.rejects(() => vault.writeNote(".obsidian/plugins/evil/main.js", "pwned"), /Invalid note path/);
    });

    it("rejects reading LiveSync credentials from .obsidian", async () => {
        await assert.rejects(() => vault.readNote(".obsidian/plugins/obsidian-livesync/data.json"), /Invalid note path/);
    });

    it("rejects non-.md writes", async () => {
        await assert.rejects(() => vault.writeNote("notes/data.json", "{}"), /Invalid note path/);
    });

    it("blocks a write that escapes via a symlinked directory", async () => {
        const outside = await mkdtemp(join(tmpdir(), "vault-outside-"));
        try {
            // A pre-existing symlink inside the vault pointing outside it.
            const { symlink } = await import("fs/promises");
            await symlink(outside, join(tmpDir, "link"));
            // Target file does not exist yet, so the old ENOENT path returned
            // the lexical path and followed the symlink out of the vault.
            await assert.rejects(() => vault.writeNote("link/escaped.md", "pwned"), /Path traversal blocked/);
            await assert.equal(await readFile(join(outside, "escaped.md"), "utf-8").catch(() => null), null);
        } finally {
            await unlink(join(tmpDir, "link")).catch(() => {});
            await rm(outside, { recursive: true, force: true });
        }
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

describe("edit_note operations (string manipulation)", () => {
    // These test the same logic as the edit_note tool: read, transform, write back

    it("append adds content to end", async () => {
        await vault.writeNote("edit/append.md", "line one");
        const existing = (await vault.readNote("edit/append.md"))!;
        const updated = existing + "\nline two";
        await vault.writeNote("edit/append.md", updated);
        assert.equal(await vault.readNote("edit/append.md"), "line one\nline two");
    });

    it("append adds newline if missing", async () => {
        await vault.writeNote("edit/append-nl.md", "line one\n");
        const existing = (await vault.readNote("edit/append-nl.md"))!;
        const updated = existing.endsWith("\n") ? existing + "line two" : existing + "\nline two";
        await vault.writeNote("edit/append-nl.md", updated);
        assert.equal(await vault.readNote("edit/append-nl.md"), "line one\nline two");
    });

    it("prepend inserts after frontmatter", async () => {
        const original = "---\ntitle: Test\n---\nBody here";
        await vault.writeNote("edit/prepend.md", original);
        const existing = (await vault.readNote("edit/prepend.md"))!;
        const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
        let updated: string;
        if (fmMatch) {
            const afterFm = fmMatch[0].length;
            updated = existing.slice(0, afterFm) + "New top line\n" + existing.slice(afterFm);
        } else {
            updated = "New top line\n" + existing;
        }
        await vault.writeNote("edit/prepend.md", updated);
        assert.equal(await vault.readNote("edit/prepend.md"), "---\ntitle: Test\n---\nNew top line\nBody here");
    });

    it("prepend goes to top when no frontmatter", async () => {
        await vault.writeNote("edit/prepend-nofm.md", "Body here");
        const existing = (await vault.readNote("edit/prepend-nofm.md"))!;
        const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
        const updated = fmMatch
            ? existing.slice(0, fmMatch[0].length) + "New top\n" + existing.slice(fmMatch[0].length)
            : "New top\n" + existing;
        await vault.writeNote("edit/prepend-nofm.md", updated);
        assert.equal(await vault.readNote("edit/prepend-nofm.md"), "New top\nBody here");
    });

    it("replace swaps exact match", async () => {
        await vault.writeNote("edit/replace.md", "Hello world, hello universe");
        const existing = (await vault.readNote("edit/replace.md"))!;
        const oldText = "world";
        const idx = existing.indexOf(oldText);
        assert.notEqual(idx, -1);
        const updated = existing.slice(0, idx) + "earth" + existing.slice(idx + oldText.length);
        await vault.writeNote("edit/replace.md", updated);
        assert.equal(await vault.readNote("edit/replace.md"), "Hello earth, hello universe");
    });

    it("replace fails if old_text not found", async () => {
        await vault.writeNote("edit/replace-miss.md", "Some content");
        const existing = (await vault.readNote("edit/replace-miss.md"))!;
        const idx = existing.indexOf("nonexistent");
        assert.equal(idx, -1);
    });

    it("replace detects multiple matches", async () => {
        await vault.writeNote("edit/replace-multi.md", "foo bar foo baz");
        const existing = (await vault.readNote("edit/replace-multi.md"))!;
        const oldText = "foo";
        const idx = existing.indexOf(oldText);
        const secondIdx = existing.indexOf(oldText, idx + 1);
        assert.notEqual(secondIdx, -1, "should find multiple matches");
    });
});

function createWatcher(dir: string, index: SearchIndex) {
    return watch(dir, { recursive: true }, async (_event, filename) => {
        if (!filename || !filename.endsWith(".md")) return;
        const notePath = filename.replace(/\\/g, "/");
        try {
            const content = await readFile(join(dir, notePath), "utf-8");
            index.update(notePath, content);
        } catch {
            index.remove(notePath);
        }
    });
}

describe("file watcher integration", () => {
    it("detects new file and updates search index", async () => {
        const watchDir = await mkdtemp(join(tmpdir(), "watch-test-"));
        const searchIndex = new SearchIndex();
        const watcher = createWatcher(watchDir, searchIndex);

        try {
            await writeFile(join(watchDir, "external.md"), "external edit keyword banana");
            await new Promise((r) => setTimeout(r, 500));

            const paths = searchIndex.listPaths();
            assert.ok(paths.includes("external.md"), "should index external.md");

            await unlink(join(watchDir, "external.md"));
            await new Promise((r) => setTimeout(r, 500));

            assert.ok(!searchIndex.listPaths().includes("external.md"), "should remove deleted file");
        } finally {
            watcher.close();
            await rm(watchDir, { recursive: true, force: true });
        }
    });

    it("ignores non-md files", async () => {
        const watchDir = await mkdtemp(join(tmpdir(), "watch-test-"));
        const searchIndex = new SearchIndex();
        const watcher = createWatcher(watchDir, searchIndex);

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
        const watcher = createWatcher(watchDir, searchIndex);

        try {
            await mkdir(join(watchDir, "sub", "dir"), { recursive: true });
            await writeFile(join(watchDir, "sub", "dir", "deep.md"), "deep nested content mango");
            await new Promise((r) => setTimeout(r, 500));

            const paths = searchIndex.listPaths();
            assert.ok(paths.some((p) => p.includes("deep.md")), "should index deep nested file");
        } finally {
            watcher.close();
            await rm(watchDir, { recursive: true, force: true });
        }
    });
});

describe("attachments", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);

    it("writes, stats, moves and deletes binary files byte-exact", async () => {
        assert.equal(await vault.writeAttachment("Attachments/a.png", bytes), true);
        assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "Attachments/a.png"))), bytes);
        const info = await vault.getAttachmentInfo("Attachments/a.png");
        assert.equal(info?.size, bytes.byteLength);

        assert.equal(await vault.moveAttachment("Attachments/a.png", "Attachments/sub/b.png"), true);
        assert.equal(await vault.getAttachmentInfo("Attachments/a.png"), null);
        assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "Attachments/sub/b.png"))), bytes);

        assert.equal(await vault.deleteAttachment("Attachments/sub/b.png"), true);
        assert.equal(await vault.getAttachmentInfo("Attachments/sub/b.png"), null);
    });

    it("is not visible as a note", async () => {
        await vault.writeAttachment("Attachments/c.pdf", bytes);
        const notes = await vault.listNotes();
        assert.equal(notes.some((n) => n.includes("c.pdf")), false);
        await vault.deleteAttachment("Attachments/c.pdf");
    });

    it("listAttachments finds media files and skips notes, other files and dot-folders", async () => {
        await vault.writeAttachment("Attachments/l1.png", bytes);
        await vault.writeAttachment("deep/er/l2.pdf", bytes);
        await mkdir(join(tmpDir, ".obsidian/plugins/x"), { recursive: true });
        await writeFile(join(tmpDir, ".obsidian/plugins/x/hidden.png"), bytes);
        await writeFile(join(tmpDir, "notes.txt"), "x");
        const listed = (await vault.listAttachments()).map((a) => a.path);
        assert.ok(listed.includes("Attachments/l1.png"));
        assert.ok(listed.includes("deep/er/l2.pdf"));
        assert.ok(!listed.some((p) => p.includes(".obsidian") || p.endsWith(".md") || p.endsWith(".txt")), listed.join(", "));
        assert.equal((await vault.listAttachments()).find((a) => a.path === "Attachments/l1.png")?.size, bytes.byteLength);
        await vault.deleteAttachment("Attachments/l1.png");
        await vault.deleteAttachment("deep/er/l2.pdf");
    });

    it("refuses notes, config and traversal through the attachment methods", async () => {
        await assert.rejects(() => vault.writeAttachment("note.md", bytes), /Invalid attachment path/);
        await assert.rejects(() => vault.writeAttachment(".obsidian/plugins/x/main.js", bytes), /Invalid attachment path/);
        await assert.rejects(() => vault.writeAttachment("../escape.png", bytes), /Invalid attachment path/);
        await assert.rejects(() => vault.moveAttachment("a.png", "a.md"), /Invalid attachment path/);
    });

    it("refuses to replace an existing file unless overwrite is set", async () => {
        const other = new Uint8Array([1, 2, 3]);
        await vault.writeAttachment("Attachments/ow.png", bytes);
        await assert.rejects(() => vault.writeAttachment("Attachments/ow.png", other), AttachmentExistsError);
        assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "Attachments/ow.png"))), bytes);
        assert.equal(await vault.writeAttachment("Attachments/ow.png", other, { overwrite: true }), true);
        assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "Attachments/ow.png"))), other);
        await vault.deleteAttachment("Attachments/ow.png");
    });

    it("lets exactly one of two concurrent creates of the same path win", async () => {
        const a = new Uint8Array(64 * 1024).fill(1);
        const b = new Uint8Array(64 * 1024).fill(2);
        const results = await Promise.allSettled([
            vault.writeAttachment("Attachments/race.png", a),
            vault.writeAttachment("Attachments/race.png", b),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        assert.ok(rejected.reason instanceof AttachmentExistsError);
        const winner = results[0].status === "fulfilled" ? a : b;
        assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "Attachments/race.png"))), winner);
        await vault.deleteAttachment("Attachments/race.png");
    });

    it("moves onto an existing file only with overwrite, keeping both files otherwise", async () => {
        const other = new Uint8Array([9, 9]);
        await vault.writeAttachment("Attachments/m1.png", bytes);
        await vault.writeAttachment("Attachments/m2.png", other);
        await assert.rejects(() => vault.moveAttachment("Attachments/m1.png", "Attachments/m2.png"), AttachmentExistsError);
        assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "Attachments/m1.png"))), bytes);
        assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "Attachments/m2.png"))), other);
        assert.equal(await vault.moveAttachment("Attachments/m1.png", "Attachments/m2.png", { overwrite: true }), true);
        assert.equal(await vault.getAttachmentInfo("Attachments/m1.png"), null);
        assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "Attachments/m2.png"))), bytes);
        await vault.deleteAttachment("Attachments/m2.png");
    });

    it("renames without loading the file, so the move size limit does not apply", async () => {
        await vault.writeAttachment("Attachments/huge.mp4", new Uint8Array(4096));
        assert.equal(await vault.moveAttachment("Attachments/huge.mp4", "Attachments/huge2.mp4", { maxBytes: 1 }), true);
        assert.equal((await vault.getAttachmentInfo("Attachments/huge2.mp4"))?.size, 4096);
        await vault.deleteAttachment("Attachments/huge2.mp4");
    });

    it("keeps the file when moving an attachment or note onto itself", async () => {
        await vault.writeAttachment("Attachments/self.png", bytes);
        assert.equal(await vault.moveAttachment("Attachments/self.png", "Attachments/self.png"), true);
        assert.equal(await vault.moveAttachment("Attachments/self.png", "Attachments/self.png", { overwrite: true }), true);
        assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "Attachments/self.png"))), bytes);
        await vault.deleteAttachment("Attachments/self.png");

        await vault.writeNote("self.md", "still here");
        assert.equal(await vault.moveNote("self.md", "self.md"), true);
        assert.equal(await vault.readNote("self.md"), "still here");
        await vault.deleteNote("self.md");
    });

    it("blocks an attachment write that escapes via a symlinked directory", async () => {
        const outside = await mkdtemp(join(tmpdir(), "vault-outside-"));
        try {
            const { symlink } = await import("fs/promises");
            await symlink(outside, join(tmpDir, "attlink"));
            await assert.rejects(() => vault.writeAttachment("attlink/x.png", bytes), /Path traversal blocked/);
        } finally {
            await unlink(join(tmpDir, "attlink")).catch(() => {});
            await rm(outside, { recursive: true, force: true });
        }
    });

    it("blocks writes through a dangling symlink to a file or directory outside the vault", async () => {
        const outside = await mkdtemp(join(tmpdir(), "vault-outside-"));
        const links = ["dangling.png", "dangling.md", "danglingdir"];
        try {
            const { symlink } = await import("fs/promises");
            await symlink(join(outside, "new.png"), join(tmpDir, "dangling.png"));
            await symlink(join(outside, "new.md"), join(tmpDir, "dangling.md"));
            await symlink(join(outside, "notyet"), join(tmpDir, "danglingdir"));
            await assert.rejects(() => vault.writeAttachment("dangling.png", bytes), /Path traversal blocked/);
            await assert.rejects(() => vault.writeAttachment("dangling.png", bytes, { overwrite: true }), /Path traversal blocked/);
            await assert.rejects(() => vault.writeNote("dangling.md", "x"), /Path traversal blocked/);
            await assert.rejects(() => vault.writeAttachment("danglingdir/sub/x.png", bytes), /Path traversal blocked/);
            assert.equal(existsSync(join(outside, "new.png")), false);
            assert.equal(existsSync(join(outside, "new.md")), false);
            assert.equal(existsSync(join(outside, "notyet")), false);
        } finally {
            for (const l of links) await unlink(join(tmpDir, l)).catch(() => {});
            await rm(outside, { recursive: true, force: true });
        }
    });

    it("still writes a new file through a symlinked directory inside the vault", async () => {
        const { symlink } = await import("fs/promises");
        await mkdir(join(tmpDir, "realdir"), { recursive: true });
        await symlink(join(tmpDir, "realdir"), join(tmpDir, "innerlink"));
        try {
            assert.equal(await vault.writeAttachment("innerlink/ok.png", bytes), true);
            assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "realdir/ok.png"))), bytes);
        } finally {
            await unlink(join(tmpDir, "innerlink")).catch(() => {});
            await rm(join(tmpDir, "realdir"), { recursive: true, force: true });
        }
    });

    it("listAttachments leaves out symlinks that point outside the vault", async () => {
        const outside = await mkdtemp(join(tmpdir(), "vault-outside-"));
        try {
            const { symlink } = await import("fs/promises");
            await writeFile(join(outside, "secret.png"), bytes);
            await mkdir(join(outside, "dir"));
            await writeFile(join(outside, "dir/inner.png"), bytes);
            await symlink(join(outside, "secret.png"), join(tmpDir, "leak.png"));
            await symlink(join(outside, "dir"), join(tmpDir, "leakdir"));
            await symlink(join(outside, "gone.png"), join(tmpDir, "gone.png"));
            await vault.writeAttachment("Attachments/kept.png", bytes);
            const listed = (await vault.listAttachments()).map((a) => a.path);
            assert.ok(listed.includes("Attachments/kept.png"), listed.join(", "));
            assert.ok(!listed.some((p) => p.startsWith("leak") || p === "gone.png"), listed.join(", "));
        } finally {
            for (const l of ["leak.png", "leakdir", "gone.png"]) await unlink(join(tmpDir, l)).catch(() => {});
            await vault.deleteAttachment("Attachments/kept.png").catch(() => {});
            await rm(outside, { recursive: true, force: true });
        }
    });

    it("refuses attachment operations through a symlink to a note or a dot-folder file", async () => {
        const { symlink } = await import("fs/promises");
        await mkdir(join(tmpDir, ".obsidian/plugins"), { recursive: true });
        await mkdir(join(tmpDir, "Notes"), { recursive: true });
        await writeFile(join(tmpDir, "Notes/secret.md"), "secret");
        await writeFile(join(tmpDir, ".obsidian/plugins/main.png"), bytes);
        await symlink(join(tmpDir, "Notes/secret.md"), join(tmpDir, "tonote.png"));
        await symlink(join(tmpDir, ".obsidian/plugins/main.png"), join(tmpDir, "todot.png"));
        await symlink(join(tmpDir, ".obsidian/plugins"), join(tmpDir, "media"));
        try {
            for (const link of ["tonote.png", "todot.png", "media/main.png", "media/new.png"]) {
                await assert.rejects(() => vault.writeAttachment(link, bytes, { overwrite: true }), /Path traversal blocked/, link);
                await assert.rejects(() => vault.deleteAttachment(link), /Path traversal blocked/, link);
                await assert.rejects(() => vault.moveAttachment(link, "moved.png"), /Path traversal blocked/, link);
                await assert.rejects(() => vault.getAttachmentInfo(link), /Path traversal blocked/, link);
            }
            await assert.rejects(() => vault.moveAttachment("kept-src.png", "tonote.png", { overwrite: true }), /Path traversal blocked/);
            assert.equal(await readFile(join(tmpDir, "Notes/secret.md"), "utf8"), "secret");
            assert.ok(existsSync(join(tmpDir, ".obsidian/plugins/main.png")));
            assert.equal(existsSync(join(tmpDir, ".obsidian/plugins/new.png")), false);
            const listed = (await vault.listAttachments()).map((a) => a.path);
            assert.ok(!listed.some((p) => ["tonote.png", "todot.png"].includes(p) || p.startsWith("media/")), listed.join(", "));
        } finally {
            for (const l of ["tonote.png", "todot.png", "media"]) await unlink(join(tmpDir, l)).catch(() => {});
            await rm(join(tmpDir, ".obsidian"), { recursive: true, force: true });
            await rm(join(tmpDir, "Notes"), { recursive: true, force: true });
        }
    });

    it("refuses to write, delete or move a symlink to another attachment, but reads through it", async () => {
        const { symlink } = await import("fs/promises");
        await writeFile(join(tmpDir, "target.png"), bytes);
        await symlink(join(tmpDir, "target.png"), join(tmpDir, "alias.png"));
        try {
            await assert.rejects(() => vault.writeAttachment("alias.png", new Uint8Array([9]), { overwrite: true }), /Refusing to modify a symlink/);
            await assert.rejects(() => vault.deleteAttachment("alias.png"), /Refusing to modify a symlink/);
            await assert.rejects(() => vault.moveAttachment("alias.png", "x.png"), /Refusing to modify a symlink/);
            await assert.rejects(() => vault.moveAttachment("target.png", "alias.png", { overwrite: true }), /Refusing to modify a symlink/);
            assert.deepEqual(new Uint8Array(await readFile(join(tmpDir, "target.png"))), bytes);
            assert.equal((await vault.getAttachmentInfo("alias.png"))?.size, bytes.byteLength);
        } finally {
            await unlink(join(tmpDir, "alias.png")).catch(() => {});
            await unlink(join(tmpDir, "target.png")).catch(() => {});
        }
    });

    it("refuses a note operation through a symlink to a file that isn't a note", async () => {
        const { symlink } = await import("fs/promises");
        await mkdir(join(tmpDir, ".trash"), { recursive: true });
        await writeFile(join(tmpDir, ".trash/old.md"), "old");
        await symlink(join(tmpDir, ".trash/old.md"), join(tmpDir, "trashed.md"));
        try {
            await assert.rejects(() => vault.readNote("trashed.md"), /Path traversal blocked/);
            await assert.rejects(() => vault.writeNote("trashed.md", "new"), /Path traversal blocked/);
            assert.equal(await readFile(join(tmpDir, ".trash/old.md"), "utf8"), "old");
        } finally {
            await unlink(join(tmpDir, "trashed.md")).catch(() => {});
            await rm(join(tmpDir, ".trash"), { recursive: true, force: true });
        }
    });
});
