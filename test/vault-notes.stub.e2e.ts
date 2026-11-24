/**
 * CouchDB-mode note writes (src/vault.ts) against a stubbed DirectFileManipulator:
 * writeNote modes, moveNote never replacing, and the per-document lock that
 * makes the existence check and the write one step. No CouchDB needed, but
 * vault.ts imports livesync-commonlib, which plain tsx can't resolve, so this
 * runs bundled like the other harnesses:
 *
 *   npm run test:vault-stub
 *
 * The real-CouchDB counterpart is the "note write modes" step in
 * test/couchdb-obfuscation.e2e.ts.
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { Vault } from "../src/vault.js";
import { NoteExistsError, NoteNotFoundError } from "../src/vault-backend.js";

// tsup strips the "node:" prefix from imports, and node:test only exists under
// that name, so load it at run time instead.
const { describe, it } = createRequire(import.meta.url)("node:test") as typeof import("node:test");

type Doc = { path: string; data: string[]; ctime: number; mtime: number; size: number };

/**
 * Enough of DirectFileManipulator for the note methods. Ids are lowercased like
 * LiveSync's default (case-insensitive) vaults, and every call yields so
 * unlocked check-then-write sequences would interleave.
 */
function stubVault({ caseSensitive = false } = {}) {
    const docs = new Map<string, Doc>();
    const calls: string[] = [];
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const id = (p: string) => (caseSensitive ? p : p.toLowerCase());
    const manipulator = {
        path2id: async (p: string) => id(p),
        get: async (p: string, metaOnly = false) => {
            calls.push(`get ${p}${metaOnly ? " meta" : ""}`);
            await tick();
            const d = docs.get(id(p));
            return d ? { ...d } : false;
        },
        put: async (p: string, blob: Blob, info: { ctime: number; mtime: number; size: number }) => {
            calls.push(`put ${p}`);
            const text = await blob.text();
            await tick();
            docs.set(id(p), { path: p, data: [text], ...info });
            return true;
        },
        delete: async (p: string) => {
            calls.push(`delete ${p}`);
            await tick();
            return docs.delete(id(p));
        },
    };
    const vault = new Vault({ couchdbUrl: "http://stub", couchdbUser: "u", couchdbPassword: "p", database: "stub" });
    (vault as any).manipulator = manipulator;
    const seed = (p: string, text: string, ctime = 1) => docs.set(id(p), { path: p, data: [text], ctime, mtime: ctime, size: text.length });
    return { vault, docs, calls, seed };
}

describe("Vault.writeNote modes (stubbed manipulator)", () => {
    it("upsert (default) creates and replaces, keeping ctime", async () => {
        const { vault, docs, seed } = stubVault();
        assert.equal(await vault.writeNote("a.md", "v1"), true);
        seed("b.md", "old", 42);
        assert.equal(await vault.writeNote("b.md", "new", { mode: "upsert" }), true);
        assert.equal(docs.get("b.md")?.data.join(""), "new");
        assert.equal(docs.get("b.md")?.ctime, 42);
    });

    it("create refuses an existing note without writing", async () => {
        const { vault, calls, seed } = stubVault();
        seed("Raw/a.md", "v1");
        await assert.rejects(() => vault.writeNote("Raw/a.md", "v2", { mode: "create" }), (e: any) => e instanceof NoteExistsError && e.path === "Raw/a.md");
        assert.ok(!calls.some((c) => c.startsWith("put")), calls.join(", "));
    });

    it("create sees a case variant as the same note on a case-insensitive vault", async () => {
        const { vault, seed } = stubVault();
        seed("Raw/a.md", "v1");
        await assert.rejects(() => vault.writeNote("raw/A.md", "v2", { mode: "create" }), NoteExistsError);
    });

    it("update refuses a missing note without writing, and keeps ctime on success", async () => {
        const { vault, docs, calls, seed } = stubVault();
        await assert.rejects(() => vault.writeNote("x.md", "v", { mode: "update" }), (e: any) => e instanceof NoteNotFoundError && e.path === "x.md");
        assert.ok(!calls.some((c) => c.startsWith("put")));
        assert.equal(docs.size, 0);
        seed("y.md", "old", 7);
        assert.equal(await vault.writeNote("y.md", "new", { mode: "update" }), true);
        assert.equal(docs.get("y.md")?.ctime, 7);
    });

    it("concurrent creates of one note: exactly one wins (the lock makes check+put one step)", async () => {
        const { vault, docs } = stubVault();
        const results = await Promise.allSettled(["one", "two", "three"].map((c) => vault.writeNote("race.md", c, { mode: "create" })));
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof NoteExistsError);
        const winner = ["one", "two", "three"][results.findIndex((r) => r.status === "fulfilled")];
        assert.equal(docs.get("race.md")?.data.join(""), winner);
    });

    it("concurrent creates through two spellings of one document: one wins", async () => {
        const { vault } = stubVault();
        const results = await Promise.allSettled([vault.writeNote("Raw/a.md", "1", { mode: "create" }), vault.writeNote("raw/a.md", "2", { mode: "create" })]);
        assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    });

    it("an update racing a delete never recreates the note", async () => {
        const { vault, docs, seed } = stubVault();
        seed("d.md", "x");
        const [del, upd] = await Promise.allSettled([vault.deleteNote("d.md"), vault.writeNote("d.md", "y", { mode: "update" })]);
        assert.equal(del.status, "fulfilled");
        assert.equal(upd.status, "rejected", "delete took the lock first");
        assert.equal(docs.size, 0);
    });
});

