/**
 * Decide the manipulator's ID-derivation options from vault config.
 *
 * Kept dependency-free so the gating is unit-testable in isolation.
 *
 * The independent ID key (LiveSync 1.0.33+) only affects how an obfuscated
 * path maps to a document ID, so it must only be applied when path obfuscation
 * is actually in use. Applying it to a plaintext vault — or to a legacy
 * passphrase-derived obfuscated vault — would compute the wrong IDs. When no
 * key is configured the library keeps its legacy (version 0) scheme.
 */
export function idDerivationOptions(
    obfuscatePaths: boolean,
    idDerivationKey?: string,
): { idDerivationVersion: 0 | 1; idDerivationKey?: string } {
    if (obfuscatePaths && idDerivationKey) {
        return { idDerivationVersion: 1, idDerivationKey };
    }
    return { idDerivationVersion: 0 };
}
