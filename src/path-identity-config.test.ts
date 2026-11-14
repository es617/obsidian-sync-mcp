import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePathNormalization, resolvePathIdentity } from "./path-identity-config.js";

describe("parsePathNormalization", () => {
    it("defaults to auto when unset or empty", () => {
        assert.equal(parsePathNormalization(undefined), "auto");
        assert.equal(parsePathNormalization(""), "auto");
    });
    it("accepts the three values, case-insensitively", () => {
        assert.equal(parsePathNormalization("auto"), "auto");
        assert.equal(parsePathNormalization("NFC"), "nfc");
        assert.equal(parsePathNormalization(" legacy "), "legacy");
    });
    it("rejects anything else", () => {
        assert.throws(() => parsePathNormalization("nfd"), /must be "auto", "nfc" or "legacy"/);
        assert.throws(() => parsePathNormalization("1"), /COUCHDB_PATH_NORMALIZATION/);
    });
});

describe("resolvePathIdentity", () => {
    const empty = { status: "empty" } as const;
    const legacyDb = { status: "configured", pathNormalizationVersion: 0 } as const;
    const nfcDb = { status: "configured", pathNormalizationVersion: 1 } as const;

    it("auto on an empty database picks NFC and explains how to override", () => {
        const d = resolvePathIdentity("auto", empty);
        assert.equal(d.version, 1);
        assert.match(d.notice!, /COUCHDB_PATH_NORMALIZATION=legacy/);
    });
    it("an explicit choice on an empty database is used silently", () => {
        assert.deepEqual(resolvePathIdentity("legacy", empty), { version: 0 });
        assert.deepEqual(resolvePathIdentity("nfc", empty), { version: 1 });
    });
    it("auto follows an existing database", () => {
        assert.deepEqual(resolvePathIdentity("auto", legacyDb), { version: 0 });
        assert.deepEqual(resolvePathIdentity("auto", nfcDb), { version: 1 });
    });
    it("a matching explicit choice is accepted", () => {
        assert.deepEqual(resolvePathIdentity("legacy", legacyDb), { version: 0 });
        assert.deepEqual(resolvePathIdentity("nfc", nfcDb), { version: 1 });
    });
    it("a contradicting explicit choice fails with guidance", () => {
        assert.throws(() => resolvePathIdentity("legacy", nfcDb), /uses nfc path identity.*rebuild/);
        assert.throws(() => resolvePathIdentity("nfc", legacyDb), /uses legacy path identity/);
    });
});
