/**
 * Full smoke test: real CouchDB + the built server (dist/main.js) over MCP HTTP,
 * across vault configurations. Destructive: drops and recreates smoke_* databases.
 *
 *   docker run -d --name couchdb-smoke -p 5985:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
 *   npm run test:smoke   (builds the server, then runs this against localhost:5985)
 *
 * Each vault is seeded through livesync-commonlib (the write path the LiveSync
 * plugin uses) acting as a "device", then the server is started with matching
 * env, driven as an MCP client, and its writes are read back by the device.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Vault } from "../src/vault.js";
import { DirectFileManipulator } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import { createTextBlob, readContent, getDocData } from "../lib/livesync-commonlib/src/common/utils.ts";
import { clearHandlers } from "../lib/livesync-commonlib/src/replication/SyncParamsHandler.ts";

const COUCH = process.env.TEST_COUCHDB_URL ?? "http://localhost:5985";
const USER = "admin";
const PASS = "test";
const auth = { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64") };
const PASSPHRASE = "smoke-pass-123";
const ID_HEX = randomBytes(32).toString("hex");
const RECOVERY = `sls-id-v1:${ID_HEX}`;
const NFD = "Café".normalize("NFD");
const NFC = "Café".normalize("NFC");

type Device = {
    passphrase?: string;
    obfuscate?: boolean;
    idKey?: boolean;
    nfc: boolean;
    caseSensitive?: boolean;
};

let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`);
        console.log(`  ✗ ${name}\n      ${(err as Error).message.split("\n").join("\n      ")}`);
    }
}

async function resetDb(db: string) {
    await fetch(`${COUCH}/${db}`, { method: "DELETE", headers: auth });
    const res = await fetch(`${COUCH}/${db}`, { method: "PUT", headers: auth });
    if (!res.ok) throw new Error(`create ${db}: ${res.status}`);
}

async function versionFeatures(db: string): Promise<string[]> {
    const res = await fetch(`${COUCH}/${db}/obsydian_livesync_version`, { headers: auth });
    return res.ok ? (((await res.json()) as any).used_features ?? []) : [];
}

/** A LiveSync "device": a DirectFileManipulator with the device's settings. */
async function openDevice(db: string, d: Device): Promise<DirectFileManipulator> {
    clearHandlers();
    const opts = (Vault as any).buildOptions(
        { couchdbUrl: COUCH, couchdbUser: USER, couchdbPassword: PASS, database: db, passphrase: d.passphrase, caseSensitive: d.caseSensitive },
        !!d.obfuscate,
        d.idKey ? ID_HEX : undefined,
        d.nfc ? 1 : 0,
    );
    const m = new DirectFileManipulator(opts);
    await m.ready.promise;
    return m;
}
async function closeDevice(m: DirectFileManipulator) {
    m.endWatch();
    try { await m.liveSyncLocalDB.managers.teardownManagers(); } catch { /* not created */ }
    await m.close();
}
async function devicePut(m: DirectFileManipulator, path: string, text: string) {
    clearHandlers();
    await m.put(path, createTextBlob(text), { ctime: Date.now(), mtime: Date.now() }, "plain");
}
async function deviceRead(m: DirectFileManipulator, path: string): Promise<string | null> {
    clearHandlers();
    const e: any = await m.get(path as any);
    if (!e || e.deleted || e._deleted) return null;
    return getDocData(e.data);
}

// --- server process ---
let nextPort = 18800;
type Server = { proc: ChildProcess; port: number; log: () => string; dataDir: string };

function startServer(env: Record<string, string>): Promise<Server> {
    const port = nextPort++;
    const dataDir = mkdtempSync(join(tmpdir(), "smoke-data-"));
    let out = "";
    const proc = spawn("node", ["dist/main.js"], {
        env: { PATH: process.env.PATH!, HOME: dataDir, DATA_DIR: dataDir, PORT: String(port), HOST: "127.0.0.1", COUCHDB_URL: COUCH, COUCHDB_USER: USER, COUCHDB_PASSWORD: PASS, VAULT_NAME: "Smoke", BASE_URL: `http://127.0.0.1:${port}`, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout!.on("data", (b) => (out += b));
    proc.stderr!.on("data", (b) => (out += b));
    const server = { proc, port, log: () => out, dataDir };
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`server did not become ready:\n${out}`)), 60_000);
        const poll = setInterval(() => {
            if (/listening on port/.test(out) && /Search index (built|synced|up to date)/.test(out)) {
                clearInterval(poll); clearTimeout(t); resolve(server);
            }
        }, 100);
        proc.on("exit", (code) => { clearInterval(poll); clearTimeout(t); reject(Object.assign(new Error(`server exited (${code}):\n${out}`), { exitCode: code, output: out })); });
    });
}
async function stopServer(s: Server) {
    if (s.proc.exitCode === null) {
        const exited = new Promise((r) => s.proc.once("exit", r));
        s.proc.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        if (s.proc.exitCode === null) s.proc.kill("SIGKILL");
    }
    s.proc.removeAllListeners("exit");
    rmSync(s.dataDir, { recursive: true, force: true });
}
/** Start a server that is expected to fail; returns its exit code and output. */
async function startExpectingFailure(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
    try {
        const s = await startServer(env);
        await stopServer(s);
        return { code: 0, output: s.log() };
    } catch (err: any) {
        return { code: err.exitCode ?? null, output: err.output ?? err.message };
    }
}

