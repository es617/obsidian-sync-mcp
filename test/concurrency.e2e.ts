/**
 * Concurrency harness: several agents editing one note at once, through two
 * server instances that share one CouchDB database (a common deployment:
 * one instance per agent group, all on the same vault).
 *
 * Destructive: drops and recreates its own test database. Never point it at a
 * real vault.
 *
 * Run: npm run test:concurrency   (builds first, then expects CouchDB on localhost:5985)
 *
 *   docker run -d --name couchdb-conc-test -p 127.0.0.1:5985:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
 *
 * Override with TEST_COUCHDB_URL / TEST_COUCHDB_USER / TEST_COUCHDB_PASSWORD;
 * CONCURRENCY_INSTANCES (default 2) sets how many server instances share the database.
 *
 * Scenarios (each prints PASS or FAIL; the run exits 1 on any FAIL):
 *   control   one worker edits 20 lines one after the other: all 20 land,
 *             which proves the counting below is right.
 *   disjoint  20 workers, alternating between the two instances, each replace
 *             their own line at the same moment. Every edit must be present.
 *   same-line two workers replace the same line at the same moment. Exactly one
 *             may succeed; the other must be told, not silently overwritten.
 *   expected-revision
 *             a write_note with the revision read on one instance succeeds on the
 *             other; repeating it with that now-stale revision writes nothing.
 *
 * The final note is read straight from CouchDB (not through the servers under
 * test), with its conflict leaves, so a loss hidden in a sibling revision
 * counts as a loss too.
 *
 * `--load WxE` (e.g. `--load 4x50`) instead runs W writers that each append
 * E unique lines to one note, alternating instances, and prints one JSON line
 * with what was sent, answered and present, plus latency percentiles.
 * `--think MS` makes each writer pause a random 0..MS ms between its edits;
 * without it the writers loop flat out, which saturates the note.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COUCH = (process.env.TEST_COUCHDB_URL ?? "http://localhost:5985").replace(/\/+$/, "");
const COUCH_USER = process.env.TEST_COUCHDB_USER ?? "admin";
const COUCH_PASSWORD = process.env.TEST_COUCHDB_PASSWORD ?? "test";
const DB = "concurrencyvault";
const AUTH = "concurrency-test-token";
/** CONCURRENCY_INSTANCES=1 runs every worker against a single instance. */
const INSTANCES = Number(process.env.CONCURRENCY_INSTANCES ?? 2);
const PORTS = Array.from({ length: INSTANCES }, (_, i) => 9881 + i);

const couchAuth = { Authorization: "Basic " + Buffer.from(`${COUCH_USER}:${COUCH_PASSWORD}`).toString("base64") };

// --- MCP client: one session per worker, so no call waits behind another's ---

