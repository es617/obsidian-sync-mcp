import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWriteFolders, allowedActions, checkWrite, describeWriteScope, type WriteScope } from "./write-scope.js";

/** Allowed actions as a sorted array, for readable assertions. */
const allowed = (path: string, scope: WriteScope) => [...allowedActions(path, scope)].sort();
const ALL = ["create", "delete", "update"];
/** True when every write action is allowed (the old isPathWritable). */
const writable = (path: string, raw: string | null) => allowed(path, raw === null ? null : parseWriteFolders(raw)).length === 3;

test("parseWriteFolders: unset returns null (unrestricted)", () => {
    assert.equal(parseWriteFolders(undefined), null);
});

test("parseWriteFolders: empty or whitespace-only returns null", () => {
    assert.equal(parseWriteFolders(""), null);
    assert.equal(parseWriteFolders("  "), null);
    assert.equal(parseWriteFolders(","), null);
    assert.equal(parseWriteFolders(" , "), null);
});

test("parseWriteFolders: splits, trims, strips slashes; bare folders get every permission", () => {
    const folders = (raw: string) => parseWriteFolders(raw)!.map((r) => r.folder);
    assert.deepEqual(folders("MCP"), ["MCP"]);
    assert.deepEqual(folders("MCP, Inbox"), ["MCP", "Inbox"]);
    assert.deepEqual(folders("/MCP/, Inbox/"), ["MCP", "Inbox"]);
    assert.deepEqual(folders("projects/active"), ["projects/active"]);
    assert.deepEqual([...parseWriteFolders("MCP")![0].allow].sort(), ALL);
});

test("parseWriteFolders: permissions after ':' joined with '+'", () => {
    const [raw, notes] = parseWriteFolders("Raw:create, Notes : create + update")!;
    assert.deepEqual(raw, { folder: "Raw", allow: new Set(["create"]) });
    assert.deepEqual(notes, { folder: "Notes", allow: new Set(["create", "update"]) });
});

test("parseWriteFolders: '/' is the vault root", () => {
    assert.deepEqual(parseWriteFolders("/,Raw:create")!.map((r) => r.folder), ["", "Raw"]);
});

test("parseWriteFolders: rejects unknown permissions, empty folders and duplicates", () => {
    assert.throws(() => parseWriteFolders("Raw:creat"), /unknown permission 'creat' in 'Raw:creat'.*create, update, delete/);
    assert.throws(() => parseWriteFolders("Raw:read"), /unknown permission 'read'/);
    assert.throws(() => parseWriteFolders("Raw:"), /unknown permission ''/);
    assert.throws(() => parseWriteFolders("Raw:create+"), /unknown permission ''/);
    assert.throws(() => parseWriteFolders(":create"), /has no folder/);
    assert.throws(() => parseWriteFolders("MCP,MCP/:create"), /'MCP' is listed more than once/);
    assert.throws(() => parseWriteFolders("/,/"), /'\/' is listed more than once/);
});

test("null scope allows everything", () => {
    assert.deepEqual(allowed("anything/at/all.md", null), ALL);
});

test("allows paths inside a writable folder", () => {
    assert.equal(writable("MCP/note.md", "MCP,Inbox"), true);
    assert.equal(writable("MCP/deep/nested/note.md", "MCP,Inbox"), true);
    assert.equal(writable("Inbox/todo.md", "MCP,Inbox"), true);
});

test("denies paths outside writable folders", () => {
    assert.deepEqual(allowed("daily/2026-07-30.md", parseWriteFolders("MCP")), []);
    assert.deepEqual(allowed("root-note.md", parseWriteFolders("MCP")), []);
});

test("folder-boundary aware — no partial prefix match", () => {
    assert.equal(writable("MCP-private/note.md", "MCP"), false);
    assert.equal(writable("MCPx/note.md", "MCP"), false);
});

test("a root file named like the folder is not inside it", () => {
    assert.equal(writable("MCP", "MCP"), false);
    assert.equal(writable("MCP.md", "MCP"), false);
});

test("a case variant of a listed folder is not writable", () => {
    assert.equal(writable("mcp/note.md", "MCP"), false);
});

