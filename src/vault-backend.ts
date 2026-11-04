import type { NoteMetadata } from "./parse.js";

export interface NoteInfo extends NoteMetadata {
    path: string;
    size: number;
    ctime: number;
    mtime: number;
}

export interface NoteListing {
    path: string;
    mtime: number;
}

export interface AttachmentInfo {
    path: string;
    size: number;
    ctime: number;
    mtime: number;
}

/** An attachment appeared or changed (info), or was deleted (null). */
export type AttachmentChangeCallback = (path: string, info: { size: number; mtime: number } | null) => void;

export interface VaultBackend {
    init(): Promise<void>;
    close(): Promise<void>;
    readNote(path: string): Promise<string | null>;
    writeNote(path: string, content: string): Promise<boolean>;
    deleteNote(path: string): Promise<boolean>;
    moveNote(from: string, to: string): Promise<boolean>;
    getMetadata(path: string): Promise<NoteInfo | null>;
    listNotes(folder?: string): Promise<string[]>;
    listNotesWithMtime(folder?: string): Promise<NoteListing[]>;
    /** Binary attachments (see attachment-path.ts). Paths are validated by the backend too. */
    writeAttachment(path: string, data: Uint8Array): Promise<boolean>;
    deleteAttachment(path: string): Promise<boolean>;
    moveAttachment(from: string, to: string): Promise<boolean>;
    getAttachmentInfo(path: string): Promise<AttachmentInfo | null>;
    /** Every attachment in the vault. Local mode only; CouchDB mode learns them from the change feed. */
    listAttachments?(): Promise<AttachmentInfo[]>;
    /** `onAttachment` also reports attachment changes, from metadata only (no chunks are loaded). */
    watchChanges?(callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void, onAttachment?: AttachmentChangeCallback): void;
    /**
     * Catch up on changes since a sequence. Returns the new sequence. CouchDB only.
     * `stats.unreadable` counts documents that could not be decrypted or loaded
     * and were therefore skipped — the caller reports them so "caught up" never
     * hides a silent miss.
     */
    catchUp?(since: string, callback: (path: string, content: string | null, mtime?: number) => void, onBatch?: (since: string, processed: number) => Promise<void>, stats?: { unreadable: number }, onAttachment?: AttachmentChangeCallback): Promise<string>;
}
