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
import { NoteExistsError, NoteNotFoundError, RevisionMismatchError, UpdateRetriesExhaustedError } from "../src/vault-backend.js";

// tsup strips the "node:" prefix from imports, and node:test only exists under
// that name, so load it at run time instead.
const { describe, it } = createRequire(import.meta.url)("node:test") as typeof import("node:test");

type Doc = { path: string; data: string[]; ctime: number; mtime: number; size: number; _rev: string };

/**
 * What happens just before a revision-checked put lands: another writer gets
 * in, the note is deleted, CouchDB fails without a 409 (answering false, or
 * throwing), or the put is stored and the answer is lost (it throws anyway).
 */
type BeforePut = "other" | "delete" | "fail" | "throw" | "storedThenThrow";

/**
 * Enough of DirectFileManipulator for the note methods. Ids are lowercased like
 * LiveSync's default (case-insensitive) vaults, and every call yields so
 * unlocked check-then-write sequences would interleave.
 */
function stubVault({ caseSensitive = false, maxBytes = Infinity, oversized = "false" as "false" | "throw" } = {}) {
    const docs = new Map<string, Doc>();
    const calls: string[] = [];
    /** Consumed one per revision-checked put, in order. */
    const beforePut: BeforePut[] = [];
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const id = (p: string) => (caseSensitive ? p : p.toLowerCase());
    let generation = 0;
    const nextRev = (prev?: string) => `${(prev ? Number(prev.split("-")[0]) : 0) + 1}-${(++generation).toString(16).padStart(8, "0")}`;
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
            docs.set(id(p), { path: p, data: [text], ...info, _rev: nextRev(docs.get(id(p))?._rev) });
            return true;
        },
        delete: async (p: string) => {
            calls.push(`delete ${p}`);
            await tick();
            return docs.delete(id(p));
        },
        liveSyncLocalDB: {
            // Like CouchDB: stored only if the note is still at baseRevision, otherwise false (a 409).
            putDBEntryWithLiveBaseRevision: async (doc: { _id: string; path: string; data: Blob; ctime: number; mtime: number; size: number }, baseRevision: string) => {
                calls.push(`put@rev ${doc.path}`);
                const text = await doc.data.text();
                await tick();
                // Like a body over CouchDB's max_http_request_size: refused whatever the revision.
                if (text.length > maxBytes) {
                    if (oversized === "throw") throw Object.assign(new Error("request entity too large"), { status: 413 });
                    return false;
                }
                const event = beforePut.shift();
                const current = docs.get(doc._id);
                if (event === "other" && current) docs.set(doc._id, { ...current, data: [current.data.join("") + "+other"], _rev: nextRev(current._rev) });
                if (event === "delete") docs.delete(doc._id);
                if (event === "fail") return false;
                if (event === "throw") throw new Error("socket hang up");
                const now = docs.get(doc._id);
                if (!now || now._rev !== baseRevision) return false;
                const rev = nextRev(now._rev);
                docs.set(doc._id, { path: doc.path, data: [text], ctime: doc.ctime, mtime: doc.mtime, size: doc.size, _rev: rev });
                if (event === "storedThenThrow") throw new Error("socket hang up");
                return { ok: true, id: doc._id, rev };
            },
        },
    };
    const vault = new Vault({ couchdbUrl: "http://stub", couchdbUser: "u", couchdbPassword: "p", database: "stub" });
    (vault as any).manipulator = manipulator;
    const seed = (p: string, text: string, ctime = 1) => docs.set(id(p), { path: p, data: [text], ctime, mtime: ctime, size: text.length, _rev: nextRev() });
    const revOf = (p: string) => docs.get(id(p))?._rev;
    const textOf = (p: string) => docs.get(id(p))?.data.join("");
    return { vault, docs, calls, seed, beforePut, revOf, textOf };
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

