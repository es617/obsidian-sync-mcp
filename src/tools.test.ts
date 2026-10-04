import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTools, READ_NOTE_MAX_RESULT_SIZE_CHARS, SEARCH_MAX_TERMS, SEARCH_MAX_TERM_LENGTH, cleanSearchTerms } from "./tools.js";

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

test("search_notes rejects more than SEARCH_MAX_TERMS terms at the schema", () => {
    const tool = captureTools().find((t) => t.name === "search_notes") as any;
    const terms = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    assert.equal(tool.parameters.safeParse({ terms: terms(SEARCH_MAX_TERMS) }).success, true);
    assert.equal(tool.parameters.safeParse({ terms: terms(SEARCH_MAX_TERMS + 1) }).success, false);
});

test("search_notes rejects a term longer than SEARCH_MAX_TERM_LENGTH at the schema", () => {
    const tool = captureTools().find((t) => t.name === "search_notes") as any;
    const term = (n: number) => "x".repeat(n);
    assert.equal(tool.parameters.safeParse({ terms: [term(SEARCH_MAX_TERM_LENGTH)] }).success, true);
    assert.equal(tool.parameters.safeParse({ terms: ["ok", term(SEARCH_MAX_TERM_LENGTH + 1)] }).success, false);
    assert.equal(tool.parameters.safeParse({ terms: [term(10_000)] }).success, false);
});

test("cleanSearchTerms cuts each term to SEARCH_MAX_TERM_LENGTH", () => {
    const clean = cleanSearchTerms([" " + "y".repeat(5_000_000) + " ", "short"]);
    assert.equal(clean.length, 2);
    assert.equal(clean[0].length, SEARCH_MAX_TERM_LENGTH);
    assert.equal(clean[1], "short");
});

test("cleanSearchTerms trims, drops empty terms and clamps to SEARCH_MAX_TERMS", () => {
    assert.deepEqual(cleanSearchTerms(undefined), []);
    assert.deepEqual(cleanSearchTerms([" a ", "", "  ", "b"]), ["a", "b"]);
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const clean = cleanSearchTerms(["", ...many]);
    assert.equal(clean.length, SEARCH_MAX_TERMS);
    assert.equal(clean[0], "t0", "empty terms are dropped before clamping");
});