function parseSSE(raw: string): any {
    for (const line of raw.split("\n")) {
        if (line.startsWith("data: ")) {
            try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
    }
    return JSON.parse(raw);
}

class Client {
    private session = "";
    constructor(readonly port: number) {}

    private async post(body: unknown): Promise<Response> {
        return await fetch(`http://localhost:${this.port}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": `Bearer ${AUTH}`,
                ...(this.session ? { "mcp-session-id": this.session } : {}),
            },
            body: JSON.stringify(body),
        });
    }

    async connect(): Promise<this> {
        const resp = await this.post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "concurrency", version: "1.0" } } });
        if (!resp.ok) throw new Error(`initialize on ${this.port}: ${resp.status}`);
        this.session = resp.headers.get("mcp-session-id") ?? "";
        await resp.text();
        return this;
    }

    async tool(name: string, args: Record<string, unknown>): Promise<string> {
        const resp = parseSSE(await (await this.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).text());
        const text = resp?.result?.content?.[0]?.text;
        if (typeof text !== "string") throw new Error(`${name}: no text in ${JSON.stringify(resp).slice(0, 300)}`);
        return text;
    }
}

// --- Servers ---

interface Server { proc: ChildProcess; logs: string; dataDir: string }

async function startServer(port: number, env: Record<string, string> = {}): Promise<Server> {
    const dataDir = await mkdtemp(join(tmpdir(), "conc-e2e-"));
    const server: Server = {
        proc: spawn("node", ["dist/main.js"], {
            env: {
                ...process.env,
                PORT: String(port),
                HOST: "127.0.0.1",
                MCP_AUTH_TOKEN: AUTH,
                COUCHDB_URL: COUCH,
                COUCHDB_USER: COUCH_USER,
                COUCHDB_PASSWORD: COUCH_PASSWORD,
                COUCHDB_DATABASE: DB,
                VAULT_NAME: "ConcurrencyVault",
                DATA_DIR: dataDir,
                ...env,
            },
            stdio: "pipe",
        }),
        logs: "",
        dataDir,
    };
    server.proc.stdout?.on("data", (d) => { server.logs += d.toString(); });
    server.proc.stderr?.on("data", (d) => { server.logs += d.toString(); });
    const start = Date.now();
    while (Date.now() - start < 30000) {
        if (server.proc.exitCode !== null) throw new Error(`server on ${port} exited:\n${server.logs}`);
        try {
            await new Client(port).connect();
            return server;
        } catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server on ${port} did not start:\n${server.logs}`);
}

async function stopServer(server: Server): Promise<void> {
    server.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    await rm(server.dataDir, { recursive: true, force: true });
}

// --- Independent read of a note, straight from CouchDB, every live leaf ---

async function couch(path: string, init: RequestInit = {}): Promise<any> {
    const resp = await fetch(`${COUCH}/${DB}${path}`, { ...init, headers: { ...couchAuth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    return await resp.json();
}

async function bodyOf(doc: any): Promise<string> {
    const keys: string[] = doc.children ?? [];
    if (keys.length === 0) return "";
    const res = await couch("/_all_docs?include_docs=true", { method: "POST", body: JSON.stringify({ keys }) });
    return res.rows.map((r: any) => r.doc?.data ?? "").join("");
}

/** The winning body and the bodies of any conflict leaves. */
async function readFromCouch(path: string): Promise<{ winner: string; conflicts: string[] }> {
    const found = await couch("/_find", { method: "POST", body: JSON.stringify({ selector: { path }, conflicts: true, limit: 2 }) });
    assert.equal(found.docs?.length, 1, `expected one document for ${path}, got ${JSON.stringify(found).slice(0, 200)}`);
    const doc = found.docs[0];
    const conflicts: string[] = [];
    for (const rev of doc._conflicts ?? []) {
        conflicts.push(await bodyOf(await couch(`/${encodeURIComponent(doc._id)}?rev=${rev}`)));
    }
    return { winner: await bodyOf(doc), conflicts };
}

// --- Scenarios ---

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!ok) failures.push(name);
}

function board(lines: string[]): string {
    return `---\ntitle: Sprint board\n---\n# Doing\n\n${lines.join("\n")}\n`;
}
const task = (i: number) => `task-${String(i).padStart(2, "0")}`;

async function seed(client: Client, path: string, content: string): Promise<void> {
    const saved = await client.tool("write_note", { path, content });
    assert.match(saved, /^Note saved/, saved);
}

async function control(clients: Client[]): Promise<void> {
    const path = "Boards/sequential.md";
    const n = 20;
    await seed(clients[0], path, board(Array.from({ length: n }, (_, i) => `- [ ] ${task(i)}`)));
    for (let i = 0; i < n; i++) {
        const answer = await clients[i % clients.length].tool("edit_note", { path, operation: "replace", old_text: `- [ ] ${task(i)}`, content: `- [x] ${task(i)}` });
        assert.match(answer, /^Note edited/, answer);
    }
    const { winner, conflicts } = await readFromCouch(path);
    const done = Array.from({ length: n }, (_, i) => winner.includes(`- [x] ${task(i)}`)).filter(Boolean).length;
    check("control", done === n && conflicts.length === 0, `${done}/${n} edits present, ${conflicts.length} conflict leaves`);
}

async function disjoint(clients: Client[]): Promise<void> {
    const path = "Boards/sprint.md";
    const n = 20;
    await seed(clients[0], path, board(Array.from({ length: n }, (_, i) => `- [ ] ${task(i)}`)));
    // CONCURRENCY_LONE=1: one worker on the first instance, the rest on the others,
    // the uneven split where a lone writer competes with a busy instance's queue.
    const instanceOf = (i: number) => process.env.CONCURRENCY_LONE && clients.length > 1 ? (i === 0 ? 0 : 1 + (i % (clients.length - 1))) : i % clients.length;
    const workers = await Promise.all(Array.from({ length: n }, (_, i) => new Client(clients[instanceOf(i)].port).connect()));
    const answers = await Promise.all(workers.map((w, i) =>
        w.tool("edit_note", { path, operation: "replace", old_text: `- [ ] ${task(i)}`, content: `- [x] ${task(i)}` })));
    const reportedOk = answers.filter((a) => a.startsWith("Note edited")).length;
    const { winner, conflicts } = await readFromCouch(path);
    const done = Array.from({ length: n }, (_, i) => winner.includes(`- [x] ${task(i)}`)).filter(Boolean).length;
    const other = answers.filter((a) => !a.startsWith("Note edited"));
    check("disjoint", done === n && reportedOk === n && conflicts.length === 0,
        `${reportedOk}/${n} answered "Note edited", ${done}/${n} edits present, ${conflicts.length} conflict leaves` +
        (other.length ? `; other answers: ${JSON.stringify([...new Set(other)])}` : ""));
}

async function sameLine(clients: Client[]): Promise<void> {
    const path = "Boards/shared.md";
    await seed(clients[0], path, board(["- [ ] task-shared", "- [ ] task-other"]));
    const [a, b] = await Promise.all([new Client(clients[0].port).connect(), new Client(clients[1 % clients.length].port).connect()]);
    const answers = await Promise.all([
        a.tool("edit_note", { path, operation: "replace", old_text: "- [ ] task-shared", content: "- [x] task-shared (by alice)" }),
        b.tool("edit_note", { path, operation: "replace", old_text: "- [ ] task-shared", content: "- [x] task-shared (by bob)" }),
    ]);
    const succeeded = answers.filter((x) => x.startsWith("Note edited")).length;
    const { winner, conflicts } = await readFromCouch(path);
    const present = ["alice", "bob"].filter((who) => winner.includes(`(by ${who})`)).length;
    check("same-line", succeeded === 1 && present === 1 && conflicts.length === 0,
        `${succeeded}/2 answered "Note edited", ${present} of them present, ${conflicts.length} conflict leaves; answers: ${JSON.stringify(answers.map((x) => x.split("\n")[0]))}`);
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function load(clients: Client[], writers: number, edits: number, thinkMs: number): Promise<void> {
    const path = "Boards/load.md";
    await seed(clients[0], path, board(["- [ ] seed"]));
    const workers = await Promise.all(Array.from({ length: writers }, (_, w) => new Client(clients[w % clients.length].port).connect()));
    const latencies: number[] = [];
    const answers = new Map<string, number>();
    const start = performance.now();
    await Promise.all(workers.map(async (worker, w) => {
        for (let e = 0; e < edits; e++) {
            if (thinkMs > 0) await new Promise((r) => setTimeout(r, Math.random() * thinkMs));
            const t0 = performance.now();
            const answer = await worker.tool("edit_note", { path, operation: "append", content: `- [ ] load-w${w}-e${e}` });
            latencies.push(performance.now() - t0);
            const key = answer.split("\n")[0].replace(path, "<path>");
            answers.set(key, (answers.get(key) ?? 0) + 1);
        }
    }));
    const wallMs = performance.now() - start;
    const { winner, conflicts } = await readFromCouch(path);
    let present = 0;
    for (let w = 0; w < writers; w++) for (let e = 0; e < edits; e++) if (winner.includes(`- [ ] load-w${w}-e${e}\n`) || winner.endsWith(`- [ ] load-w${w}-e${e}`)) present++;
    latencies.sort((x, y) => x - y);
    const ok = [...answers.entries()].filter(([k]) => k.startsWith("Note edited")).reduce((n, [, v]) => n + v, 0);
    console.log(JSON.stringify({
        writers, edits, thinkMs, sent: writers * edits, answers: Object.fromEntries(answers), present,
        // An edit refused with an error is not lost: its caller was told. A lost
        // edit is one answered "Note edited" that is not in the note.
        silentlyLost: Math.max(0, ok - present), refused: writers * edits - ok, conflictLeaves: conflicts.length,
        p50ms: Math.round(percentile(latencies, 50)), p95ms: Math.round(percentile(latencies, 95)), maxMs: Math.round(latencies[latencies.length - 1]),
        wallMs: Math.round(wallMs),
    }));
}

async function expectedRevision(clients: Client[]): Promise<void> {
    const path = "Boards/pinned.md";
    await seed(clients[0], path, "v1\n");
    const read = await clients[0].tool("read_note", { path });
    const revision = read.match(/^Revision: (\S+)$/m)?.[1];
    if (!revision) {
        check("expected-revision", false, `read_note returned no revision: ${JSON.stringify(read.split("\n")[0])}`);
        return;
    }
    const other = clients[1 % clients.length];
    const first = await other.tool("write_note", { path, content: "v2\n", expected_revision: revision });
    const stale = await clients[0].tool("write_note", { path, content: "v3\n", expected_revision: revision });
    const { winner, conflicts } = await readFromCouch(path);
    check("expected-revision", first.startsWith("Note saved") && stale.startsWith("Revision mismatch") && winner === "v2\n" && conflicts.length === 0,
        `fresh: ${JSON.stringify(first.split("\n")[0])}, stale: ${JSON.stringify(stale.split("\n")[0])}, body ${JSON.stringify(winner)}, ${conflicts.length} conflict leaves`);
}

/** Server-side retry rounds, from the debug log line the CouchDB backend writes for each. */
function retriesLogged(servers: Server[]): number {
    return servers.reduce((n, s) => n + (s.logs.match(/revision conflict on attempt/g)?.length ?? 0), 0);
}

// --- Main ---

await fetch(`${COUCH}/${DB}`, { method: "DELETE", headers: couchAuth });
const created = await fetch(`${COUCH}/${DB}`, { method: "PUT", headers: couchAuth });
if (!created.ok) throw new Error(`could not create ${DB}: ${created.status}`);

const loadArg = process.argv.indexOf("--load");
const servers: Server[] = [];
try {
    // Start one first so the empty database gets its path identity declared once.
    for (const port of PORTS) servers.push(await startServer(port, loadArg !== -1 ? { LOG_LEVEL: "debug" } : {}));
    const clients = await Promise.all(PORTS.map((p) => new Client(p).connect()));
    if (loadArg !== -1) {
        const [w, e] = (process.argv[loadArg + 1] ?? "4x50").split("x").map(Number);
        const thinkArg = process.argv.indexOf("--think");
        await load(clients, w, e, thinkArg === -1 ? 0 : Number(process.argv[thinkArg + 1]));
        console.log(JSON.stringify({ retriesLogged: retriesLogged(servers) }));
    } else {
        await control(clients);
        await disjoint(clients);
        await sameLine(clients);
        await expectedRevision(clients);
    }
} finally {
    if (process.env.CONCURRENCY_SERVER_LOGS) {
        for (const [i, s] of servers.entries()) console.log(`\n--- server ${i} log ---\n${s.logs}`);
    }
    for (const s of servers) await stopServer(s);
}

if (loadArg === -1) {
    if (failures.length) {
        console.log(`\n${failures.length} scenario(s) failed: ${failures.join(", ")}`);
        process.exit(1);
    }
    console.log("\nAll concurrency scenarios passed.");
}
process.exit(0);
