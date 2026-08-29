import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
    buildFtsQuery,
    deriveFullTextIndexKey,
    deriveLegacyFullTextIndexKey,
    deriveSearchBackendId,
    FullTextIndex,
    resolveFullTextSearchSetting,
    searchIndexStoragePaths,
} from "./full-text-search.js";

let tmpDir: string;

before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "full-text-search-test-"));
});

after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

describe("full-text search configuration", () => {
    it("enables search and encrypts indexes for encrypted vaults by default", () => {
        assert.deepEqual(resolveFullTextSearchSetting(undefined, false), {
            enabled: true,
            encryptIndex: false,
        });
        assert.deepEqual(resolveFullTextSearchSetting(undefined, true), {
            enabled: true,
            encryptIndex: true,
        });
    });

    it("supports explicit enable and disable without weakening encryption", () => {
        assert.deepEqual(resolveFullTextSearchSetting("true", true), {
            enabled: true,
            encryptIndex: true,
        });
        assert.equal(resolveFullTextSearchSetting("false", false).enabled, false);
        assert.equal(resolveFullTextSearchSetting("false", true).encryptIndex, false);
    });

    it("derives stable, password-hardened, vault-specific index keys", () => {
        const first = deriveFullTextIndexKey("passphrase", "vault-a");
        const again = deriveFullTextIndexKey("passphrase", "vault-a");
        const otherVault = deriveFullTextIndexKey("passphrase", "vault-b");
        const legacy = deriveLegacyFullTextIndexKey("passphrase", "vault-a");
        assert.equal(first.length, 32);
        assert.deepEqual(first, again);
        assert.notDeepEqual(first, otherVault);
        assert.notDeepEqual(first, legacy);
    });

    it("scopes storage identity to the backend rather than the display vault name", () => {
        const localA = deriveSearchBackendId({ kind: "filesystem", location: "/vault/a" });
        const localAWindows = deriveSearchBackendId({ kind: "filesystem", location: "\\vault\\a\\" });
        const localB = deriveSearchBackendId({ kind: "filesystem", location: "/vault/b" });
        const remote = deriveSearchBackendId({
            kind: "couchdb",
            url: "https://user:secret@DB.EXAMPLE.test/root/?ignored=yes",
            database: "obsidian",
        });
        const remoteWithoutCredentials = deriveSearchBackendId({
            kind: "couchdb",
            url: "https://db.example.test/root",
            database: "obsidian",
        });
        assert.equal(localA, localAWindows);
        assert.notEqual(localA, localB);
        assert.equal(remote, remoteWithoutCredentials);
        assert.notEqual(remote, deriveSearchBackendId({
            kind: "couchdb",
            url: "https://db.example.test/root",
            database: "another-vault",
        }));

        const pathsA = searchIndexStoragePaths("/data", localA, "Shared Name");
        const pathsB = searchIndexStoragePaths("/data", localB, "Shared Name");
        assert.notEqual(pathsA.indexPath, pathsB.indexPath);
        assert.equal(pathsA.legacyIndexPath, pathsB.legacyIndexPath);
        assert.notEqual(pathsA.indexPath, pathsA.legacyIndexPath);
    });

    it("rejects ambiguous configuration", () => {
        assert.throws(
            () => resolveFullTextSearchSetting("yes", false),
            /FULL_TEXT_SEARCH/,
        );
    });
});

describe("FTS query construction", () => {
    it("quotes user input instead of accepting raw FTS operators", () => {
        assert.equal(buildFtsQuery("recovery OR provider"), '"recovery" AND "OR" AND "provider"');
        assert.equal(buildFtsQuery("recovery provider", "any"), '"recovery" OR "provider"');
        assert.equal(buildFtsQuery("recovery provider", "phrase"), '"recovery provider"');
    });

    it("rejects punctuation-only input", () => {
        assert.throws(() => buildFtsQuery("---"), /letter or number/);
    });
});

