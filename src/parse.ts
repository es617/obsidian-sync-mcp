/**
 * Parse Obsidian markdown content for frontmatter, tags, and links.
 */

export interface NoteMetadata {
    frontmatter: Record<string, any>;
    tags: string[];
    links: string[];
}

export function parseFrontmatterAndLinks(content: string): NoteMetadata {
    const frontmatter: Record<string, any> = {};
    const tags = new Set<string>();
    const links: string[] = [];

    // Parse YAML frontmatter
    if (content.startsWith("---\n")) {
        const end = content.indexOf("\n---", 4);
        if (end !== -1) {
            const yaml = content.slice(4, end);
            for (const line of yaml.split("\n")) {
                const match = line.match(/^(\w[\w-]*)\s*:\s*(.+)/);
                if (match) {
                    frontmatter[match[1]] = match[2].trim();
                }
                // Frontmatter tags
                if (/^tags\s*:/.test(line)) {
                    const tagValues = line.replace(/^tags\s*:\s*/, "").replace(/[[\]]/g, "");
                    for (const t of tagValues.split(",")) {
                        const trimmed = t.trim();
                        if (trimmed) tags.add(trimmed);
                    }
                }
            }
        }
    }

    // Inline #tags
    for (const match of content.matchAll(/(^|\s)#([\w/-]+)/g)) {
        tags.add(match[2]);
    }

    // [[wikilinks]]
    for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
        links.push(match[1]);
    }

    // [markdown links](path.md)
    for (const match of content.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g)) {
        links.push(match[2]);
    }

    return { frontmatter, tags: [...tags], links: [...new Set(links)] };
}
