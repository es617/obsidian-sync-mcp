export function OpenKeyValueDatabase(_name: string): Promise<any> {
    throw new Error("KeyValueDB not available in headless mode");
}
