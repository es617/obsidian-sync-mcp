/**
 * Detection of LiveSync's "Obfuscate properties" from document IDs.
 *
 * With obfuscation on, file entries get hashed `_id`s prefixed `f:` instead of
 * path-based IDs, so a sample of IDs reveals which mode the vault actually
 * uses — regardless of what COUCHDB_OBFUSCATE_PROPERTIES claims.
 *
 * LiveSync's namespaced file documents — hidden-file sync (`i:`),
 * customization sync (`ix:`) and the legacy plugin store (`ps:`) — carry the
 * namespace in front of that ID (`i:f:<hash>` when obfuscated,
 * `i:.obsidian/...` when not), so they are left out of the sample (#62).
 */

export type IdFormat = "obfuscated" | "plain" | "mixed" | "empty";

/** Note documents to collect before classifying. */
export const ID_SAMPLE_TARGET = 100;

const NAMESPACE_PREFIXES = ["i:", "ix:", "ps:"];

export function isNamespacedId(id: string): boolean {
    return NAMESPACE_PREFIXES.some((p) => id.startsWith(p));
}

export function classifyIds(ids: string[]): IdFormat {
    let obfuscated = 0;
    let plain = 0;
    for (const id of ids) {
        if (isNamespacedId(id)) continue;
        if (id.startsWith("f:")) obfuscated++;
        else plain++;
    }
    if (obfuscated === 0 && plain === 0) return "empty";
    if (obfuscated > 0 && plain > 0) return "mixed";
    return obfuscated > 0 ? "obfuscated" : "plain";
}
