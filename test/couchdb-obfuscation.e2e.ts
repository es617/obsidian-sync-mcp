/**
 * E2E test for the COUCHDB_OBFUSCATE_PROPERTIES auto-detection (issues #4,
 * #10) against a real, throwaway CouchDB. Destructive: drops and recreates
 * its two test databases — never point it at a real vault.
 *
 * Run: npm run test:couchdb  (starts against localhost:5985 by default)
 *
 *   docker run -d --name couchdb-obf-test -p 5985:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
 *
 * Override with TEST_COUCHDB_URL / TEST_COUCHDB_USER / TEST_COUCHDB_PASSWORD.
 * (Runs via tsup bundling — plain tsx won't resolve the svelte/pouchdb stubs.)
 *
 * Seeds an obfuscated vault and a plain vault through the same
 * livesync-commonlib write path the Obsidian plugin uses, then reopens each
 * with mismatched settings to exercise detection, auto-correction, and the
 * missing-passphrase fail-fast.
 */
import assert from "node:assert/strict";
import { Vault } from "../src/vault.js";
import { AttachmentExistsError, AttachmentTooLargeError } from "../src/vault-backend.js";
import { computeKeyedId } from "../lib/livesync-commonlib/src/common/idDerivation.ts";
import { readContent } from "../lib/livesync-commonlib/src/common/utils.ts";
import { randomBytes } from "node:crypto";

const base = {
    couchdbUrl: process.env.TEST_COUCHDB_URL ?? "http://localhost:5985",
    couchdbUser: process.env.TEST_COUCHDB_USER ?? "admin",
    couchdbPassword: process.env.TEST_COUCHDB_PASSWORD ?? "test",
};
const passphrase = "banana123";

const NOTE_CYRILLIC = "Inbox/Тест.md";
const NOTE_DAILY = "Daily/2026-07-21.md";

function step(msg: string) {
    console.log(`\n=== ${msg} ===`);
}

const auth = {
    Authorization: "Basic " + Buffer.from(`${base.couchdbUser}:${base.couchdbPassword}`).toString("base64"),
};

async function rawAllDocIds(db: string): Promise<string[]> {
    const res = await fetch(`${base.couchdbUrl}/${db}/_all_docs`, { headers: auth });
    return ((await res.json()) as any).rows.map((r: any) => r.id);
}

// Reset databases so the harness is idempotent across runs.
for (const db of ["obfvault", "plainvault", "keyedvault", "casevault", "watchervault", "attachvault", "movevault"]) {
    await fetch(`${base.couchdbUrl}/${db}`, { method: "DELETE", headers: auth });
    const res = await fetch(`${base.couchdbUrl}/${db}`, { method: "PUT", headers: auth });
    if (!res.ok) throw new Error(`could not create ${db}: ${res.status}`);
}

// --- Seed: obfuscated vault (correct settings) ---
step("Seed obfvault with obfuscatePaths=true");
{
    const v = new Vault({ ...base, database: "obfvault", passphrase, obfuscatePaths: true });
    await v.init();
    assert.equal(await v.writeNote(NOTE_CYRILLIC, "# Тест\nprivet"), true);
    assert.equal(await v.writeNote(NOTE_DAILY, "daily entry"), true);
    assert.equal(await v.readNote(NOTE_CYRILLIC), "# Тест\nprivet");
    await v.close();
    console.log("seeded 2 notes, read-back OK");
}

// Confirm the raw _ids really are obfuscated (f: prefix)
step("Raw doc IDs in obfvault");
{
    const rows = await rawAllDocIds("obfvault");
    console.log(rows.join("\n"));
    const fileIds = rows.filter((id) => id.startsWith("f:"));
    assert.equal(fileIds.length, 2, "expected exactly 2 f:-prefixed file docs");
}

// --- Test 2: issue #10 repro — obfuscated vault, flag off ---
step("Test 2: open obfvault with obfuscatePaths=false (expect warning + auto-enable)");
{
    const v = new Vault({ ...base, database: "obfvault", passphrase, obfuscatePaths: false });
    await v.init();
    const content = await v.readNote(NOTE_CYRILLIC);
    assert.equal(content, "# Тест\nprivet", "read_note must resolve after auto-correction");
    const listed = await v.listNotes();
    assert.deepEqual(listed.sort(), [NOTE_DAILY, NOTE_CYRILLIC].sort());
    assert.equal(await v.writeNote("Inbox/written-under-wrong-flag.md", "hello"), true);
    await v.close();
    console.log("read_note + list_notes + write_note OK under corrected settings");
}

