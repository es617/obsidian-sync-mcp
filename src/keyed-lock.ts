/**
 * Serialize async work per key, within this process. The CouchDB backend uses
 * it to make an attachment's existence check and write one step.
 */
export class KeyedLock {
    private tails = new Map<string, Promise<void>>();

    /** Run `fn` once every earlier holder of any of `keys` has finished. */
    async run<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
        // Acquire in a fixed order so two multi-key holders cannot deadlock.
        const unique = [...new Set(keys)].sort();
        const releases: Array<() => void> = [];
        try {
            for (const key of unique) releases.push(await this.acquire(key));
            return await fn();
        } finally {
            for (const release of releases.reverse()) release();
        }
    }

    private async acquire(key: string): Promise<() => void> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((r) => (release = r));
        const tail = previous.then(() => current);
        this.tails.set(key, tail);
        await previous;
        return () => {
            release();
            // Drop the entry once nobody is queued behind us.
            if (this.tails.get(key) === tail) this.tails.delete(key);
        };
    }

    /** Keys currently held or queued (for tests). */
    get size(): number {
        return this.tails.size;
    }
}