describe("Vault.updateNote retry loop (stubbed manipulator)", () => {
    const puts = (calls: string[]) => calls.filter((c) => c.startsWith("put")).length;

    it("an empty expected_revision is a mismatch, not \"no pin\": nothing is written", async () => {
        const { vault, calls, seed, revOf, textOf } = stubVault();
        seed("a.md", "v1");
        await assert.rejects(() => vault.updateNote("a.md", () => "overwritten", { expectedRevision: "", maxAttempts: 10 }),
            (e: any) => e instanceof RevisionMismatchError && e.expected === "" && e.current === revOf("a.md"));
        assert.equal(textOf("a.md"), "v1");
        assert.equal(puts(calls), 0, calls.join(", "));
    });

    it("re-applies the edit to the new text after each 409 and reports the attempts", async () => {
        const { vault, seed, beforePut, textOf, revOf } = stubVault();
        seed("a.md", "base");
        beforePut.push("other", "other");
        const seen: string[] = [];
        const result = await vault.updateNote("a.md", (c) => { seen.push(c); return c + "+mine"; }, { maxAttempts: 10 });
        assert.deepEqual(seen, ["base", "base+other", "base+other+other"]);
        assert.equal(result.attempts, 3);
        assert.equal(result.content, "base+other+other+mine");
        assert.equal(textOf("a.md"), "base+other+other+mine");
        assert.equal(result.revision, revOf("a.md"));
    });

    it("pinned: a 409 is one attempt and names the revision that won", async () => {
        const { vault, seed, beforePut, revOf, textOf } = stubVault();
        seed("a.md", "base");
        const pinned = revOf("a.md")!;
        beforePut.push("other");
        let applied = 0;
        await assert.rejects(() => vault.updateNote("a.md", (c) => { applied++; return c + "+mine"; }, { expectedRevision: pinned, maxAttempts: 10 }),
            (e: any) => e instanceof RevisionMismatchError && e.expected === pinned && e.current === revOf("a.md") && e.current !== pinned);
        assert.equal(applied, 1);
        assert.equal(textOf("a.md"), "base+other");
    });

    it("pinned: a note deleted under the write is a mismatch against (deleted)", async () => {
        const { vault, seed, beforePut, revOf, docs } = stubVault();
        seed("a.md", "base");
        const pinned = revOf("a.md")!;
        beforePut.push("delete");
        await assert.rejects(() => vault.updateNote("a.md", (c) => c + "+mine", { expectedRevision: pinned }),
            (e: any) => e instanceof RevisionMismatchError && e.current === "(deleted)");
        assert.equal(docs.size, 0);
    });

    it("pinned: false while the note is still at the pin is a failed write, not a mismatch", async () => {
        const { vault, seed, beforePut, revOf, textOf } = stubVault();
        seed("a.md", "base");
        beforePut.push("fail");
        await assert.rejects(() => vault.updateNote("a.md", (c) => c + "+mine", { expectedRevision: revOf("a.md")! }),
            (e: any) => !(e instanceof RevisionMismatchError) && /CouchDB did not store the write to a\.md/.test(e.message));
        assert.equal(textOf("a.md"), "base");
    });

    it("unpinned: false with the note unchanged stops at once instead of retrying", async () => {
        const { vault, calls, seed, beforePut, textOf } = stubVault();
        seed("a.md", "base");
        beforePut.push("fail", "fail", "fail");
        await assert.rejects(() => vault.updateNote("a.md", (c) => c + "+mine", { maxAttempts: 10, minRetryMs: 60_000 }),
            (e: any) => !(e instanceof UpdateRetriesExhaustedError) && /CouchDB did not store the write to a\.md/.test(e.message));
        assert.equal(puts(calls), 1, calls.join(", "));
        assert.equal(textOf("a.md"), "base");
    });

    it("gives up after exactly maxAttempts when minRetryMs has passed", async () => {
        const { vault, calls, seed, beforePut, textOf } = stubVault();
        seed("a.md", "base");
        for (let i = 0; i < 50; i++) beforePut.push("other");
        await assert.rejects(() => vault.updateNote("a.md", (c) => c + "+mine", { maxAttempts: 3, minRetryMs: 0 }),
            (e: any) => e instanceof UpdateRetriesExhaustedError && e.attempts === 3);
        assert.equal(puts(calls), 3);
        assert.ok(!textOf("a.md")!.includes("mine"));
    });

    it("keeps retrying past maxAttempts until minRetryMs, but never more than 5 x maxAttempts", async () => {
        const { vault, calls, seed, beforePut, textOf } = stubVault();
        seed("a.md", "base");
        for (let i = 0; i < 50; i++) beforePut.push("other");
        await assert.rejects(() => vault.updateNote("a.md", (c) => c + "+mine", { maxAttempts: 3, minRetryMs: 60_000 }),
            (e: any) => e instanceof UpdateRetriesExhaustedError && e.attempts === 15);
        assert.equal(puts(calls), 15);
        assert.ok(!textOf("a.md")!.includes("mine"));
    });
});

