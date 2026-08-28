import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startAfterSuccessfulRebuild } from "./index-lifecycle.js";

describe("index lifecycle", () => {
    it("starts the live watcher after a successful rebuild", async () => {
        let starts = 0;

        const started = await startAfterSuccessfulRebuild(Promise.resolve(), () => {
            starts++;
        });

        assert.equal(started, true);
        assert.equal(starts, 1);
    });

    it("does not start the live watcher after a failed rebuild", async () => {
        let starts = 0;

        const started = await startAfterSuccessfulRebuild(
            Promise.reject(new Error("catch-up failed")),
            () => {
                starts++;
            },
        );

        assert.equal(started, false);
        assert.equal(starts, 0);
    });

    it("does not hide watcher startup failures", async () => {
        await assert.rejects(
            startAfterSuccessfulRebuild(Promise.resolve(), () => {
                throw new Error("watcher failed");
            }),
            /watcher failed/,
        );
    });
});
