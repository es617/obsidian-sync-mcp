/**
 * Decide the vault's path identity (LiveSync "path normalisation version")
 * from COUCHDB_PATH_NORMALIZATION and what the database declares.
 *
 * Kept dependency-free so the decision is unit-testable in isolation.
 *
 * Version 1 (`nfc-path-identity-v1`) applies Unicode NFC to a path before its
 * document ID is derived, so `Café.md` typed as NFC or NFD is the same note.
 * LiveSync 1.0.49+ uses it for new vaults; older vaults use version 0. The
 * library refuses a database whose declaration differs from the setting, and
 * a database with notes cannot change version without a rebuild.
 */

export type PathNormalizationSetting = "auto" | "nfc" | "legacy";

/** What the database declares: nothing yet, or an existing version. */
export type PathIdentityState = { status: "empty" } | { status: "configured"; pathNormalizationVersion: 0 | 1 };

export interface PathIdentityDecision {
    version: 0 | 1;
    /** Startup message worth logging, if any. */
    notice?: string;
}

const NAMES: Record<0 | 1, string> = { 0: "legacy", 1: "nfc" };

export function parsePathNormalization(raw: string | undefined): PathNormalizationSetting {
    const value = (raw ?? "").trim().toLowerCase();
    if (value === "" || value === "auto") return "auto";
    if (value === "nfc" || value === "legacy") return value;
    throw new Error(`COUCHDB_PATH_NORMALIZATION must be "auto", "nfc" or "legacy" (got "${raw}").`);
}

export function resolvePathIdentity(setting: PathNormalizationSetting, state: PathIdentityState): PathIdentityDecision {
    if (state.status === "empty") {
        if (setting === "legacy") return { version: 0 };
        if (setting === "nfc") return { version: 1 };
        return {
            version: 1,
            notice:
                "Empty database: using Unicode NFC path identity, the default for vaults created by LiveSync 1.0.49+. " +
                "If your LiveSync devices use legacy path identity (vaults set up before 1.0.49), set COUCHDB_PATH_NORMALIZATION=legacy.",
        };
    }
    const actual = state.pathNormalizationVersion;
    if (setting === "auto" || setting === NAMES[actual]) return { version: actual };
    throw new Error(
        `COUCHDB_PATH_NORMALIZATION=${setting} but this database uses ${NAMES[actual]} path identity. ` +
        "An existing database can't change path identity without a rebuild from LiveSync. " +
        "Unset COUCHDB_PATH_NORMALIZATION (or set it to auto) to follow the database.",
    );
}
