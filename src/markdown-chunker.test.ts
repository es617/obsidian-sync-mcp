import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown } from "./markdown-chunker.js";

describe("chunkMarkdown", () => {
    it("removes frontmatter and preserves heading breadcrumbs", () => {
        const chunks = chunkMarkdown(`---
tags: [private]
---
Preamble text.

# Recovery
Overview.

## Provider signals
Look at edge distance.`);

        assert.deepEqual(chunks, [
            { ordinal: 0, heading: "", breadcrumb: "", body: "Preamble text." },
            { ordinal: 1, heading: "Recovery", breadcrumb: "Recovery", body: "Overview." },
            {
                ordinal: 2,
                heading: "Provider signals",
                breadcrumb: "Recovery > Provider signals",
                body: "Look at edge distance.",
            },
        ]);
        assert.equal(chunks.some((chunk) => chunk.body.includes("private")), false);
    });

    it("splits very large sections without overlap", () => {
        const words = Array.from({ length: 1700 }, (_, index) => `word${index}`);
        const chunks = chunkMarkdown(`# Large\n\n${words.join(" ")}`);
        assert.equal(chunks.length, 3);
        assert.ok(chunks.every((chunk) => chunk.body.split(/\s+/).length <= 800));
        assert.equal(chunks.flatMap((chunk) => chunk.body.split(/\s+/)).length, 1700);
        assert.ok(chunks.every((chunk) => chunk.breadcrumb === "Large"));
    });
});
