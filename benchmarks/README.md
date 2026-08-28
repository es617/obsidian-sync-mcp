# Search v2 benchmark

This benchmark measures the disk-backed search index with a deterministic
synthetic corpus. Each note has an alias, two tags, a link, and three
heading-level chunks. Query samples cover exact title, exact alias, rare body
text, folder-filtered body text, an exact phrase, and a broad all-word query.

## Reproduce

Install dependencies under Node 22.14+ or Node 24, then run:

```bash
BENCH_NOTES=100000 BENCH_QUERIES=120 npm run benchmark:search
BENCH_NOTES=100000 BENCH_QUERIES=120 BENCH_ENCRYPTED=true npm run benchmark:search
```

Set `BENCH_OUTPUT` to save the emitted JSON. The committed artifacts were
produced with the repository mounted into `node:22-slim` and networking
disabled, for example:

```bash
docker run --rm --network none \
  -e BENCH_NOTES=100000 \
  -e BENCH_QUERIES=120 \
  -e BENCH_ENCRYPTED=true \
  -e BENCH_OUTPUT=/workspace/benchmarks/results/node22-amd64-100000-encrypted.json \
  -v "$PWD:/workspace" -w /workspace node:22-slim \
  npm run benchmark:search
```

## Reference results

Captured on 2026-08-27 with Node 22.23.2, Linux x64 under WSL2, an AMD Ryzen 7
7800X3D, 16 logical CPUs, and no container CPU or memory limit. Values are one
run per cell; use the JSON artifacts for per-query-class percentiles.

| Notes | Index | Build (s) | Notes/s | Query p95 (ms) | Update p95 (ms) | Index (MiB) | RSS (MiB) |
|---:|:---|---:|---:|---:|---:|---:|---:|
| 10,000 | plaintext | 2.20 | 4,547 | 23.22 | 8.52 | 19.39 | 152.93 |
| 10,000 | encrypted | 2.50 | 4,000 | 23.23 | 9.30 | 20.02 | 135.07 |
| 50,000 | plaintext | 14.12 | 3,541 | 98.60 | 9.15 | 99.90 | 240.45 |
| 50,000 | encrypted | 17.65 | 2,834 | 176.81 | 10.10 | 103.63 | 240.52 |
| 100,000 | plaintext | 29.20 | 3,424 | 206.82 | 9.00 | 198.95 | 283.98 |
| 100,000 | encrypted | 38.67 | 2,586 | 384.28 | 10.54 | 206.47 | 284.64 |

At 100,000 notes, encryption reduced build throughput by about 24%, increased
the aggregate query p95 by about 86%, and increased index size by about 3.8%.
RSS was effectively unchanged. Phrase and broad queries are the slowest classes;
exact and rare-term queries remain materially faster in the raw artifacts.

## Regression thresholds

For the reference 100,000-note corpus on comparable x64 hardware, investigate a
change when any of these are true:

- build throughput falls below 2,000 notes/s;
- aggregate query p95 exceeds 250 ms for plaintext or 450 ms for encrypted;
- update p95 exceeds 20 ms;
- RSS exceeds 350 MiB;
- the main index exceeds 225 MiB; or
- a metric regresses by more than 20% from the matching committed baseline,
  even if it remains below the absolute ceiling.

These are regression budgets, not universal service-level objectives. Real PKBs
vary in note length, language, heading density, storage latency, and query mix.
Run the harness more than once before treating a small difference as signal.

## FlexSearch context

The historical FlexSearch implementation has no committed, same-corpus raw
artifact, so this benchmark does not claim a direct latency comparison. Project
history records that its persisted 53 MiB index caused out-of-memory failures on
load and that full-text search was removed. Search v2 instead demonstrates a
bounded ~285 MiB process RSS at 100,000 synthetic notes, keeps note bodies out of
the JavaScript heap, persists incremental SQLite state, and resumes from a
checkpoint. Those are architectural comparisons; they are not an apples-to-
apples performance result.

## Raw artifacts

- `results/node22-amd64-10000-plaintext.json`
- `results/node22-amd64-10000-encrypted.json`
- `results/node22-amd64-50000-plaintext.json`
- `results/node22-amd64-50000-encrypted.json`
- `results/node22-amd64-100000-plaintext.json`
- `results/node22-amd64-100000-encrypted.json`