describe("FullTextIndex", () => {
    it("ranks title matches above body-only matches and returns snippets", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.update(
                "body-only.md",
                "# Ordinary note\n\nThis body discusses provider recovery behavior.",
                100,
            );
            index.update(
                "recovery-design.md",
                "# Recovery design\n\nA short architecture note.",
                200,
            );

            const results = index.search({ query: "recovery" });
            assert.equal(results.length, 2);
            assert.equal(results[0].path, "recovery-design.md");
            assert.match(results[0].snippet, /\*\*Recovery\*\*/i);
        } finally {
            index.close();
        }
    });

    it("ranks exact filenames and paths and enforces the result limit", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.update("projects/provider-recovery.md", "# Unrelated heading\n\nOrdinary body.", 100);
            index.update("provider-recovery-notes.md", "# Provider recovery notes\n\nOrdinary body.", 200);
            index.update("body.md", "This body mentions provider recovery.", 300);

            const filename = index.search({ query: "provider recovery", limit: 1 });
            assert.equal(filename.length, 1);
            assert.equal(filename[0].path, "projects/provider-recovery.md");
            assert.equal(filename[0].matchedBy, "exact");

            const path = index.search({ query: "projects provider recovery" });
            assert.equal(path[0].path, "projects/provider-recovery.md");
            assert.equal(path[0].matchedBy, "exact");
        } finally {
            index.close();
        }
    });

    it("supports all, any, and phrase modes", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.update("both.md", "provider recovery", 100);
            index.update("provider.md", "provider latency", 100);
            index.update("reversed.md", "recovery from the provider", 100);

            assert.deepEqual(
                index.search({ query: "provider recovery" }).map((r) => r.path).sort(),
                ["both.md", "reversed.md"],
            );
            assert.equal(index.search({ query: "provider recovery", mode: "any" }).length, 3);
            assert.deepEqual(
                index.search({ query: "provider recovery", mode: "phrase" }).map((r) => r.path),
                ["both.md"],
            );
        } finally {
            index.close();
        }
    });

    it("normalizes Unicode and applies English stemming", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.update("unicode.md", "# Café notes\n\nThe runners were running daily.", 100);

            assert.deepEqual(index.search({ query: "cafe" }).map((r) => r.path), ["unicode.md"]);
            assert.deepEqual(index.search({ query: "run" }).map((r) => r.path), ["unicode.md"]);
        } finally {
            index.close();
        }
    });

    it("filters by folder, tag, and modification time", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.update(
                "coax/current.md",
                "---\ntags: [playback, recovery]\n---\n# Current\nprovider timeline",
                300,
            );
            index.update(
                "coax/old.md",
                "---\ntags: [playback]\n---\n# Old\nprovider timeline",
                100,
            );
            index.update(
                "other/current.md",
                "---\ntags: [recovery]\n---\nprovider timeline",
                300,
            );

            const results = index.search({
                query: "provider",
                folder: "coax",
                tag: "recovery",
                modifiedAfter: 200,
            });
            assert.deepEqual(results.map((r) => r.path), ["coax/current.md"]);
        } finally {
            index.close();
        }
    });

    it("uses exact aliases and groups multiple matching passages by note", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.update(
                "coax/provider.md",
                `---
aliases:
  - Edge recovery
---
# Stream behavior

## Detection
Provider recovery starts here with a resilience signal.

## Retry
Provider recovery continues here with a resilience signal.`,
                100,
            );
            index.update("other.md", "An edge recovery phrase appears only in body text.", 100);

            const aliasResults = index.search({ query: "Edge recovery" });
            assert.equal(aliasResults[0].path, "coax/provider.md");
            const passageResults = index.search({ query: "resilience signal" });
            assert.deepEqual(passageResults.map((result) => result.path), ["coax/provider.md"]);
            assert.match(passageResults[0].breadcrumb ?? "", /^Stream behavior > (Detection|Retry)$/);
            assert.equal(index.chunkCount, 3);
        } finally {
            index.close();
        }
    });

    it("keeps a broad title/path prefix from drowning body relevance", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            for (let day = 1; day <= 12; day++) {
                index.update(
                    `meetings/2026-01-${String(day).padStart(2, "0")}.md`,
                    "# Daily log\n\nUnrelated notes about the weather.",
                    day,
                );
            }
            index.update(
                "standup.md",
                "# Team sync\n\nThe weekly meeting covers roadmap and meeting actions.",
                100,
            );

            const results = index.search({ query: "meeting" });
            assert.equal(results[0].path, "standup.md");
            // Prefix-only path matches still surface, ranked below the body match.
            assert.ok(results.some((result) => result.path.startsWith("meetings/")));
        } finally {
            index.close();
        }
    });

    it("counts a note once no matter how many aliases match", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.update(
                "many-aliases.md",
                "---\naliases: [projx one, projx two, projx three, projx four]\n---\nBody.",
                100,
            );
            index.update("exact.md", "---\naliases: [projx]\n---\nBody.", 100);

            // One exact alias must outrank several prefix-only aliases; before
            // deduplication the prefix rows summed into a higher fused score.
            const results = index.search({ query: "projx" });
            assert.deepEqual(
                results.map((result) => result.path),
                ["exact.md", "many-aliases.md"],
            );
        } finally {
            index.close();
        }
    });

    it("persists tags, links, backlinks, and checkpoints transactionally", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.beginBatch();
            index.update("source.md", "---\ntags: [Project]\n---\nSee [[folder/Target]]", 10);
            index.checkpoint = "rolled-back";
            index.rollbackBatch();
            assert.equal(index.size, 0);
            assert.equal(index.checkpoint, "");

            index.beginBatch();
            index.update("source.md", "---\ntags: [Project]\n---\nSee [[folder/Target]]", 10);
            index.checkpoint = "committed";
            index.commitBatch();
            assert.deepEqual(index.getTags("source.md"), ["Project"]);
            assert.deepEqual(index.getLinks("source.md"), ["folder/Target"]);
            assert.deepEqual(index.getBacklinks("folder/Target.md"), ["source.md"]);
            assert.equal(index.checkpoint, "committed");
        } finally {
            index.close();
        }
    });

    it("updates, removes, and clears notes without stale matches", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.update("note.md", "old terminology", 100);
            index.update("note.md", "new terminology", 200);
            assert.equal(index.search({ query: "old" }).length, 0);
            assert.equal(index.search({ query: "new" }).length, 1);

            index.remove("note.md");
            assert.equal(index.search({ query: "new" }).length, 0);

            index.update("one.md", "searchable", 100);
            index.update("two.md", "searchable", 100);
            index.clear();
            assert.equal(index.size, 0);
        } finally {
            index.close();
        }
    });

    it("commits and rolls back bulk update batches", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.beginBatch();
            index.update("committed.md", "durable batch marker", 1);
            index.commitBatch();
            assert.deepEqual(
                index.search({ query: "durable" }).map((result) => result.path),
                ["committed.md"],
            );

            index.beginBatch();
            index.update("rolled-back.md", "temporary batch marker", 2);
            index.rollbackBatch();
            assert.equal(index.search({ query: "temporary" }).length, 0);
            assert.equal(index.size, 1);
        } finally {
            index.close();
        }
    });

    it("persists the disk-backed corpus across process lifetimes", async () => {
        const path = join(tmpDir, "persistent.sqlite");
        const first = await FullTextIndex.open(path);
        first.update("note.md", "durable provider recovery evidence", 123);
        first.close();

        const second = await FullTextIndex.open(path);
        try {
            assert.equal(second.createdFresh, false);
            assert.equal(second.size, 1);
            assert.deepEqual(
                second.search({ query: "durable recovery" }).map((r) => r.path),
                ["note.md"],
            );
        } finally {
            second.close();
        }
    });

    it("archives an index when its persisted backend identity does not match", async () => {
        const path = join(tmpDir, "backend-identity.sqlite");
        const first = await FullTextIndex.open(path, { backendIdentity: "backend-a" });
        first.update("wrong-vault.md", "must not survive identity mismatch", 123);
        first.checkpoint = "unsafe-checkpoint";
        first.close();

        const second = await FullTextIndex.open(path, { backendIdentity: "backend-b" });
        try {
            assert.equal(second.recreatedForIdentityMismatch, true);
            assert.equal(second.size, 0);
            assert.equal(second.checkpoint, "");
        } finally {
            second.close();
        }
        const names = await readdir(tmpDir);
        assert.ok(names.some((name) =>
            name.startsWith("backend-identity.sqlite.backend-mismatch-") && name.endsWith(".bak")));
    });

    it("preserves backend identity across clear() so a rebuilt index is not archived on reopen", async () => {
        const path = join(tmpDir, "clear-identity.sqlite");
        const first = await FullTextIndex.open(path, { backendIdentity: "backend-a" });
        first.update("before.md", "content before the rebuild", 100);
        // Simulate the CouchDB catch-up fallback: clear the corpus, then rebuild
        // from scratch against the same backend.
        first.clear();
        first.update("after.md", "content after the rebuild", 200);
        first.checkpoint = "rebuilt-checkpoint";
        first.close();

        const second = await FullTextIndex.open(path, { backendIdentity: "backend-a" });
        try {
            assert.equal(second.recreatedForIdentityMismatch, false);
            assert.equal(second.size, 1);
            assert.deepEqual(
                second.search({ query: "after" }).map((r) => r.path),
                ["after.md"],
            );
        } finally {
            second.close();
        }
        // The rebuilt index must not have been archived as an identity mismatch.
        const names = await readdir(tmpDir);
        assert.ok(!names.some((name) =>
            name.startsWith("clear-identity.sqlite.backend-mismatch-") && name.endsWith(".bak")));
    });

    it("persists a newer mtime even when note content is unchanged", async () => {
        const index = await FullTextIndex.open(":memory:");
        try {
            index.update("same-content.md", "unchanged body", 100);
            index.update("same-content.md", "unchanged body", 200);
            assert.equal(index.getMtime("same-content.md"), 200);
            assert.deepEqual(
                index.search({ query: "unchanged" }).map((result) => result.path),
                ["same-content.md"],
            );
        } finally {
            index.close();
        }
    });

    it("archives an incompatible schema before rebuilding", async () => {
        const path = join(tmpDir, "old-schema.sqlite");
        const old = await FullTextIndex.open(path);
        old.close();
        const Database = (await import("better-sqlite3-multiple-ciphers")).default;
        const raw = new Database(path);
        raw.pragma("user_version = 1");
        raw.close();

        const rebuilt = await FullTextIndex.open(path);
        try {
            assert.equal(rebuilt.recreatedForSchemaMismatch, true);
            assert.equal(rebuilt.size, 0);
        } finally {
            rebuilt.close();
        }
        const names = await readdir(tmpDir);
        assert.ok(names.some((name) => name.startsWith("old-schema.sqlite.schema-v1-") && name.endsWith(".bak")));
    });

    it("encrypts persisted note text and rejects the wrong key", async () => {
        const path = join(tmpDir, "encrypted.sqlite");
        const key = deriveFullTextIndexKey("correct horse battery staple", "encrypted-test");
        const wrongKey = deriveFullTextIndexKey("wrong passphrase", "encrypted-test");
        const secret = "highly sensitive recovery hypothesis";

        const first = await FullTextIndex.open(path, { encryptionKey: key });
        first.update("secret.md", secret, 123);
        first.close();

        const bytes = await readFile(path);
        assert.notEqual(bytes.subarray(0, 16).toString("binary"), "SQLite format 3\0", "file header must be encrypted");
        assert.equal(bytes.includes(Buffer.from(secret)), false, "note body must not appear in the file");
        await assert.rejects(
            () => FullTextIndex.open(path, { encryptionKey: wrongKey }),
            /Unable to unlock the encrypted full-text index/,
        );

        const second = await FullTextIndex.open(path, { encryptionKey: key });
        try {
            assert.equal(second.encryptedAtRest, true);
            assert.deepEqual(second.search({ query: "sensitive" }).map((r) => r.path), ["secret.md"]);
        } finally {
            second.close();
        }
    });

    it("keeps encrypted database artifacts private and free of plaintext", async () => {
        const path = join(tmpDir, "encrypted-artifacts.sqlite");
        const key = deriveFullTextIndexKey("artifact passphrase", "artifact-test");
        const firstSecret = "confidential durable decision marker";
        const secondSecret = "confidential transactional journal marker";

        const index = await FullTextIndex.open(path, { encryptionKey: key });
        index.update("first.md", firstSecret, 1);
        index.beginBatch();
        index.update("second.md", secondSecret, 2);

        const duringTransaction = (await readdir(tmpDir))
            .filter((name) => name.startsWith("encrypted-artifacts.sqlite"));
        assert.ok(
            duringTransaction.includes("encrypted-artifacts.sqlite-journal"),
            "the test must inspect an active rollback journal",
        );
        for (const name of duringTransaction) {
            const artifactPath = join(tmpDir, name);
            const bytes = await readFile(artifactPath);
            assert.equal(bytes.includes(Buffer.from(firstSecret)), false, `${name} exposed committed note text`);
            assert.equal(bytes.includes(Buffer.from(secondSecret)), false, `${name} exposed pending note text`);
            assert.equal((await stat(artifactPath)).mode & 0o777, 0o600, `${name} must be owner-only`);
        }

        index.commitBatch();
        index.close();
        assert.equal(
            (await readdir(tmpDir)).includes("encrypted-artifacts.sqlite-journal"),
            false,
            "the rollback journal must be removed after commit and close",
        );

        const Database = (await import("better-sqlite3-multiple-ciphers")).default;
        const raw = new Database(path);
        raw.pragma("cipher = sqlcipher");
        raw.key(key);
        raw.pragma("user_version = 1");
        raw.close();

        const rebuilt = await FullTextIndex.open(path, { encryptionKey: key });
        rebuilt.close();
        const afterRebuild = (await readdir(tmpDir))
            .filter((name) => name.startsWith("encrypted-artifacts.sqlite"));
        assert.ok(afterRebuild.some((name) => name.endsWith(".bak")), "encrypted schema backup missing");
        for (const name of afterRebuild) {
            const artifactPath = join(tmpDir, name);
            const bytes = await readFile(artifactPath);
            assert.notEqual(bytes.subarray(0, 16).toString("binary"), "SQLite format 3\0", `${name} is plaintext SQLite`);
            assert.equal(bytes.includes(Buffer.from(firstSecret)), false, `${name} exposed note text`);
            assert.equal(bytes.includes(Buffer.from(secondSecret)), false, `${name} exposed note text`);
            assert.equal((await stat(artifactPath)).mode & 0o777, 0o600, `${name} must be owner-only`);
        }
    });

    it("migrates an existing plaintext index to encrypted storage", async () => {
        const path = join(tmpDir, "plaintext-migration.sqlite");
        const key = deriveFullTextIndexKey("migration passphrase", "migration-test");
        const first = await FullTextIndex.open(path);
        first.update("legacy.md", "legacy plaintext marker", 321);
        first.close();
        assert.equal(
            (await readFile(path)).subarray(0, 16).toString("binary"),
            "SQLite format 3\0",
        );

        const migrated = await FullTextIndex.open(path, { encryptionKey: key });
        try {
            assert.equal(migrated.migratedFromPlaintext, true);
            assert.deepEqual(migrated.search({ query: "legacy" }).map((r) => r.path), ["legacy.md"]);
        } finally {
            migrated.close();
        }
        assert.notEqual(
            (await readFile(path)).subarray(0, 16).toString("binary"),
            "SQLite format 3\0",
        );
        for (const name of (await readdir(tmpDir)).filter((name) =>
            name.startsWith("plaintext-migration.sqlite"))) {
            const artifactPath = join(tmpDir, name);
            const bytes = await readFile(artifactPath);
            assert.equal(bytes.includes(Buffer.from("legacy plaintext marker")), false, `${name} retained plaintext`);
            assert.equal((await stat(artifactPath)).mode & 0o777, 0o600, `${name} must be owner-only`);
        }
    });

    it("re-keys an HKDF-only encrypted index with the password-hardened key", async () => {
        const path = join(tmpDir, "legacy-key-migration.sqlite");
        const passphrase = "legacy migration passphrase";
        const vaultId = "legacy-migration-test";
        const legacyKey = deriveLegacyFullTextIndexKey(passphrase, vaultId);
        const hardenedKey = deriveFullTextIndexKey(passphrase, vaultId);

        const legacy = await FullTextIndex.open(path, { encryptionKey: legacyKey });
        legacy.update("legacy.md", "legacy encrypted provider marker", 456);
        legacy.close();

        await assert.rejects(
            () => FullTextIndex.open(path, { encryptionKey: hardenedKey }),
            /Unable to unlock the encrypted full-text index/,
        );

        const migrated = await FullTextIndex.open(path, {
            encryptionKey: hardenedKey,
            legacyEncryptionKey: legacyKey,
        });
        try {
            assert.equal(migrated.migratedFromLegacyEncryption, true);
            assert.deepEqual(
                migrated.search({ query: "provider" }).map((result) => result.path),
                ["legacy.md"],
            );
        } finally {
            migrated.close();
        }

        const reopened = await FullTextIndex.open(path, {
            encryptionKey: hardenedKey,
            legacyEncryptionKey: legacyKey,
        });
        try {
            assert.equal(reopened.migratedFromLegacyEncryption, false);
            assert.deepEqual(
                reopened.search({ query: "encrypted" }).map((result) => result.path),
                ["legacy.md"],
            );
        } finally {
            reopened.close();
        }

        await assert.rejects(
            () => FullTextIndex.open(path, { encryptionKey: legacyKey }),
            /Unable to unlock the encrypted full-text index/,
        );
    });
});
