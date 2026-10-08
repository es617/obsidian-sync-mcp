import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { idDerivationOptions } from "./id-derivation-config.js";

const KEY = "a".repeat(64);

describe("idDerivationOptions — when the independent ID key applies", () => {
    it("uses version 1 + key on an obfuscated vault with a key", () => {
        assert.deepEqual(idDerivationOptions(true, KEY), {
            idDerivationVersion: 1,
            idDerivationKey: KEY,
        });
    });

    it("stays on version 0 when no key is configured (legacy vault)", () => {
        assert.deepEqual(idDerivationOptions(true, undefined), { idDerivationVersion: 0 });
    });

    it("ignores the key on a plaintext (non-obfuscated) vault", () => {
        // Applying the key here would compute wrong IDs; paths aren't hashed.
        assert.deepEqual(idDerivationOptions(false, KEY), { idDerivationVersion: 0 });
    });

    it("stays on version 0 with neither obfuscation nor key", () => {
        assert.deepEqual(idDerivationOptions(false, undefined), { idDerivationVersion: 0 });
    });
});