test("leading slashes are normalized", () => {
    assert.equal(writable("/MCP/note.md", "MCP"), true);
});

test("traversal segments are denied", () => {
    assert.equal(writable("MCP/../secret.md", "MCP"), false);
    assert.equal(writable("MCP/../../etc/passwd", "MCP"), false);
    assert.equal(writable("../MCP/note.md", "MCP"), false);
    // Windows resolves backslash traversal even after a valid prefix
    assert.equal(writable("MCP/..\\daily\\evil.md", "MCP"), false);
    assert.equal(writable("MCP\\..\\daily\\evil.md", "MCP"), false);
    assert.equal(writable("x/../y.md", "/"), false);
});

test("nested writable folder", () => {
    assert.equal(writable("projects/active/note.md", "projects/active"), true);
    assert.equal(writable("projects/archive/note.md", "projects/active"), false);
    assert.equal(writable("projects/note.md", "projects/active"), false);
});

test("per-folder permissions", () => {
    const scope = parseWriteFolders("MCP,Raw:create,Notes:create+update");
    assert.deepEqual(allowed("MCP/a.md", scope), ALL);
    assert.deepEqual(allowed("Raw/a.md", scope), ["create"]);
    assert.deepEqual(allowed("Notes/a.md", scope), ["create", "update"]);
});

test("the most specific folder wins, in both directions", () => {
    const scope = parseWriteFolders("Raw:create,Raw/scratch,/:create+update");
    assert.deepEqual(allowed("Raw/a.md", scope), ["create"]);
    assert.deepEqual(allowed("Raw/scratch/a.md", scope), ALL);
    assert.deepEqual(allowed("Raw/scratchy/a.md", scope), ["create"], "boundary-aware");
    assert.deepEqual(allowed("root.md", scope), ["create", "update"], "'/' covers root-level files");
    assert.deepEqual(allowed("Other/a.md", scope), ["create", "update"]);
});

test("a case variant can't escape a restricted folder", () => {
    // LiveSync vaults and macOS/Windows file systems treat raw/ and Raw/ as one folder.
    const scope = parseWriteFolders("/,Raw:create");
    assert.deepEqual(allowed("raw/a.md", scope), ["create"]);
    assert.deepEqual(allowed("RAW/sub/a.md", scope), ["create"]);
    assert.deepEqual(allowed("/raw/a.md", scope), ["create"]);
    // Unicode: an NFD-spelled folder name matches its NFC form.
    const accented = parseWriteFolders("/,Café:create");
    assert.deepEqual(allowed("café/a.md", accented), ["create"]);
});

test("checkWrite: null when allowed, a reason when not", () => {
    const scope = parseWriteFolders("MCP,Raw:create");
    assert.equal(checkWrite("Raw/a.md", "create", scope), null);
    assert.equal(checkWrite("MCP/a.md", "delete", scope), null);
    assert.equal(
        checkWrite("Raw/a.md", "update", scope),
        "Write access denied: Raw/ allows only create, so 'Raw/a.md' can't be changed.",
    );
    assert.match(checkWrite("Raw/a.md", "delete", scope)!, /can't be deleted or moved\.$/);
    assert.equal(
        checkWrite("daily/a.md", "create", scope),
        "Write access denied: 'daily/a.md' is outside the writable folders (MCP/, Raw/ (create only)).",
    );
    assert.match(checkWrite("MCP/../x.md", "create", scope)!, /outside the writable folders/);
});

test("describeWriteScope: empty when unrestricted; legend only with limited folders", () => {
    assert.equal(describeWriteScope(null), "");
    assert.equal(describeWriteScope(parseWriteFolders("MCP,Inbox")), " Writes are only allowed inside: MCP/, Inbox/.");
    const limited = describeWriteScope(parseWriteFolders("/,Raw:create,Notes:create+update"));
    assert.match(limited, /inside: \/, Raw\/ \(create only\), Notes\/ \(create\+update only\)\./);
    assert.match(limited, /create = add new files, update = change existing files, delete = delete or move files away/);
});