// The write from Test 2 must have produced an obfuscated doc (what LiveSync
// clients expect), not a plaintext-id doc they'd ignore (issue #4).
step("Test 2b: write under corrected settings produced an f: doc");
{
    const rows = await rawAllDocIds("obfvault");
    const fileIds = rows.filter((id) => id.startsWith("f:"));
    const plaintextIds = rows.filter((id) => id.includes(".md"));
    console.log(`f: docs: ${fileIds.length}, plaintext-path docs: ${plaintextIds.length}`);
    assert.equal(fileIds.length, 3, "expected 3 f:-prefixed file docs after write");
    assert.equal(plaintextIds.length, 0, "no plaintext-id file docs may exist");
}

// --- Seed: plain vault (E2EE on, obfuscation off) ---
step("Seed plainvault with obfuscatePaths=false");
{
    const v = new Vault({ ...base, database: "plainvault", passphrase, obfuscatePaths: false });
    await v.init();
    assert.equal(await v.writeNote(NOTE_DAILY, "plain vault daily"), true);
    assert.equal(await v.writeNote("Notes/hello.md", "world"), true);
    await v.close();
    console.log("seeded 2 notes");
}

// --- Test 3: reverse mismatch — plain vault, flag on ---
step("Test 3: open plainvault with obfuscatePaths=true (expect warning + auto-disable)");
{
    const v = new Vault({ ...base, database: "plainvault", passphrase, obfuscatePaths: true });
    await v.init();
    assert.equal(await v.readNote(NOTE_DAILY), "plain vault daily");
    assert.equal(await v.readNote("Notes/hello.md"), "world");
    await v.close();
    console.log("read_note OK under corrected settings");
}

// --- Test 4: obfuscated vault, no passphrase → fail fast ---
step("Test 4: open obfvault without passphrase (expect init to throw)");
{
    const v = new Vault({ ...base, database: "obfvault", passphrase: undefined, obfuscatePaths: false });
    await assert.rejects(
        () => v.init(),
        (err: Error) => err.message.includes("COUCHDB_PASSPHRASE"),
        "init must fail fast with a passphrase error",
    );
    console.log("init rejected with:", (await v.init().catch((e: Error) => e.message)));
}

// --- Control: matching settings produce no correction ---
step("Control: open obfvault with obfuscatePaths=true (expect NO warning)");
{
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); origWarn(...a); };
    const v = new Vault({ ...base, database: "obfvault", passphrase, obfuscatePaths: true });
    await v.init();
    console.warn = origWarn;
    assert.equal(await v.readNote(NOTE_CYRILLIC), "# Тест\nprivet");
    const mismatchWarnings = warnings.filter((w) => w.includes("COUCHDB_OBFUSCATE_PROPERTIES"));
    assert.equal(mismatchWarnings.length, 0, "no mismatch warning expected when settings match");
    await v.close();
    console.log("no warning, reads OK");
}

// --- Test 5: independent ID derivation (LiveSync 1.0.33+ v1 vault) (#47) ---
const ID_KEY_HEX = "0123456789abcdef".repeat(4); // 64-hex test key
const RECOVERY_CODE = `sls-id-v1:${ID_KEY_HEX}`;
const NOTE_KEYED = "Projects/Keyed Note.md";

step("Test 5: seed keyedvault with COUCHDB_ID_DERIVATION_KEY and read back");
{
    const v = new Vault({ ...base, database: "keyedvault", passphrase, obfuscatePaths: true, idDerivationKey: RECOVERY_CODE });
    await v.init();
    assert.equal(await v.writeNote(NOTE_KEYED, "# Keyed\nbody"), true);
    assert.equal(await v.readNote(NOTE_KEYED), "# Keyed\nbody", "read_note must resolve with the keyed scheme");
    await v.close();
    console.log("v1 write + read-back OK");
}

step("Test 5b: raw doc ID equals f: + computeKeyedId(document, lowercased path)");
{
    const rows = await rawAllDocIds("keyedvault");
    const expected = "f:" + (await computeKeyedId(ID_KEY_HEX, "document", NOTE_KEYED.toLowerCase()));
    assert.ok(rows.includes(expected), `expected keyed doc id ${expected} among ${rows.join(", ")}`);
    console.log("raw id matches the library's keyed derivation");
}

step("Test 5c: reopen with obfuscatePaths=false + key (reconcile keeps the key)");
{
    const v = new Vault({ ...base, database: "keyedvault", passphrase, obfuscatePaths: false, idDerivationKey: RECOVERY_CODE });
    await v.init();
    assert.equal(await v.readNote(NOTE_KEYED), "# Keyed\nbody", "read must resolve after obfuscation auto-correction with the key preserved");
    await v.close();
    console.log("key preserved across the reconcile rebuild");
}