async function connect(s: Server, token?: string): Promise<Client> {
    const client = new Client({ name: "smoke", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), {
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
    await client.connect(transport);
    return client;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const r: any = await c.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((p: any) => p.text ?? "").join("\n");
    if (r.isError) throw new Error(`${name} error: ${text}`);
    return text;
}
async function eventually(fn: () => Promise<boolean>, what: string, ms = 15_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for ${what}`);
}

function serverEnv(d: Device & { db?: string }, extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    if (d.db) env.COUCHDB_DATABASE = d.db;
    if (d.passphrase) env.COUCHDB_PASSPHRASE = d.passphrase;
    if (d.obfuscate) env.COUCHDB_OBFUSCATE_PROPERTIES = "true";
    if (d.idKey) env.COUCHDB_ID_DERIVATION_KEY = RECOVERY;
    if (d.caseSensitive) env.COUCHDB_CASE_SENSITIVE = "true";
    return { ...env, ...extra };
}

const SEED: Record<string, string> = {
    "Inbox/Hello.md": "---\ntags: [smoke]\n---\n# Hello\nThe quick zebrafish. Links to [[Projects/Plan]].\n",
    "Projects/Plan.md": "# Plan\nRoadmap with #planning tag.\n",
    "Inbox/Тест.md": "Кириллица note body.\n",
    [`Notes/${NFD}.md`]: "accented note, stored NFD as macOS would.\n",
};

/** The standard tool workout against a running server. */
async function workout(label: string, db: string, d: Device, s: Server) {
    const c = await connect(s);
    const dev = await openDevice(db, d);
    try {
        await check(`${label}: list_notes shows seeded notes`, async () => {
            const out = await call(c, "list_notes", { limit: 100 });
            for (const p of Object.keys(SEED)) assert.ok(out.normalize("NFC").includes(p.normalize("NFC")), `missing ${p} in:\n${out}`);
        });
        await check(`${label}: read_note (ASCII, Cyrillic, accented)`, async () => {
            assert.match(await call(c, "read_note", { path: "Inbox/Hello.md" }), /quick zebrafish/);
            assert.match(await call(c, "read_note", { path: "Inbox/Тест.md" }), /Кириллица/);
            assert.match(await call(c, "read_note", { path: `Notes/${NFD}.md` }), /accented note/);
        });
        if (d.nfc) {
            await check(`${label}: NFC spelling finds the NFD-stored note`, async () => {
                assert.match(await call(c, "read_note", { path: `Notes/${NFC}.md` }), /accented note/);
            });
        }
        await check(`${label}: search_notes / list_tags / list_folders / metadata`, async () => {
            assert.match(await call(c, "search_notes", { terms: ["zebrafish"] }), /Inbox\/Hello\.md/);
            assert.match(await call(c, "search_notes", { terms: ["Кириллица"] }), /Тест/);
            const tags = await call(c, "list_tags");
            assert.match(tags, /smoke/); assert.match(tags, /planning/);
            assert.match(await call(c, "list_folders"), /Projects/);
            assert.match(await call(c, "get_note_metadata", { path: "Projects/Plan.md" }), /Inbox\/Hello/);
        });
        await check(`${label}: write_note → readable by the LiveSync device`, async () => {
            await call(c, "write_note", { path: "Agent/new.md", content: "written by agent" });
            assert.equal(await deviceRead(dev, "Agent/new.md"), "written by agent");
        });
        await check(`${label}: edit_note append + replace`, async () => {
            await call(c, "edit_note", { path: "Agent/new.md", content: "more" });
            await call(c, "edit_note", { path: "Agent/new.md", operation: "replace", old_text: "agent", content: "the agent" });
            assert.equal(await deviceRead(dev, "Agent/new.md"), "written by the agent\nmore");
        });
        await check(`${label}: move_note + case-only rename`, async () => {
            await call(c, "move_note", { from: "Agent/new.md", to: "Agent/moved.md" });
            assert.equal(await deviceRead(dev, "Agent/new.md"), null);
            assert.equal(await deviceRead(dev, "Agent/moved.md"), "written by the agent\nmore");
            if (!d.caseSensitive) {
                await call(c, "move_note", { from: "Agent/moved.md", to: "Agent/Moved.md" });
                assert.match(await call(c, "read_note", { path: "Agent/Moved.md" }), /written by the agent/);
                assert.match(await call(c, "list_notes", { limit: 100 }), /Agent\/Moved\.md/);
            }
        });
        await check(`${label}: delete_note`, async () => {
            const p = d.caseSensitive ? "Agent/moved.md" : "Agent/Moved.md";
            await call(c, "delete_note", { path: p });
            assert.equal(await deviceRead(dev, p), null);
            assert.doesNotMatch(await call(c, "list_notes", { limit: 100 }), /Agent\//);
        });
        await check(`${label}: write an accented name, device finds it`, async () => {
            await call(c, "write_note", { path: `Agent/${NFC}-agent.md`, content: "nfc name" });
            assert.equal(await deviceRead(dev, `Agent/${NFC}-agent.md`), "nfc name");
            if (d.nfc) assert.equal(await deviceRead(dev, `Agent/${NFD}-agent.md`), "nfc name", "NFD lookup on NFC vault");
        });
        await check(`${label}: live sync — device edit and delete reach the server`, async () => {
            await devicePut(dev, "Live/from-device.md", "hello from device kiwifruit");
            await eventually(async () => /Live\/from-device\.md/.test(await call(c, "list_notes", { limit: 100 })), "device note in list_notes");
            await eventually(async () => /from-device/.test(await call(c, "search_notes", { terms: ["kiwifruit"] })), "device note searchable");
            clearHandlers();
            await dev.delete("Live/from-device.md");
            await eventually(async () => !/Live\/from-device\.md/.test(await call(c, "list_notes", { limit: 100 })), "device delete reflected");
        });
    } finally {
        await c.close().catch(() => {});
        await closeDevice(dev);
    }
}

// ---------------------------------------------------------------------------
const MATRIX: Array<{ label: string; d: Device }> = [
    { label: "plain / legacy", d: { nfc: false } },
    { label: "plain / NFC (issue #58)", d: { nfc: true } },
    { label: "E2EE / legacy", d: { passphrase: PASSPHRASE, nfc: false } },
    { label: "E2EE / NFC", d: { passphrase: PASSPHRASE, nfc: true } },
    { label: "E2EE+obfuscated / legacy", d: { passphrase: PASSPHRASE, obfuscate: true, nfc: false } },
    { label: "E2EE+obfuscated / NFC", d: { passphrase: PASSPHRASE, obfuscate: true, nfc: true } },
    { label: "E2EE+obfuscated+ID key / legacy", d: { passphrase: PASSPHRASE, obfuscate: true, idKey: true, nfc: false } },
    { label: "E2EE+obfuscated+ID key / NFC (LiveSync 1.0.49+ full)", d: { passphrase: PASSPHRASE, obfuscate: true, idKey: true, nfc: true } },
    { label: "E2EE+obfuscated / NFC / case-sensitive", d: { passphrase: PASSPHRASE, obfuscate: true, nfc: true, caseSensitive: true } },
];

let i = 0;
for (const { label, d } of MATRIX) {
    const db = `smoke_m${i++}`;
    console.log(`\n=== ${label} (${db}) ===`);
    await resetDb(db);
    const dev = await openDevice(db, d);
    for (const [p, t] of Object.entries(SEED)) await devicePut(dev, p, t);
    await closeDevice(dev);
    await check(`${label}: database declares the expected path identity`, async () => {
        assert.equal((await versionFeatures(db)).includes("nfc-path-identity-v1"), d.nfc);
    });
    let s: Server | undefined;
    await check(`${label}: server starts`, async () => { s = await startServer(serverEnv({ ...d, db })); });
    if (!s) continue;
    try {
        await check(`${label}: startup log reports path identity`, async () => {
            if (d.nfc) assert.match(s!.log(), /Unicode NFC path identity/);
            else assert.doesNotMatch(s!.log(), /NFC path identity/);
        });
        await workout(label, db, d, s);
    } finally {
        await stopServer(s);
    }
}

// --- Config auto-correction and refusals -----------------------------------
console.log("\n=== Startup configuration handling ===");
{
    const db = "smoke_m7"; // E2EE+obfuscated+ID key / NFC
    const d = { ...MATRIX[7].d, db };
    await check("obfuscation flag missing → auto-enabled with a warning, still works", async () => {
        const s = await startServer(serverEnv(d, { COUCHDB_OBFUSCATE_PROPERTIES: "false" }));
        try {
            assert.match(s.log(), /Enabling path obfuscation automatically/);
            const c = await connect(s);
            assert.match(await call(c, "read_note", { path: "Inbox/Hello.md" }), /zebrafish/);
            await c.close();
        } finally { await stopServer(s); }
    });
    await check("ID key missing on a keyed vault → refuses with recovery-code guidance", async () => {
        const env = serverEnv(d); delete env.COUCHDB_ID_DERIVATION_KEY;
        const r = await startExpectingFailure(env);
        assert.notEqual(r.code, 0); assert.match(r.output, /COUCHDB_ID_DERIVATION_KEY/);
    });
    await check("wrong passphrase → refuses to start", async () => {
        const r = await startExpectingFailure(serverEnv(d, { COUCHDB_PASSPHRASE: "wrong" }));
        assert.notEqual(r.code, 0, r.output);
    });
    await check("COUCHDB_PATH_NORMALIZATION=legacy on an NFC vault → refuses with guidance", async () => {
        const r = await startExpectingFailure(serverEnv(d, { COUCHDB_PATH_NORMALIZATION: "legacy" }));
        assert.notEqual(r.code, 0); assert.match(r.output, /uses nfc path identity/);
    });
    await check("COUCHDB_PATH_NORMALIZATION=nfc on a legacy vault → refuses", async () => {
        const r = await startExpectingFailure(serverEnv(MATRIX[0].d, { COUCHDB_DATABASE: "smoke_m0", COUCHDB_PATH_NORMALIZATION: "nfc" }));
        assert.notEqual(r.code, 0); assert.match(r.output, /uses legacy path identity/);
    });
    await check("COUCHDB_PATH_NORMALIZATION=bogus → refuses", async () => {
        const r = await startExpectingFailure({ COUCHDB_PATH_NORMALIZATION: "bogus" });
        assert.notEqual(r.code, 0); assert.match(r.output, /must be "auto", "nfc" or "legacy"/);
    });
    await check("missing database → refuses, does not create it", async () => {
        const r = await startExpectingFailure({ COUCHDB_DATABASE: "smoke_does_not_exist" });
        assert.notEqual(r.code, 0); assert.match(r.output, /does not exist/);
        assert.equal((await fetch(`${COUCH}/smoke_does_not_exist`, { headers: auth })).status, 404);
    });
}

// --- Empty databases: who writes first -------------------------------------
console.log("\n=== Empty database, server writes first ===");
for (const mode of ["auto", "legacy"] as const) {
    const db = `smoke_empty_${mode}`;
    await resetDb(db);
    const expectNfc = mode === "auto";
    await check(`${mode}: server initialises the vault, then a matching LiveSync device reads it`, async () => {
        const s = await startServer(serverEnv({ passphrase: PASSPHRASE, nfc: expectNfc }, { COUCHDB_DATABASE: db, ...(mode === "legacy" ? { COUCHDB_PATH_NORMALIZATION: "legacy" } : {}) }));
        try {
            if (expectNfc) assert.match(s.log(), /Empty database: using Unicode NFC/);
            const c = await connect(s);
            await call(c, "write_note", { path: "First/note.md", content: "server wrote first" });
            await c.close();
        } finally { await stopServer(s); }
        assert.equal((await versionFeatures(db)).includes("nfc-path-identity-v1"), expectNfc);
        const dev = await openDevice(db, { passphrase: PASSPHRASE, nfc: expectNfc });
        try { assert.equal(await deviceRead(dev, "First/note.md"), "server wrote first"); } finally { await closeDevice(dev); }
        // A device with the other identity is refused, as LiveSync would be.
        clearHandlers();
        const other = new DirectFileManipulator((Vault as any).buildOptions(
            { couchdbUrl: COUCH, couchdbUser: USER, couchdbPassword: PASS, database: db, passphrase: PASSPHRASE }, false, undefined, expectNfc ? 0 : 1));
        await assert.rejects(other.ready.promise, /path identity|not compatible/);
        await other.close().catch(() => {});
    });
}

// --- Server modes: auth, read-only, write folders, attachments -------------
console.log("\n=== Server modes (on E2EE+obfuscated+ID key / NFC) ===");
{
    const db = "smoke_m7";
    const d = { ...MATRIX[7].d, db };
    await check("MCP_AUTH_TOKEN: no token → 401, bearer token → works", async () => {
        const s = await startServer(serverEnv(d, { COUCHDB_DATABASE: db, MCP_AUTH_TOKEN: "s3cret-token" }));
        try {
            const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } }) });
            assert.equal(res.status, 401);
            await assert.rejects(connect(s, "wrong-token"));
            const c = await connect(s, "s3cret-token");
            assert.match(await call(c, "read_note", { path: "Inbox/Hello.md" }), /zebrafish/);
            await c.close();
        } finally { await stopServer(s); }
    });
    await check("READ_ONLY=true: write tools hidden, reads work", async () => {
        const s = await startServer(serverEnv(d, { COUCHDB_DATABASE: db, READ_ONLY: "true" }));
        try {
            const c = await connect(s);
            const names = (await c.listTools()).tools.map((t) => t.name);
            for (const w of ["write_note", "edit_note", "delete_note", "move_note"]) assert.ok(!names.includes(w), `${w} exposed`);
            assert.match(await call(c, "read_note", { path: "Projects/Plan.md" }), /Roadmap/);
            await c.close();
        } finally { await stopServer(s); }
    });
    await check("WRITE_FOLDERS=Agent: writes inside allowed, outside refused", async () => {
        const s = await startServer(serverEnv(d, { COUCHDB_DATABASE: db, WRITE_FOLDERS: "Agent" }));
        const dev = await openDevice(db, d);
        try {
            const c = await connect(s);
            await call(c, "write_note", { path: "Agent/ok.md", content: "allowed" });
            assert.equal(await deviceRead(dev, "Agent/ok.md"), "allowed");
            const denied = await call(c, "write_note", { path: "Projects/nope.md", content: "x" }).catch((e) => e.message);
            assert.match(denied, /not allowed|outside|WRITE_FOLDERS|denied|read-only/i);
            assert.equal(await deviceRead(dev, "Projects/nope.md"), null);
            await c.close();
        } finally { await stopServer(s); await closeDevice(dev); }
    });
    await check("WRITE_FOLDERS=/,Raw:create,Notes:create+update: per-folder permissions, case variants, uploads", async () => {
        const s = await startServer(serverEnv(d, { COUCHDB_DATABASE: db, WRITE_FOLDERS: "/,Raw:create,Notes:create+update", ATTACHMENTS_ENABLED: "true" }));
        const dev = await openDevice(db, d);
        try {
            assert.match(s.log(), /WRITE_FOLDERS: writes restricted to \/, Raw\/ \(create only\), Notes\/ \(create\+update only\)\./);
            const c = await connect(s);
            // Raw: create only. New notes land; nothing existing can change.
            assert.match(await call(c, "write_note", { path: "Raw/once.md", content: "original" }), /Note saved/);
            assert.match(await call(c, "write_note", { path: "Raw/once.md", content: "changed" }), /allows only create.*already exists/);
            // A case variant is the same document on this (case-insensitive) vault, and gets create only.
            assert.match(await call(c, "write_note", { path: "raw/ONCE.md", content: "changed" }), /allows only create.*already exists/);
            assert.match(await call(c, "edit_note", { path: "Raw/once.md", content: "more" }), /can't be changed/);
            assert.match(await call(c, "delete_note", { path: "Raw/once.md" }), /can't be deleted or moved/);
            assert.match(await call(c, "move_note", { from: "Raw/once.md", to: "Agent/once.md" }), /can't be deleted or moved/);
            assert.equal(await deviceRead(dev, "Raw/once.md"), "original");
            // Moving in is a create; onto an existing note is refused.
            await call(c, "write_note", { path: "Agent/in.md", content: "incoming" });
            await call(c, "write_note", { path: "Agent/clash.md", content: "clash" });
            assert.match(await call(c, "move_note", { from: "Agent/clash.md", to: "Raw/once.md" }), /A note already exists at Raw\/once\.md/);
            assert.match(await call(c, "move_note", { from: "Agent/in.md", to: "Raw/in.md" }), /Moved/);
            assert.equal(await deviceRead(dev, "Raw/in.md"), "incoming");
            assert.equal(await deviceRead(dev, "Agent/in.md"), null);
            assert.equal(await deviceRead(dev, "Raw/once.md"), "original");
            // Notes: create+update, no delete.
            await call(c, "write_note", { path: "Notes/n.md", content: "v1" });
            await call(c, "write_note", { path: "Notes/n.md", content: "v2" });
            await call(c, "edit_note", { path: "Notes/n.md", content: "v3" });
            assert.match(await call(c, "delete_note", { path: "Notes/n.md" }), /allows only create\+update/);
            assert.equal(await deviceRead(dev, "Notes/n.md"), "v2\nv3");
            // Upload URL into Raw: a new file works, a second URL for the same path gets 409, overwrite is refused up front.
            const urlOf = (out: string) => out.match(/https?:\/\/\S+\/attachments\/upload\/[^\s'"]+/)![0];
            const first = urlOf(await call(c, "create_attachment_upload", { path: "Raw/up.png" }));
            const second = urlOf(await call(c, "create_attachment_upload", { path: "Raw/up.png" }));
            assert.equal((await fetch(first, { method: "PUT", body: new Uint8Array([1, 2, 3]) })).status, 201);
            assert.equal((await fetch(second, { method: "PUT", body: new Uint8Array([9]) })).status, 409);
            assert.match(await call(c, "create_attachment_upload", { path: "Raw/up.png" }), /already exists: Raw\/up\.png\. Choose another path\./);
            assert.match(await call(c, "create_attachment_upload", { path: "Raw/up.png", overwrite: true }), /can't be changed/);
            assert.match(await call(c, "delete_attachment", { path: "Raw/up.png" }), /can't be deleted or moved/);
            clearHandlers();
            const got: any = await dev.get("Raw/up.png" as any);
            assert.ok(Buffer.from(readContent(got) as ArrayBuffer).equals(Buffer.from([1, 2, 3])), "the first upload's bytes are kept");
            await call(c, "delete_note", { path: "Agent/clash.md" });
            await c.close();
        } finally { await stopServer(s); await closeDevice(dev); }
    });
    await check("WRITE_FOLDERS with an unknown permission → refuses to start", async () => {
        const r = await startExpectingFailure(serverEnv(d, { COUCHDB_DATABASE: db, WRITE_FOLDERS: "Raw:creat" }));
        assert.equal(r.code, 1, r.output); assert.match(r.output, /unknown permission 'creat'/);
    });
    await check("ATTACHMENTS_ENABLED: base64 write, upload URL PUT, list, move, delete; bytes intact on device", async () => {
        const s = await startServer(serverEnv(d, { COUCHDB_DATABASE: db, ATTACHMENTS_ENABLED: "true" }));
        const dev = await openDevice(db, d);
        try {
            const c = await connect(s);
            const small = new Uint8Array(randomBytes(2000));
            await call(c, "write_attachment", { path: `Attachments/${NFC}-small.png`, content_base64: Buffer.from(small).toString("base64") });
            const big = new Uint8Array(randomBytes(300_000));
            const up = await call(c, "create_attachment_upload", { path: "Attachments/big.pdf", size: big.byteLength });
            const m = up.match(/https?:\/\/\S+\/attachments\/upload\/[^\s'"]+/);
            assert.ok(m, `no upload URL in:\n${up}`);
            const url = m[0];
            const put = await fetch(url, { method: "PUT", body: big });
            assert.equal(put.status, 201, await put.text());
            const list = await call(c, "list_attachments", {});
            assert.match(list, /big\.pdf/); assert.match(list.normalize("NFC"), new RegExp(`${NFC}-small\\.png`));
            clearHandlers();
            const got: any = await dev.get("Attachments/big.pdf" as any);
            assert.ok(Buffer.from(readContent(got) as ArrayBuffer).equals(Buffer.from(big)), "uploaded bytes differ on device");
            if (d.nfc) {
                clearHandlers();
                const g2: any = await dev.get(`Attachments/${NFD}-small.png` as any);
                assert.ok(Buffer.from(readContent(g2) as ArrayBuffer).equals(Buffer.from(small)), "NFD lookup of attachment");
            }
            await call(c, "move_attachment", { from: "Attachments/big.pdf", to: "Attachments/moved.pdf" });
            await call(c, "delete_attachment", { path: "Attachments/moved.pdf" });
            assert.doesNotMatch(await call(c, "list_attachments", {}), /moved\.pdf|big\.pdf/);
            await c.close();
        } finally { await stopServer(s); await closeDevice(dev); }
    });
    await check("restart reuses the persisted index (no rebuild) and is current", async () => {
        const dataDir = mkdtempSync(join(tmpdir(), "smoke-persist-"));
        const env = serverEnv(d, { COUCHDB_DATABASE: db, DATA_DIR: dataDir });
        const s1 = await startServer(env);
        await stopServer({ ...s1, dataDir: "/nonexistent-keep" });
        const dev = await openDevice(db, d);
        await devicePut(dev, "Live/while-down.md", "written while server down papaya");
        await closeDevice(dev);
        const s2 = await startServer(env);
        try {
            assert.match(s2.log(), /Search index (synced|up to date)/);
            const c = await connect(s2);
            assert.match(await call(c, "search_notes", { terms: ["papaya"] }), /while-down/);
            await c.close();
        } finally { await stopServer(s2); rmSync(dataDir, { recursive: true, force: true }); }
    });
}

// --- WRITE_FOLDERS permissions (#65) ---------------------------------------
// The create/update/delete split, the move-destination refusal and the
// per-document lock, against real CouchDB across vault configurations.
async function tryCall(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
    return await call(c, name, args).catch((e) => (e as Error).message);
}
const SAVED = /^Note saved:/;
const DENIED = /Write access denied/;
const UPLOAD_URL = /https?:\/\/\S+\/attachments\/upload\/[^\s'"]+/;

async function writePermissionChecks(label: string, db: string, d: Device) {
    const s = await startServer(serverEnv({ ...d, db }, { WRITE_FOLDERS: "MCP,Raw:create", ATTACHMENTS_ENABLED: "true" }));
    const dev = await openDevice(db, d);
    const c = await connect(s);
    const c2 = await connect(s);
    try {
        await check(`${label}: Raw:create — create works, overwrite/edit/delete/move-out refused`, async () => {
            assert.match(await call(c, "write_note", { path: "Raw/a.md", content: "original" }), SAVED);
            assert.equal(await deviceRead(dev, "Raw/a.md"), "original");
            assert.match(await tryCall(c, "write_note", { path: "Raw/a.md", content: "clobber" }), /allows only create.*already exists/s);
            assert.match(await tryCall(c, "edit_note", { path: "Raw/a.md", content: "more" }), DENIED);
            assert.match(await tryCall(c, "delete_note", { path: "Raw/a.md" }), DENIED);
            assert.match(await tryCall(c, "move_note", { from: "Raw/a.md", to: "MCP/a.md" }), DENIED);
            assert.match(await tryCall(c, "move_note", { from: "Raw/a.md", to: "Raw/b.md" }), DENIED);
            assert.equal(await deviceRead(dev, "Raw/a.md"), "original");
            assert.equal(await deviceRead(dev, "MCP/a.md"), null);
            assert.equal(await deviceRead(dev, "Raw/b.md"), null);
        });
        await check(`${label}: Raw:create — a note deleted on a device can be created again`, async () => {
            await devicePut(dev, "Raw/gone.md", "device note");
            clearHandlers();
            await dev.delete("Raw/gone.md");
            assert.match(await call(c, "write_note", { path: "Raw/gone.md", content: "recreated" }), SAVED);
            assert.equal(await deviceRead(dev, "Raw/gone.md"), "recreated");
        });
        await check(`${label}: move into Raw works, but not onto an existing note`, async () => {
            await call(c, "write_note", { path: "MCP/in.md", content: "moving in" });
            assert.match(await call(c, "move_note", { from: "MCP/in.md", to: "Raw/in.md" }), /^Moved:/);
            assert.equal(await deviceRead(dev, "Raw/in.md"), "moving in");
            assert.equal(await deviceRead(dev, "MCP/in.md"), null);
            await call(c, "write_note", { path: "MCP/onto.md", content: "would clobber" });
            assert.match(await tryCall(c, "move_note", { from: "MCP/onto.md", to: "Raw/a.md" }), /already exists/);
            if (!d.caseSensitive) assert.match(await tryCall(c, "move_note", { from: "MCP/onto.md", to: "Raw/A.md" }), /already exists/);
            assert.equal(await deviceRead(dev, "Raw/a.md"), "original");
            assert.equal(await deviceRead(dev, "MCP/onto.md"), "would clobber");
        });
        await check(`${label}: case-variant paths can't overwrite a Raw note`, async () => {
            // `raw/` is not listed, so it is outside the writable folders.
            assert.match(await tryCall(c, "write_note", { path: "raw/a.md", content: "x" }), DENIED);
            if (d.caseSensitive) {
                // Distinct documents on a case-sensitive vault: a new note, not an overwrite.
                assert.match(await call(c, "write_note", { path: "Raw/A.md", content: "distinct" }), SAVED);
                assert.equal(await deviceRead(dev, "Raw/A.md"), "distinct");
            } else {
                assert.match(await tryCall(c, "write_note", { path: "Raw/A.md", content: "x" }), /already exists/);
            }
            assert.equal(await deviceRead(dev, "Raw/a.md"), "original");
        });
        await check(`${label}: two concurrent creates of one new Raw path → exactly one succeeds`, async () => {
            for (let round = 0; round < 3; round++) {
                const p = `Raw/race-${round}.md`;
                const r = await Promise.all([
                    tryCall(c, "write_note", { path: p, content: "first" }),
                    tryCall(c2, "write_note", { path: p, content: "second" }),
                ]);
                assert.equal(r.filter((t) => SAVED.test(t)).length, 1, `round ${round}: ${JSON.stringify(r)}`);
                assert.match(r.find((t) => !SAVED.test(t))!, /already exists/);
                assert.equal(await deviceRead(dev, p), SAVED.test(r[0]) ? "first" : "second");
            }
            if (!d.caseSensitive) {
                const r = await Promise.all([
                    tryCall(c, "write_note", { path: "Raw/Race-case.md", content: "upper" }),
                    tryCall(c2, "write_note", { path: "Raw/race-case.md", content: "lower" }),
                ]);
                assert.equal(r.filter((t) => SAVED.test(t)).length, 1, JSON.stringify(r));
            }
        });
        await check(`${label}: move_note onto an existing note in a fully writable folder is refused`, async () => {
            await call(c, "write_note", { path: "MCP/x.md", content: "x body" });
            await call(c, "write_note", { path: "MCP/y.md", content: "y body" });
            assert.match(await tryCall(c, "move_note", { from: "MCP/x.md", to: "MCP/y.md" }), /already exists/);
            assert.equal(await deviceRead(dev, "MCP/x.md"), "x body");
            assert.equal(await deviceRead(dev, "MCP/y.md"), "y body");
        });
        await check(`${label}: case-only rename in a fully writable folder still works`, async () => {
            await call(c, "write_note", { path: "MCP/case.md", content: "case body" });
            assert.match(await call(c, "move_note", { from: "MCP/case.md", to: "MCP/Case.md" }), /^Moved:/);
            assert.match(await call(c, "read_note", { path: "MCP/Case.md" }), /case body/);
            const list = await call(c, "list_notes", { folder: "MCP", limit: 100 });
            assert.match(list, /MCP\/Case\.md/);
            assert.doesNotMatch(list, /MCP\/case\.md/);
            assert.equal(await deviceRead(dev, "MCP/Case.md"), "case body");
        });
        await check(`${label}: attachments in Raw — upload URL creates, overwrite/delete/move-out refused`, async () => {
            const bytes = new Uint8Array(randomBytes(5000));
            const up = await call(c, "create_attachment_upload", { path: "Raw/scan.pdf", size: bytes.byteLength });
            const url = up.match(UPLOAD_URL)?.[0];
            assert.ok(url, up);
            assert.equal((await fetch(url, { method: "PUT", body: bytes })).status, 201);
            clearHandlers();
            const got: any = await dev.get("Raw/scan.pdf" as any);
            assert.ok(Buffer.from(readContent(got) as ArrayBuffer).equals(Buffer.from(bytes)), "uploaded bytes differ on device");
            assert.match(await tryCall(c, "create_attachment_upload", { path: "Raw/scan.pdf", size: 10 }), /^Attachment already exists: Raw\/scan\.pdf\. Choose another path\.$/);
            assert.match(await tryCall(c, "create_attachment_upload", { path: "Raw/scan.pdf", size: 10, overwrite: true }), DENIED);
            assert.match(await tryCall(c, "write_attachment", { path: "Raw/scan.pdf", content_base64: "AAAA" }), /already exists/);
            assert.match(await tryCall(c, "write_attachment", { path: "Raw/scan.pdf", content_base64: "AAAA", overwrite: true }), DENIED);
            assert.match(await tryCall(c, "delete_attachment", { path: "Raw/scan.pdf" }), DENIED);
            assert.match(await tryCall(c, "move_attachment", { from: "Raw/scan.pdf", to: "MCP/scan.pdf" }), DENIED);
            // Two upload URLs for one new path: the second PUT loses with 409.
            const u1 = (await call(c, "create_attachment_upload", { path: "Raw/twice.png", size: 4 })).match(UPLOAD_URL)![0];
            const u2 = (await call(c, "create_attachment_upload", { path: "Raw/twice.png", size: 4 })).match(UPLOAD_URL)![0];
            assert.equal((await fetch(u1, { method: "PUT", body: new Uint8Array([1, 2, 3, 4]) })).status, 201);
            assert.equal((await fetch(u2, { method: "PUT", body: new Uint8Array([5, 6, 7, 8]) })).status, 409);
            clearHandlers();
            const twice: any = await dev.get("Raw/twice.png" as any);
            assert.deepEqual([...new Uint8Array(readContent(twice) as ArrayBuffer)], [1, 2, 3, 4]);
            // Moving an attachment into Raw works, but not onto an existing one.
            await call(c, "write_attachment", { path: "MCP/in.png", content_base64: "AQID" });
            assert.match(await tryCall(c, "move_attachment", { from: "MCP/in.png", to: "Raw/scan.pdf" }), /already exists/);
            assert.match(await call(c, "move_attachment", { from: "MCP/in.png", to: "Raw/in.png" }), /^Moved:/);
        });
    } finally {
        await c.close().catch(() => {});
        await c2.close().catch(() => {});
        await stopServer(s);
        await closeDevice(dev);
    }
    // `/,Raw:create`: a case variant of Raw (`raw/`) gets only what both spellings allow.
    await check(`${label}: WRITE_FOLDERS=/,Raw:create — raw/a.md can't overwrite Raw/a.md`, async () => {
        const s2 = await startServer(serverEnv({ ...d, db }, { WRITE_FOLDERS: "/,Raw:create" }));
        const dev2 = await openDevice(db, d);
        try {
            const cc = await connect(s2);
            const r = await tryCall(cc, "write_note", { path: "raw/a.md", content: "sneaky" });
            if (d.caseSensitive) assert.match(r, SAVED); // a separate document there
            else assert.match(r, /allows only create.*already exists/s);
            assert.match(await tryCall(cc, "edit_note", { path: "raw/a.md", content: "more" }), DENIED);
            assert.match(await tryCall(cc, "delete_note", { path: "raw/a.md" }), DENIED);
            assert.equal(await deviceRead(dev2, "Raw/a.md"), "original");
            assert.match(await call(cc, "write_note", { path: "Elsewhere/free.md", content: "1" }), SAVED);
            assert.match(await call(cc, "write_note", { path: "Elsewhere/free.md", content: "2" }), SAVED);
            await cc.close();
        } finally { await stopServer(s2); await closeDevice(dev2); }
    });
}

console.log("\n=== WRITE_FOLDERS permissions (MCP,Raw:create) ===");
for (const idx of [1, 7, 8]) {
    const { label, d } = MATRIX[idx];
    await writePermissionChecks(label, `smoke_m${idx}`, d);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    for (const f of failures) console.log(` - ${f.split("\n")[0]}`);
    process.exit(1);
}
process.exit(0);