describe("Vault.writeNote overwrites through the revision check (stubbed manipulator)", () => {
    it("overwrites an existing note with a revision-checked put, never the forced one", async () => {
        const { vault, calls, seed, textOf } = stubVault();
        seed("a.md", "old", 3);
        assert.equal(await vault.writeNote("a.md", "new"), true);
        assert.equal(textOf("a.md"), "new");
        assert.deepEqual(calls.filter((c) => c.startsWith("put")), ["put@rev a.md"]);
    });

    it("another writer in between: retried on the new revision, and the written text wins", async () => {
        const { vault, calls, seed, beforePut, textOf } = stubVault();
        seed("a.md", "old");
        beforePut.push("other", "other");
        assert.equal(await vault.writeNote("a.md", "new", { mode: "update" }), true);
        assert.equal(textOf("a.md"), "new");
        assert.deepEqual(calls.filter((c) => c.startsWith("put")), ["put@rev a.md", "put@rev a.md", "put@rev a.md"]);
    });

    it("a note that keeps changing is refused after the budget, and nothing of it is written", async () => {
        const { vault, seed, beforePut, textOf } = stubVault();
        seed("a.md", "old");
        for (let i = 0; i < 50; i++) beforePut.push("other");
        await assert.rejects(() => vault.writeNote("a.md", "new", { maxAttempts: 2, minRetryMs: 0 }),
            (e: any) => e instanceof UpdateRetriesExhaustedError && e.attempts === 2);
        assert.equal(textOf("a.md"), "old+other+other");
    });

    it("CouchDB failing without a 409 answers false, as before, without retrying", async () => {
        const { vault, calls, seed, beforePut, textOf } = stubVault();
        seed("a.md", "old");
        beforePut.push("fail", "fail");
        assert.equal(await vault.writeNote("a.md", "new", { maxAttempts: 10 }), false);
        assert.equal(textOf("a.md"), "old");
        assert.equal(calls.filter((c) => c.startsWith("put")).length, 1);
    });

    it("deleted while retrying: upsert creates it, update refuses", async () => {
        const up = stubVault();
        up.seed("a.md", "old");
        up.beforePut.push("delete");
        assert.equal(await up.vault.writeNote("a.md", "new", { mode: "upsert" }), true);
        assert.equal(up.textOf("a.md"), "new");
        const upd = stubVault();
        upd.seed("a.md", "old");
        upd.beforePut.push("delete");
        await assert.rejects(() => upd.vault.writeNote("a.md", "new", { mode: "update" }), NoteNotFoundError);
        assert.equal(upd.docs.size, 0);
    });

    it("creating an absent note is unchanged: the plain put, no revision", async () => {
        const { vault, calls } = stubVault();
        assert.equal(await vault.writeNote("n.md", "fresh"), true);
        assert.equal(await vault.writeNote("m.md", "fresh", { mode: "create" }), true);
        assert.deepEqual(calls.filter((c) => c.startsWith("put")), ["put n.md", "put m.md"]);
    });
});

