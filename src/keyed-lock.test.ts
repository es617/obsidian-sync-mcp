import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeyedLock } from "./keyed-lock.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("KeyedLock", () => {
    it("runs holders of the same key one at a time, in order", async () => {
        const lock = new KeyedLock();
        const log: string[] = [];
        const job = (name: string) => lock.run(["k"], async () => {
            log.push(`${name} start`);
            await tick();
            log.push(`${name} end`);
        });
        await Promise.all([job("a"), job("b"), job("c")]);
        assert.deepEqual(log, ["a start", "a end", "b start", "b end", "c start", "c end"]);
        assert.equal(lock.size, 0, "entries are dropped once idle");
    });

    it("lets different keys run concurrently", async () => {
        const lock = new KeyedLock();
        let running = 0;
        let peak = 0;
        const job = (key: string) => lock.run([key], async () => {
            peak = Math.max(peak, ++running);
            await tick();
            running--;
        });
        await Promise.all([job("a"), job("b")]);
        assert.equal(peak, 2);
    });

    it("does not deadlock two holders that take the same keys in opposite order", async () => {
        const lock = new KeyedLock();
        const done: string[] = [];
        await Promise.all([
            lock.run(["x", "y"], async () => { await tick(); done.push("xy"); }),
            lock.run(["y", "x"], async () => { await tick(); done.push("yx"); }),
        ]);
        assert.deepEqual(done.sort(), ["xy", "yx"]);
    });

    it("accepts a repeated key and releases after a throw", async () => {
        const lock = new KeyedLock();
        await assert.rejects(lock.run(["k", "k"], async () => { throw new Error("boom"); }), /boom/);
        assert.equal(await lock.run(["k"], async () => 42), 42);
        assert.equal(lock.size, 0);
    });
});