describe("Vault.moveNote never replaces (stubbed manipulator)", () => {
    it("moves across folders: create at the destination, then delete the source", async () => {
        const { vault, docs, calls, seed } = stubVault();
        seed("A/n.md", "body", 5);
        assert.equal(await vault.moveNote("A/n.md", "B/sub/n.md"), true);
        assert.deepEqual([...docs.keys()], ["b/sub/n.md"]);
        assert.equal(docs.get("b/sub/n.md")?.path, "B/sub/n.md");
        assert.equal(docs.get("b/sub/n.md")?.data.join(""), "body");
        assert.deepEqual(calls.filter((c) => !c.startsWith("get")), ["put B/sub/n.md", "delete A/n.md"]);
    });

    it("refuses an existing destination and deletes nothing", async () => {
        const { vault, docs, calls, seed } = stubVault();
        seed("A/n.md", "src");
        seed("B/n.md", "dest");
        await assert.rejects(() => vault.moveNote("A/n.md", "B/n.md"), (e: any) => e instanceof NoteExistsError && e.path === "B/n.md");
        assert.equal(docs.get("a/n.md")?.data.join(""), "src");
        assert.equal(docs.get("b/n.md")?.data.join(""), "dest");
        assert.ok(!calls.some((c) => c.startsWith("put") || c.startsWith("delete")), calls.join(", "));
    });

    it("refuses a destination that is a case variant of another existing note", async () => {
        const { vault, seed } = stubVault({ caseSensitive: true });
        seed("A/n.md", "src");
        seed("B/n.md", "dest");
        await assert.rejects(() => vault.moveNote("A/n.md", "B/n.md"), NoteExistsError);
        assert.equal(await vault.moveNote("A/n.md", "B/N.md"), true, "a different document on a case-sensitive vault");
    });

    it("a case-only rename rewrites the one document under the new path and deletes nothing", async () => {
        const { vault, docs, calls, seed } = stubVault();
        seed("N/Self.md", "keep me", 9);
        assert.equal(await vault.moveNote("N/Self.md", "N/self.md"), true);
        assert.equal(docs.size, 1);
        assert.equal(docs.get("n/self.md")?.path, "N/self.md");
        assert.equal(docs.get("n/self.md")?.data.join(""), "keep me");
        assert.equal(docs.get("n/self.md")?.ctime, 9);
        assert.ok(!calls.some((c) => c.startsWith("delete")));
    });

    it("onto itself: true, no write", async () => {
        const { vault, calls, seed } = stubVault();
        seed("s.md", "s");
        assert.equal(await vault.moveNote("s.md", "s.md"), true);
        assert.ok(!calls.some((c) => c.startsWith("put") || c.startsWith("delete")));
    });

    it("a missing source returns false and writes nothing", async () => {
        const { vault, calls } = stubVault();
        assert.equal(await vault.moveNote("none.md", "dest.md"), false);
        assert.ok(!calls.some((c) => c.startsWith("put") || c.startsWith("delete")));
    });

    it("two concurrent moves onto one new path: one wins, the other source stays", async () => {
        const { vault, docs, seed } = stubVault();
        seed("a.md", "A");
        seed("b.md", "B");
        const results = await Promise.allSettled([vault.moveNote("a.md", "won.md"), vault.moveNote("b.md", "won.md")]);
        assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
        assert.ok((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason instanceof NoteExistsError);
        const aWon = results[0].status === "fulfilled";
        assert.equal(docs.get("won.md")?.data.join(""), aWon ? "A" : "B");
        assert.equal(docs.get(aWon ? "b.md" : "a.md")?.data.join(""), aWon ? "B" : "A");
        assert.equal(docs.size, 2);
    });

    it("a move racing a create of its destination: one of them is refused", async () => {
        const { vault, docs, seed } = stubVault();
        seed("m.md", "mover");
        const results = await Promise.allSettled([vault.moveNote("m.md", "t.md"), vault.writeNote("t.md", "creator", { mode: "create" })]);
        assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
        const t = docs.get("t.md")?.data.join("");
        assert.equal(t, results[0].status === "fulfilled" ? "mover" : "creator");
    });
});
