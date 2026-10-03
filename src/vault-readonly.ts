/**
 * READ_ONLY enforcement at the backend layer.
 *
 * READ_ONLY=true already keeps the write tools from being registered. Wrapping
 * the backend as well means a write fails even if some future code path
 * reaches writeNote/deleteNote/moveNote without going through a tool.
 * Kept dependency-free so it is unit-testable in isolation.
 */

import type { VaultBackend } from "./vault-backend.js";

export const READ_ONLY_MESSAGE = "READ_ONLY is enabled: the vault cannot be modified.";

/** Return a backend that delegates reads to `inner` and rejects every write. */
export function readOnlyVault(inner: VaultBackend): VaultBackend {
    const deny = async (): Promise<never> => {
        throw new Error(READ_ONLY_MESSAGE);
    };
    return {
        init: () => inner.init(),
        close: () => inner.close(),
        readNote: (path) => inner.readNote(path),
        getMetadata: (path) => inner.getMetadata(path),
        listNotes: (folder) => inner.listNotes(folder),
        listNotesWithMtime: (folder) => inner.listNotesWithMtime(folder),
        watchChanges: inner.watchChanges?.bind(inner),
        catchUp: inner.catchUp?.bind(inner),
        writeNote: deny,
        deleteNote: deny,
        moveNote: deny,
    };
}