step("Test 5d: reopen WITHOUT the key → fail fast naming the env var");
{
    const v = new Vault({ ...base, database: "keyedvault", passphrase, obfuscatePaths: true });
    await assert.rejects(
        () => v.init(),
        (err: Error) => err.message.includes("COUCHDB_ID_DERIVATION_KEY"),
        "init must fail fast and name COUCHDB_ID_DERIVATION_KEY",
    );
    console.log("init rejected without the key, naming the env var");
}

// --- Test 6: COUCHDB_CASE_SENSITIVE escape hatch (case-sensitive v0 vault) ---
const NOTE_CASE = "Inbox/CamelCase.md";

step("Test 6: seed casevault with caseSensitive=true (mixed-case obfuscated path)");
{
    const v = new Vault({ ...base, database: "casevault", passphrase, obfuscatePaths: true, caseSensitive: true });
    await v.init();
    assert.equal(await v.writeNote(NOTE_CASE, "# Camel\nbody"), true);
    assert.equal(await v.readNote(NOTE_CASE), "# Camel\nbody");
    await v.close();
    console.log("seeded a case-sensitive obfuscated note");
}

step("Test 6b: open with default case handling → fail fast naming COUCHDB_CASE_SENSITIVE");
{
    const v = new Vault({ ...base, database: "casevault", passphrase, obfuscatePaths: true });
    await assert.rejects(
        () => v.init(),
        (err: Error) => err.message.includes("COUCHDB_CASE_SENSITIVE"),
        "init must fail fast and name COUCHDB_CASE_SENSITIVE",
    );
    console.log("init rejected under default case handling, naming the env var");
}

step("Test 6c: open with COUCHDB_CASE_SENSITIVE=true → reads resolve");
{
    const v = new Vault({ ...base, database: "casevault", passphrase, obfuscatePaths: true, caseSensitive: true });
    await v.init();
    assert.equal(await v.readNote(NOTE_CASE), "# Camel\nbody", "read must resolve with matching case handling");
    await v.close();
    console.log("escape hatch works");
}

// --- Test 7: watcher resumes from the caught-up tip — no missed changes, no replay ---
// The startup fix defers the live watcher until the catch-up drains `_changes`
// to the live tip. This asserts the property that makes that safe: after
// catchUp, the watcher delivers a change written *after* the catch-up and
// replays none of the already-caught-up notes.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

step("Test 7: seed watchervault with 3 notes");
{
    const v = new Vault({ ...base, database: "watchervault", passphrase, obfuscatePaths: true });
    await v.init();
    for (const p of ["A.md", "sub/B.md", "sub/C.md"]) assert.equal(await v.writeNote(p, `body ${p}`), true);
    await v.close();
    console.log("seeded 3 notes");
}

step("Test 7b: catchUp drains to tip, then the watcher picks up a later write and replays nothing");
{
    const reader = new Vault({ ...base, database: "watchervault", passphrase, obfuscatePaths: true });
    await reader.init();

    const caughtUp: string[] = [];
    await reader.catchUp!("0", (path, content) => { if (content !== null) caughtUp.push(path); });
    assert.deepEqual(caughtUp.sort(), ["A.md", "sub/B.md", "sub/C.md"], "catchUp must drain all 3 notes to the tip");

    // A change that lands AFTER catchUp returned but BEFORE the watcher starts.
    const writer = new Vault({ ...base, database: "watchervault", passphrase, obfuscatePaths: true });
    await writer.init();
    assert.equal(await writer.writeNote("after/D.md", "written after catch-up"), true);

    const watched: string[] = [];
    reader.watchChanges!((path, content) => { if (content !== null) watched.push(path); });

    // Poll until the watcher delivers the post-catch-up write (or time out).
    for (let i = 0; i < 75 && !watched.includes("after/D.md"); i++) await sleep(200);

    assert.ok(watched.includes("after/D.md"), `watcher must deliver the post-catch-up write; saw ${JSON.stringify(watched)}`);
    const replayed = watched.filter((p) => caughtUp.includes(p));
    assert.deepEqual(replayed, [], `watcher must not replay already-caught-up notes; replayed ${JSON.stringify(replayed)}`);

    await reader.close();
    await writer.close();
    console.log("watcher resumed from the tip: delivered the new note, replayed none of the caught-up notes");
}

