import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { deriveFullTextIndexKey, FullTextIndex } from "../src/full-text-search.js";

const noteCount = Number.parseInt(process.env.BENCH_NOTES ?? "50000", 10);
const queryRuns = Number.parseInt(process.env.BENCH_QUERIES ?? "120", 10);
const outputPath = process.env.BENCH_OUTPUT;
if (!Number.isSafeInteger(noteCount) || noteCount < 1) throw new Error("BENCH_NOTES must be a positive integer.");
if (!Number.isSafeInteger(queryRuns) || queryRuns < 6) throw new Error("BENCH_QUERIES must be an integer of at least 6.");
const directory = await mkdtemp(join(tmpdir(), "obsidian-search-bench-"));
const databasePath = join(directory, "search.sqlite");

function percentile(values: number[], fraction: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

async function readCgroupValue(path: string): Promise<string | undefined> {
    try {
        const value = (await readFile(path, "utf8")).trim();
        return value === "max" ? undefined : value;
    } catch {
        return undefined;
    }
}

try {
    const encrypted = process.env.BENCH_ENCRYPTED === "true";
    const encryptionKey = encrypted
        ? deriveFullTextIndexKey("benchmark passphrase", "benchmark-vault")
        : undefined;
    const index = await FullTextIndex.open(databasePath, { encryptionKey });
    encryptionKey?.fill(0);
    const started = performance.now();
    for (let offset = 0; offset < noteCount; offset += 500) {
        index.beginBatch();
        try {
            for (let note = offset; note < Math.min(offset + 500, noteCount); note++) {
                index.update(
                    `areas/area-${note % 100}/project-${note}.md`,
                    `---
aliases: ["Initiative ${note}"]
tags: [project, area-${note % 100}]
---
# Project ${note}

Background for project ${note}. This note records durable PKB context and ownership.

## Provider recovery

Stream provider recovery evidence marker${note} and playback edge observations.

## Decisions

The team selected bounded retries and visible recovery status. See [[Project ${(note + 1) % noteCount}]].`,
                    note,
                );
            }
            index.commitBatch();
        } catch (error) {
            index.rollbackBatch();
            throw error;
        }
    }
    const buildMs = performance.now() - started;

    const queries = [
        { label: "exact-title", options: { query: `Project ${Math.floor(noteCount * 0.84)}` } },
        { label: "exact-alias", options: { query: `Initiative ${Math.floor(noteCount * 0.63)}` } },
        { label: "rare-passage", options: { query: `marker${Math.floor(noteCount * 0.42)}` } },
        { label: "filtered-passage", options: { query: "provider recovery", folder: "areas/area-42" } },
        { label: "phrase", options: { query: "bounded retries", mode: "phrase" as const } },
        { label: "broad-passage", options: { query: "bounded retries visible status" } },
    ];
    for (const query of queries) index.search({ ...query.options, limit: 20 });

    const latencies: number[] = [];
    const byQuery = new Map<string, number[]>();
    for (let run = 0; run < queryRuns; run++) {
        const query = queries[run % queries.length];
        const queryStart = performance.now();
        index.search({ ...query.options, limit: 20 });
        const elapsed = performance.now() - queryStart;
        latencies.push(elapsed);
        const samples = byQuery.get(query.label) ?? [];
        samples.push(elapsed);
        byQuery.set(query.label, samples);
    }
    const updateLatencies: number[] = [];
    for (let run = 0; run < 50; run++) {
        const note = Math.floor(noteCount / 2) + run;
        const updateStart = performance.now();
        index.update(
            `areas/area-${note % 100}/project-${note}.md`,
            `# Project ${note}\n\n## Update\nIncremental recovery update ${run}.`,
            noteCount + run,
        );
        updateLatencies.push(performance.now() - updateStart);
    }
    const memory = process.memoryUsage();
    const usage = process.resourceUsage();
    const notes = index.size;
    const chunks = index.chunkCount;
    index.close();
    const bytes = (await stat(databasePath)).size;
    const cgroupMemoryBytes = await readCgroupValue("/sys/fs/cgroup/memory.max");
    const cgroupCpu = await readCgroupValue("/sys/fs/cgroup/cpu.max");
    const result = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        runtime: {
            node: process.version,
            platform: platform(),
            architecture: arch(),
            kernel: release(),
            cpuModel: cpus()[0]?.model ?? "unknown",
            logicalCpuCount: cpus().length,
            hostMemoryMiB: Number((totalmem() / 1024 / 1024).toFixed(2)),
            cgroupMemoryLimitBytes: cgroupMemoryBytes ? Number(cgroupMemoryBytes) : null,
            cgroupCpuLimit: cgroupCpu ?? null,
        },
        encrypted,
        notes,
        chunks,
        queryRuns,
        updateRuns: updateLatencies.length,
        buildSeconds: Number((buildMs / 1000).toFixed(2)),
        notesPerSecond: Math.round(noteCount / (buildMs / 1000)),
        queryP50Ms: Number(percentile(latencies, 0.5).toFixed(2)),
        queryP95Ms: Number(percentile(latencies, 0.95).toFixed(2)),
        queryP99Ms: Number(percentile(latencies, 0.99).toFixed(2)),
        updateP95Ms: Number(percentile(updateLatencies, 0.95).toFixed(2)),
        indexMiB: Number((bytes / 1024 / 1024).toFixed(2)),
        rssMiB: Number((memory.rss / 1024 / 1024).toFixed(2)),
        maxRssMiB: Number((usage.maxRSS / 1024).toFixed(2)),
        queryClasses: Object.fromEntries([...byQuery].map(([label, samples]) => [label, {
            p50Ms: Number(percentile(samples, 0.5).toFixed(2)),
            p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
        }])),
    };
    const rendered = `${JSON.stringify(result, null, 2)}\n`;
    if (outputPath) {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, rendered, "utf8");
    }
    process.stdout.write(rendered);
} finally {
    await rm(directory, { recursive: true, force: true });
}