describe("Vault.updateNote group commit (stubbed manipulator)", () => {
    const puts = (calls: string[]) => calls.filter((c) => c.startsWith("put")).length;
    const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
    /** Hold the note's lock, so edits issued meanwhile queue up and form one group when it is released. */
    function holdLock(vault: Vault, id: string): () => Promise<void> {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        const taken = (vault as any).docLock.run([id], () => held);
        return async () => {
            release();
            await taken;
        };
    }

    it("a burst of edits queued behind a write is one read and one put", async () => {
        const { vault, calls, seed, textOf } = stubVault();
        seed("a.md", "base");
        const release = holdLock(vault, "a.md");
        const pending = Array.from({ length: 10 }, (_, i) => vault.updateNote("a.md", (c) => c + `+e${i}`, { maxAttempts: 10 }));
        await tick();
        await release();
        const results = await Promise.all(pending);
        assert.equal(textOf("a.md"), "base" + Array.from({ length: 10 }, (_, i) => `+e${i}`).join(""));
        assert.equal(puts(calls), 1, calls.join(", "));
        assert.equal(calls.filter((c) => c.startsWith("get")).length, 1, calls.join(", "));
        assert.ok(results.every((r) => r.attempts === 1));
    });

    it("a member whose edit throws is answered with its error; the others land", async () => {
        const { vault, calls, seed, textOf } = stubVault();
        seed("a.md", "base");
        const release = holdLock(vault, "a.md");
        const refused = new Error("old_text not found");
        const pending = [
            vault.updateNote("a.md", (c) => c + "+e1", { maxAttempts: 10 }),
            vault.updateNote("a.md", () => { throw refused; }, { maxAttempts: 10 }),
            vault.updateNote("a.md", (c) => c + "+e3", { maxAttempts: 10 }),
        ];
        await tick();
        await release();
        const results = await Promise.allSettled(pending);
        assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
        assert.equal((results[1] as PromiseRejectedResult).reason, refused);
        assert.equal(textOf("a.md"), "base+e1+e3");
        assert.equal(puts(calls), 1, calls.join(", "));
    });

    it("a member that can't apply in round 1 lands in round 2, after another writer's change made it applicable", async () => {
        const { vault, seed, beforePut, textOf, revOf } = stubVault();
        seed("a.md", "base");
        beforePut.push("other");
        const release = holdLock(vault, "a.md");
        const replaceOther = (c: string) => {
            if (!c.includes("+other")) throw new Error("old_text not found");
            return c.replace("+other", "+OTHER");
        };
        const pending = [vault.updateNote("a.md", (c) => c + "+e1", { maxAttempts: 10 }), vault.updateNote("a.md", replaceOther, { maxAttempts: 10 })];
        await tick();
        await release();
        const [first, second] = await Promise.all(pending);
        assert.equal(textOf("a.md"), "base+OTHER+e1");
        assert.equal(first.attempts, 2);
        assert.equal(second.attempts, 2);
        assert.equal(second.content, textOf("a.md"));
        assert.equal(second.revision, revOf("a.md"));
    });

    it("a note missing for the group: every member is told NoteNotFound and nothing is written", async () => {
        const { vault, calls, docs } = stubVault();
        const release = holdLock(vault, "gone.md");
        const pending = [1, 2, 3].map((i) => vault.updateNote("gone.md", (c) => c + `+e${i}`, { maxAttempts: 10 }));
        await tick();
        await release();
        const results = await Promise.allSettled(pending);
        for (const r of results) assert.ok(r.status === "rejected" && r.reason instanceof NoteNotFoundError && r.reason.path === "gone.md");
        assert.equal(puts(calls), 0, calls.join(", "));
        assert.equal(docs.size, 0);
    });

    it("a pinned call arriving mid-group is never folded into it: it runs alone, after, and sees the group's revision", async () => {
        const { vault, calls, seed, textOf, revOf } = stubVault();
        seed("a.md", "base");
        const pinned = revOf("a.md")!;
        const release = holdLock(vault, "a.md");
        const group = [1, 2].map((i) => vault.updateNote("a.md", (c) => c + `+e${i}`, { maxAttempts: 10 }));
        await tick();
        let pinnedApplied = 0;
        const pinnedCall = vault.updateNote("a.md", (c) => { pinnedApplied++; return c + "+pinned"; }, { expectedRevision: pinned, maxAttempts: 10 });
        const late = vault.updateNote("a.md", (c) => c + "+e3", { maxAttempts: 10 });
        await tick();
        await release();
        const [g1, g2] = await Promise.all(group);
        await assert.rejects(pinnedCall, (e: any) => e instanceof RevisionMismatchError && e.expected === pinned && e.current === g1.revision);
        // An unpinned edit issued after the pinned one still joins the queued group.
        const g3 = await late;
        assert.equal(pinnedApplied, 0, "a pin that no longer matches is refused before its edit runs");
        assert.deepEqual(new Set([g1.revision, g2.revision, g3.revision]), new Set([revOf("a.md")]));
        assert.equal(textOf("a.md"), "base+e1+e2+e3");
        assert.equal(puts(calls), 1, calls.join(", "));
    });

    it("every member of a group gets the text that was written with the revision", async () => {
        const { vault, seed, textOf, revOf } = stubVault();
        seed("a.md", "base");
        const release = holdLock(vault, "a.md");
        const pending = [1, 2, 3, 4].map((i) => vault.updateNote("a.md", (c) => c + `+e${i}`, { maxAttempts: 10 }));
        await tick();
        await release();
        const results = await Promise.all(pending);
        assert.equal(textOf("a.md"), "base+e1+e2+e3+e4");
        for (const r of results) {
            assert.equal(r.content, textOf("a.md"));
            assert.equal(r.revision, revOf("a.md"));
        }
    });

    for (const oversized of ["false", "throw"] as const) {
        it(`a group write CouchDB won't store (${oversized === "false" ? "answers false" : "throws"}) is retried one member at a time: only the edit too big on its own fails`, async () => {
            const { vault, calls, seed, textOf } = stubVault({ maxBytes: 100, oversized });
            seed("a.md", "base");
            const release = holdLock(vault, "a.md");
            const edits = ["+s1", "+s2", "+s3", "+" + "B".repeat(200), "+s4", "+s5", "+s6", "+s7"];
            const pending = edits.map((e) => vault.updateNote("a.md", (c) => c + e, { maxAttempts: 10 }));
            await tick();
            await release();
            const results = await Promise.allSettled(pending);
            assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
            assert.equal(textOf("a.md"), "base+s1+s2+s3+s4+s5+s6+s7");
            const big = (results[3] as PromiseRejectedResult).reason;
            assert.match(String(big?.message), oversized === "false" ? /CouchDB did not store the write to a\.md/ : /request entity too large/);
            // The last small edit's answer is the stored text and revision.
            assert.equal((results[7] as PromiseFulfilledResult<any>).value.content, textOf("a.md"));
            assert.equal(puts(calls), 1 + edits.length, calls.join(", "));
        });
    }

    it("a group put that threw after it was stored is not re-applied: the group is told, nothing is written twice", async () => {
        const { vault, calls, seed, beforePut, textOf } = stubVault();
        seed("a.md", "base");
        beforePut.push("storedThenThrow");
        const release = holdLock(vault, "a.md");
        const pending = [1, 2, 3].map((i) => vault.updateNote("a.md", (c) => c + `+e${i}`, { maxAttempts: 10 }));
        await tick();
        await release();
        const results = await Promise.allSettled(pending);
        assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected", "rejected"]);
        assert.equal(textOf("a.md"), "base+e1+e2+e3");
        assert.equal(puts(calls), 1, calls.join(", "));
    });

    it("a put that threw before anything was stored falls back too", async () => {
        const { vault, seed, beforePut, textOf } = stubVault();
        seed("a.md", "base");
        beforePut.push("throw");
        const release = holdLock(vault, "a.md");
        const pending = [1, 2, 3].map((i) => vault.updateNote("a.md", (c) => c + `+e${i}`, { maxAttempts: 10 }));
        await tick();
        await release();
        const results = await Promise.allSettled(pending);
        assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"]);
        assert.equal(textOf("a.md"), "base+e1+e2+e3");
    });
});
