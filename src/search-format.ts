/**
 * Response wording for search_notes. Pure functions, no MCP/vault types, so
 * the index-status line — the part a client relies on to judge freshness —
 * is unit-testable against fixed instants.
 *
 * Every search response opens with one status line that says which CouchDB
 * sequence the index is caught up with, the server time (local zone plus UTC),
 * how old that is, how many notes carry content, and whether any document
 * could not be read during the pre-search catch-up. "Caught up" must never
 * hide a silent miss.
 */

import type { IndexState, SearchHit } from "./search.js";

/** Zone used for the human-readable half of the timestamp (default: the server's own zone). UTC is always printed beside it. */
export const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export interface SyncStatus {
    /** "couchdb" when a catch-up ran (or was attempted) before the search; "local" for a VAULT_PATH vault. */
    mode: "couchdb" | "local";
    state: IndexState;
    /** The index's CouchDB sequence after the catch-up (raw, e.g. "39995-g1AAAA…"). */
    seq: string;
    /** When the sequence last advanced (ms), null before the first catch-up. */
    syncedAt: number | null;
    /** Server time the response was built (ms). */
    now: number;
    notes: number;
    withContent: number;
    /** Documents the catch-up could not decrypt or load. */
    unreadable: number;
    /** Set when the pre-search catch-up threw; hits then come from the index as it was. */
    error?: string;
}

/** "2026-09-20 15:30 CEST (13:30Z)" — local zone from Intl (sv-SE yields CET/CEST), UTC beside it. */
export function formatServerTime(ms: number, timeZone: string = DISPLAY_TIMEZONE): string {
    const d = new Date(ms);
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
    }).formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const utc = d.toISOString().slice(11, 16);
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")} (${utc}Z)`;
}

/** The numeric prefix of a CouchDB sequence ("39995" from "39995-g1AAAA…"); "none" when empty. */
export function seqPrefix(seq: string): string {
    if (!seq) return "none";
    const dash = seq.indexOf("-");
    return dash === -1 ? seq : seq.slice(0, dash);
}

function minutesBetween(from: number, to: number): number {
    return Math.max(0, Math.round((to - from) / 60_000));
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** First line of every search_notes response. */
export function describeSync(s: SyncStatus): string {
    const now = formatServerTime(s.now);
    const coverage = `${s.withContent} of ${plural(s.notes, "note")} with content`;
    if (s.mode === "local") {
        return `Index: local vault, no sequence — ${now}; ${coverage}.`;
    }
    if (s.state === "building") {
        return `Index: still building (${plural(s.notes, "note")} so far), not caught up — ${now}; results may be incomplete.`;
    }
    if (s.state === "failed") {
        return `Index: rebuild failed at startup (see server log), not caught up — ${now}; results may be incomplete or stale.`;
    }
    if (s.error) {
        const last = s.syncedAt === null ? "never" : `${formatServerTime(s.syncedAt)}, ${minutesBetween(s.syncedAt, s.now)} min ago`;
        return `Index: catch-up failed (${s.error}); last caught up with CouchDB seq ${seqPrefix(s.seq)} — ${last}; results may be stale.`;
    }
    const age = s.syncedAt === null ? 0 : minutesBetween(s.syncedAt, s.now);
    let line = `Index caught up with CouchDB seq ${seqPrefix(s.seq)} — ${now}, ${age} min; ${coverage}`;
    if (s.unreadable > 0) {
        line += `; ${plural(s.unreadable, "document")} could not be read`;
    }
    return line + ".";
}

/** What was searched, for the second line. */
export function describeQuery(terms: string[]): string {
    return terms.map((t) => `"${t}"`).join(", ");
}

/**
 * Hit lines: path with deep link and modification time (same shape as
 * list_notes), then one indented context line. Never the note body.
 */
export function describeHits(
    hits: SearchHit[],
    total: number,
    query: string,
    deepLink: (path: string) => string,
): string {
    if (total === 0) return `No notes match ${query}.`;
    const shown = hits.length < total ? ` (showing ${hits.length}; narrow with folder, tag or modified_after)` : "";
    const nameHits = hits.filter((h) => h.nameHit).length;
    const byName = nameHits > 0 ? ` ${plural(nameHits, "hit")} by path or title listed first.` : "";
    const header = `${plural(total, "note")} ${total === 1 ? "matches" : "match"} ${query}${shown}.${byName} Call read_note on a hit before relying on it.`;
    const lines = hits.map((h) => {
        const date = h.mtime ? new Date(h.mtime).toISOString().slice(0, 16) : "";
        const context = h.nameHit
            ? (h.snippet ? `[path/title] ${h.snippet}` : "[path/title match]")
            : h.snippet;
        return `- ${date} [${h.path}](${deepLink(h.path)})\n  ${context}`;
    });
    return [header, ...lines].join("\n");
}
