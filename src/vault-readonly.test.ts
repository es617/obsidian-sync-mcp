import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readOnlyVault, READ_ONLY_MESSAGE } from "./vault-readonly.js";
import type { VaultBackend } from "./vault-backend.js";

function fakeBackend(withRemote = false) {
    const calls: string[] = [];
    const backend: VaultBackend = {
        init: async () => { calls.push("init"); },
        close: async () => { calls.push("close"); },
        readNote: async (p) => { calls.push(`read:${p}`); return "content"; },
        writeNote: async (p) => { calls.push(`write:${p}`); return true; },
        deleteNote: async (p) => { calls.push(`delete:${p}`); return true; },
        moveNote: async (f, t) => { calls.push(`move:${f}->${t}`); return true; },
        getMetadata: async (p) => { calls.push(`meta:${p}`); return null; },
        listNotes: async () => { calls.push("list"); return ["a.md"]; },
        listNotesWithMtime: async () => { calls.push("listMtime"); return [{ path: "a.md", mtime: 1 }]; },
    };
    if (withRemote) {
        backend.catchUp = async (since) => { calls.push(`catchUp:${since}`); return "42"; };
        backend.watchChanges = () => { calls.push("watch"); };
    }
    return { backend, calls };
}

describe("readOnlyVault", () => {
    it("rejects writeNote, deleteNote and moveNote without touching the backend", async () => {
        const { backend, calls } = fakeBackend();
        const ro = readOnlyVault(backend);
        await assert.rejects(ro.writeNote("a.md", "x"), { message: READ_ONLY_MESSAGE });
        await assert.rejects(ro.deleteNote("a.md"), { message: READ_ONLY_MESSAGE });
        await assert.rejects(ro.moveNote("a.md", "b.md"), { message: READ_ONLY_MESSAGE });
        assert.deepEqual(calls, []);
    });

    it("delegates reads, listing and lifecycle", async () => {
        const { backend, calls } = fakeBackend();
        const ro = readOnlyVault(backend);
        await ro.init();
        assert.equal(await ro.readNote("a.md"), "content");
        assert.equal(await ro.getMetadata("a.md"), null);
        assert.deepEqual(await ro.listNotes(), ["a.md"]);
        assert.deepEqual(await ro.listNotesWithMtime(), [{ path: "a.md", mtime: 1 }]);
        await ro.close();
        assert.deepEqual(calls, ["init", "read:a.md", "meta:a.md", "list", "listMtime", "close"]);
    });

    it("keeps catchUp and watchChanges when the backend has them", async () => {
        const { backend, calls } = fakeBackend(true);
        const ro = readOnlyVault(backend);
        assert.equal(await ro.catchUp!("0", () => {}), "42");
        ro.watchChanges!(() => {});
        assert.deepEqual(calls, ["catchUp:0", "watch"]);
    });

    it("leaves catchUp and watchChanges undefined when the backend lacks them", () => {
        const ro = readOnlyVault(fakeBackend(false).backend);
        assert.equal(ro.catchUp, undefined);
        assert.equal(ro.watchChanges, undefined);
    });
});
