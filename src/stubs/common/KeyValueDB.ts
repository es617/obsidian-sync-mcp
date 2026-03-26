// Stub: KeyValueDB not used in Node (uses IndexedDB in browser)
export function OpenKeyValueDatabase(_name: string): any {
    return {
        get: async () => undefined,
        set: async () => {},
        del: async () => {},
        keys: async () => [],
        close: async () => {},
    };
}
