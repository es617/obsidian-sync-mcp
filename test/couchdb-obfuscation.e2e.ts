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
import { computeKeyedId } from "../lib/livesync-commonlib/src/common/idDerivation.ts";

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
for (const db of ["obfvault", "plainvault", "keyedvault", "casevault"]) {
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

console.log("\nAll obfuscation-detection scenarios passed.");
process.exit(0);
