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

                const match = line.match(/^([\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*)\s*:\s*(.+)/u);
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

    // Inline #tags. Obsidian does not read tags out of code, and a tag must
    // contain at least one non-numerical character ("#1984 isn't a valid tag,
    // but #y1984 is" — obsidian.md/help/tags), so code spans and fenced blocks
    // are masked out first and all-digit matches are dropped.
    for (const match of maskCode(content).matchAll(/(^|\s)#([\p{L}\p{N}_/-][\p{L}\p{M}\p{N}_/-]*)/gu)) {
        if (/^\p{N}+$/u.test(match[2])) continue;
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

/**
 * Replace fenced code blocks (``` or ~~~, opener at line start with up to three
 * spaces of indent, closer of the same character and at least the same length;
 * an unclosed fence runs to the end) and inline code spans (a backtick run of
 * length n closes at the next run of exactly n; an unmatched run is literal)
 * with dots, so offsets are preserved and nothing inside can start or extend a
 * tag. Indented code blocks, %% comments and math are not masked.
 */
export function maskCode(content: string): string {
    const lines = content.split("\n");
    const out: string[] = [];
    let fence: { char: string; len: number } | null = null;
    const inline: string[] = [];
    const flushInline = () => {
        if (inline.length === 0) return;
        out.push(...maskInlineSpans(inline.join("\n")).split("\n"));
        inline.length = 0;
    };
    for (const line of lines) {
        const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fence) {
            const close = open && open[1][0] === fence.char && open[1].length >= fence.len && line.trim() === open[1];
            out.push(".".repeat(line.length));
            if (close) fence = null;
            continue;
        }
        if (open && (open[1][0] === "~" || !line.slice(open[0].length).includes("`"))) {
            flushInline();
            fence = { char: open[1][0], len: open[1].length };
            out.push(".".repeat(line.length));
            continue;
        }
        inline.push(line);
    }
    flushInline();
    return out.join("\n");
}

function maskInlineSpans(text: string): string {
    let result = "";
    let i = 0;
    while (i < text.length) {
        if (text[i] !== "`") {
            result += text[i++];
            continue;
        }
        let n = 0;
        while (text[i + n] === "`") n++;
        const run = "`".repeat(n);
        // Find the next backtick run of exactly n.
        let j = i + n;
        let closeAt = -1;
        while (j < text.length) {
            const k = text.indexOf(run, j);
            if (k === -1) break;
            let m = 0;
            while (text[k + m] === "`") m++;
            if (m === n) { closeAt = k; break; }
            j = k + m;
        }
        if (closeAt === -1) {
            result += run;
            i += n;
            continue;
        }
        const span = text.slice(i, closeAt + n);
        result += span.replace(/[^\n]/g, ".");
        i = closeAt + n;
    }
    return result;
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
