import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTools, READ_NOTE_MAX_RESULT_SIZE_CHARS } from "./tools.js";

function captureTools(): { name: string; _meta?: Record<string, unknown> }[] {
    const tools: { name: string; _meta?: Record<string, unknown> }[] = [];
    const server = { addTool: (tool: { name: string; _meta?: Record<string, unknown> }) => tools.push(tool) };
    registerTools(server as any, {} as any, {} as any, "vault");
    return tools;
}

test("read_note declares anthropic/maxResultSizeChars so Claude Code returns whole notes inline", () => {
    const readNote = captureTools().find((t) => t.name === "read_note");
    assert.ok(readNote, "read_note registered");
    assert.equal(readNote._meta?.["anthropic/maxResultSizeChars"], READ_NOTE_MAX_RESULT_SIZE_CHARS);
    assert.ok(READ_NOTE_MAX_RESULT_SIZE_CHARS > 50_000 && READ_NOTE_MAX_RESULT_SIZE_CHARS <= 500_000);
});

test("no other tool carries the annotation", () => {
    for (const tool of captureTools().filter((t) => t.name !== "read_note")) {
        assert.equal(tool._meta, undefined, `${tool.name} should not declare _meta`);
    }
});

test("search_notes is registered with a whole first sentence under 75 characters", () => {
    const tool = captureTools().find((t) => t.name === "search_notes") as any;
    assert.ok(tool, "search_notes registered");
    const firstLine = String(tool.description).split("\n")[0];
    assert.ok(firstLine.length < 75, `first line is ${firstLine.length} chars`);
    assert.ok(firstLine.endsWith("."), "first line ends with a period");
    assert.equal(tool._meta, undefined);
});