// --- Binary attachments ---
// Written through the same livesync-commonlib path as notes: must be stored as
// a binary ("newnote") entry, chunked and encrypted, and read back byte-exact by
// a fresh client — which is what an Obsidian device does when it syncs it.
step("Attachments: encrypted + obfuscated binary round-trip");
{
    const ATTACHMENT = "Attachments/shot.png";
    // ~3 MB of random bytes: incompressible and well past one chunk.
    const bytes = new Uint8Array(randomBytes(3 * 1024 * 1024 + 123));
    const writer = new Vault({ ...base, database: "attachvault", passphrase, obfuscatePaths: true });
    await writer.init();
    assert.equal(await writer.writeNote("Note.md", "![[Attachments/shot.png]]"), true);
    assert.equal(await writer.writeAttachment(ATTACHMENT, bytes), true);
    await writer.close();

    const reader = new Vault({ ...base, database: "attachvault", passphrase, obfuscatePaths: true });
    await reader.init();
    const info = await reader.getAttachmentInfo(ATTACHMENT);
    assert.equal(info?.size, bytes.byteLength);

    const entry: any = await (reader as any).manipulator.get(ATTACHMENT);
    assert.ok(entry, "attachment entry readable by a fresh client");
    assert.equal(entry.type, "newnote", "stored as a LiveSync binary entry");
    assert.ok(entry.children.length > 1, `split into chunks (got ${entry.children.length})`);
    const back = readContent(entry);
    assert.ok(back instanceof ArrayBuffer || ArrayBuffer.isView(back), "binary content");
    assert.ok(Buffer.from(back as ArrayBuffer).equals(Buffer.from(bytes)), "byte-exact round-trip");

    // The plaintext path never reaches CouchDB, and every chunk is encrypted.
    const ids = await rawAllDocIds("attachvault");
    assert.ok(!ids.some((id) => id.includes("shot.png")), "path is obfuscated in document ids");
    const rawDocs = ((await (await fetch(`${base.couchdbUrl}/attachvault/_all_docs?include_docs=true`, { headers: auth })).json()) as any)
        .rows.map((r: any) => r.doc);
    const leaves = rawDocs.filter((d: any) => d.type === "leaf");
    assert.ok(leaves.length >= entry.children.length, "chunks stored as leaf docs");
    assert.ok(leaves.every((d: any) => d.e_ === true && String(d.data).startsWith("%")), "every chunk is encrypted");

    // The note index ignores attachments.
    const caughtUp: string[] = [];
    await reader.catchUp!("0", (path, content) => { if (content !== null) caughtUp.push(path); });
    assert.deepEqual(caughtUp, ["Note.md"], "catchUp reports notes only");
    assert.deepEqual(await reader.listNotes(), ["Note.md"], "listNotes reports notes only");

    // With an attachment callback, catchUp reports the attachment from its
    // metadata doc alone: right size, and its chunks are never loaded.
    const manip = (reader as any).manipulator;
    const loaded: string[] = [];
    const origGetByMeta = manip.getByMeta.bind(manip);
    manip.getByMeta = (meta: any) => origGetByMeta(meta).then((d: any) => { loaded.push(d.path); return d; });
    const attSeen: Array<[string, number | null]> = [];
    await reader.catchUp!("0", () => {}, undefined, undefined, (path, info) => attSeen.push([path, info ? info.size : null]));
    assert.deepEqual(attSeen, [[ATTACHMENT, bytes.byteLength]], "catchUp reports the attachment with its size");
    assert.ok(!loaded.includes(ATTACHMENT), `attachment chunks were loaded: ${JSON.stringify(loaded)}`);

    // The live watcher reports attachment changes the same way.
    const watched: Array<[string, number | null]> = [];
    reader.watchChanges!(() => {}, (path, info) => watched.push([path, info ? info.size : null]));

    assert.equal(await reader.moveAttachment(ATTACHMENT, "Attachments/moved.png"), true);
    assert.equal(await reader.getAttachmentInfo(ATTACHMENT), null, "source gone after move");
    const moved: any = await (reader as any).manipulator.get("Attachments/moved.png");
    assert.ok(Buffer.from(readContent(moved) as ArrayBuffer).equals(Buffer.from(bytes)), "move preserves bytes");

    assert.equal(await reader.deleteAttachment("Attachments/moved.png"), true);
    assert.equal(await reader.getAttachmentInfo("Attachments/moved.png"), null, "deleted");

    const expected = [["Attachments/moved.png", bytes.byteLength], [ATTACHMENT, null], ["Attachments/moved.png", null]];
    for (let i = 0; i < 75 && watched.length < expected.length; i++) await sleep(200);
    assert.deepEqual(watched, expected, "watcher reports the move (new path, old path deleted) and the delete");
    assert.ok(!loaded.includes("Attachments/moved.png"), "watcher never loads attachment chunks");
    await assert.rejects(() => reader.writeAttachment("obsydian_livesync_version", bytes), /Invalid attachment path/);
    await reader.close();
    console.log(`attachment: ${entry.children.length} encrypted chunks, byte-exact after reopen, move and delete`);
}

