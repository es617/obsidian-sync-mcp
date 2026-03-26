/**
 * Parse Obsidian markdown content for frontmatter, tags, and links.
 */

export interface NoteMetadata {
    frontmatter: Record<string, string>;
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
            let inTagsList = false;
            for (const line of yaml.split("\n")) {
                // Multi-line tags list item: "  - tagname"
                if (inTagsList) {
                    const listItem = line.match(/^\s+-\s+(.+)/);
                    if (listItem) {
                        const trimmed = listItem[1].trim();
                        if (trimmed) tags.add(trimmed);
                        continue;
                    }
                    inTagsList = false;
                }

                const match = line.match(/^(\w[\w-]*)\s*:\s*(.+)/);
                if (match) {
                    frontmatter[match[1]] = match[2].trim();
                }
                // Frontmatter tags (inline: [a, b] or start of multi-line list)
                if (/^tags\s*:/.test(line)) {
                    const value = line.replace(/^tags\s*:\s*/, "").trim();
                    if (value) {
                        // Inline: tags: [a, b] or tags: a, b
                        const tagValues = value.replace(/[[\]]/g, "");
                        for (const t of tagValues.split(",")) {
                            const trimmed = t.trim();
                            if (trimmed) tags.add(trimmed);
                        }
                    } else {
                        // Multi-line list follows
                        inTagsList = true;
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

export function extractSnippet(content: string, query: string, context = 80): string {
    const lower = content.toLowerCase();

    // Try exact phrase first
    let idx = lower.indexOf(query.toLowerCase());

    // Try to find the smallest span containing all query words
    if (idx === -1) {
        const words = query.split(/\s+/).filter((w) => w.length >= 3).map((w) => w.toLowerCase());
        if (words.length > 1) {
            let bestStart = -1;
            let bestLen = Infinity;
            // For each occurrence of the first word, find the nearest span containing all words
            const first = words[0];
            let pos = 0;
            while (pos < lower.length) {
                const start = lower.indexOf(first, pos);
                if (start === -1) break;
                // Find last position needed to include all words from this start
                let spanEnd = start + first.length;
                let allFound = true;
                for (let i = 1; i < words.length; i++) {
                    const wi = lower.indexOf(words[i], Math.max(0, start - 200));
                    if (wi === -1) { allFound = false; break; }
                    spanEnd = Math.max(spanEnd, wi + words[i].length);
                }
                if (allFound) {
                    const spanStart = Math.min(start, ...words.map((w) => lower.indexOf(w, Math.max(0, start - 200))).filter((i) => i >= 0));
                    const len = spanEnd - spanStart;
                    if (len < bestLen) { bestStart = spanStart; bestLen = len; }
                }
                pos = start + 1;
            }
            if (bestStart >= 0 && bestLen <= 500) idx = bestStart;
        }
    }

    // Fall back to longest matching word
    if (idx === -1) {
        const words = query.split(/\s+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
        for (const word of words) {
            idx = lower.indexOf(word.toLowerCase());
            if (idx !== -1) break;
        }
    }

    if (idx === -1) {
        return content.slice(0, 160) + (content.length > 160 ? "..." : "");
    }
    const start = Math.max(0, idx - context);
    const end = Math.min(content.length, idx + query.length + context);
    return (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");
}
