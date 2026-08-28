export async function startAfterSuccessfulRebuild(
    rebuild: Promise<unknown>,
    start: () => void | Promise<void>,
): Promise<boolean> {
    try {
        await rebuild;
    } catch {
        return false;
    }

    await start();
    return true;
}