// --- Overwrite protection and same-document moves ---
// Plain ids so the stored path is readable; LiveSync's default is
// case-insensitive, so ids are lowercased and Foo.png / foo.png are one doc.
step("Attachments/notes: atomic create, move onto itself, case-only rename");
{
    const v = new Vault({ ...base, database: "movevault", passphrase });
    await v.init();
    const a = new Uint8Array(randomBytes(4096));
    const b = new Uint8Array(randomBytes(4096));

    // Two concurrent creates of one path: exactly one wins, the other is refused.
    const results = await Promise.allSettled([v.writeAttachment("A/race.png", a), v.writeAttachment("A/race.png", b)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "one create wins");
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(lost.reason instanceof AttachmentExistsError, String(lost.reason));
    const winner = results[0].status === "fulfilled" ? a : b;
    const stored: any = await (v as any).manipulator.get("A/race.png");
    assert.ok(Buffer.from(readContent(stored) as ArrayBuffer).equals(Buffer.from(winner)), "the winner's bytes are stored");
    await assert.rejects(() => v.writeAttachment("A/race.png", b), AttachmentExistsError);
    assert.equal(await v.writeAttachment("A/race.png", b, { overwrite: true }), true);

    // Moving onto an existing file needs overwrite; refusing keeps both files.
    assert.equal(await v.writeAttachment("A/other.png", a), true);
    await assert.rejects(() => v.moveAttachment("A/race.png", "A/other.png"), AttachmentExistsError);
    assert.ok(await v.getAttachmentInfo("A/race.png"), "source kept after a refused move");
    assert.ok(await v.getAttachmentInfo("A/other.png"), "destination kept after a refused move");

    // Moving copies the bytes here, so a file over maxBytes is refused from
    // its metadata, before any chunk is loaded, and stays where it was.
    const manipTL = (v as any).manipulator;
    const fullGets: string[] = [];
    const origGet = manipTL.get.bind(manipTL);
    manipTL.get = (p: string, metaOnly?: boolean) => { if (!metaOnly) fullGets.push(p); return origGet(p, metaOnly); };
    await assert.rejects(() => v.moveAttachment("A/race.png", "A/big-moved.png", { maxBytes: 100 }), AttachmentTooLargeError);
    manipTL.get = origGet;
    assert.deepEqual(fullGets, [], "a refused move loads no chunks");
    assert.ok(await v.getAttachmentInfo("A/race.png"), "source kept after a refused move");
    assert.equal(await v.getAttachmentInfo("A/big-moved.png"), null, "nothing written");

    // Onto itself, with overwrite: the file must survive.
    assert.equal(await v.moveAttachment("A/other.png", "A/other.png", { overwrite: true }), true);
    assert.equal((await v.getAttachmentInfo("A/other.png"))?.size, a.byteLength, "moving onto itself keeps the file");

    // Case-only rename maps to the same doc: the file survives under the new name.
    assert.equal(await v.moveAttachment("A/other.png", "A/Other.png"), true);
    const renamed: any = await (v as any).manipulator.get("A/Other.png");
    assert.ok(renamed && !renamed.deleted, "file survives a case-only rename");
    assert.equal(renamed.path, "A/Other.png", "stored path takes the new case");
    assert.ok(Buffer.from(readContent(renamed) as ArrayBuffer).equals(Buffer.from(a)), "bytes intact after the rename");

    // Same for notes.
    assert.equal(await v.writeNote("N/Self.md", "keep me"), true);
    assert.equal(await v.moveNote("N/Self.md", "N/Self.md"), true);
    assert.equal(await v.readNote("N/Self.md"), "keep me", "moving a note onto itself keeps it");
    assert.equal(await v.moveNote("N/Self.md", "N/self.md"), true);
    assert.equal(await v.readNote("N/self.md"), "keep me", "note survives a case-only rename");
    assert.ok((await v.listNotes()).includes("N/self.md"), "listed under the new case");
    assert.ok(!(await v.listNotes()).includes("N/Self.md"), "old case gone");
    await v.close();
    console.log("atomic create, refused overwrite on move, self-move and case-only renames keep the file");
}

console.log("\nAll obfuscation-detection scenarios passed.");
process.exit(0);
