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

export interface WriteOptions {
    /** Replace an existing file. Default false. */
    overwrite?: boolean;
}

export interface MoveOptions extends WriteOptions {
    /**
     * Largest file a backend may load into memory to move it. CouchDB mode
     * copies the bytes (read, write, delete); local mode renames and ignores it.
     */
    maxBytes?: number;
}

/** A move would have to load a file larger than `MoveOptions.maxBytes`. */
export class AttachmentTooLargeError extends Error {
    constructor(readonly path: string, readonly size: number, readonly limit: number) {
        super(`Attachment is ${size} bytes, over the ${limit}-byte limit for moving it: ${path}`);
        this.name = "AttachmentTooLargeError";
    }
}

/** A write or move without `overwrite` found a file already at the destination. */
export class AttachmentExistsError extends Error {
    constructor(readonly path: string) {
        super(`Attachment already exists: ${path}`);
        this.name = "AttachmentExistsError";
    }
}

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
    /**
     * Binary attachments (see attachment-path.ts). Paths are validated by the backend too.
     * Without `overwrite`, writing or moving onto an existing file throws
     * AttachmentExistsError, checked in the same step as the write.
     */
    writeAttachment(path: string, data: Uint8Array, options?: WriteOptions): Promise<boolean>;
    deleteAttachment(path: string): Promise<boolean>;
    moveAttachment(from: string, to: string, options?: MoveOptions): Promise<boolean>;
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
