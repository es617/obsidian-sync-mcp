/**
 * Generate Obsidian deep links for notes.
 * Works on Mac and iOS: obsidian://open?vault=<name>&file=<path>
 */
export function makeDeepLink(vaultName: string, notePath: string): string {
    const cleanPath = notePath.replace(/\.md$/, "");
    const encodedVault = encodeURIComponent(vaultName);
    const encodedPath = encodeURIComponent(cleanPath);
    return `obsidian://open?vault=${encodedVault}&file=${encodedPath}`;
}
