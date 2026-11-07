/**
 * Parse Obsidian markdown content for frontmatter, tags, and links.
 */

import { isValidAttachmentPath } from "./attachment-path.js";

export interface NoteMetadata {
    frontmatter: Record<string, string>;
    tags: string[];
    links: string[];
}

// Link patterns. Each part stops at a bracket, paren or newline and is capped
// in length. Otherwise a failed match rescans the rest of the note, which is
// quadratic on input like "[".repeat(20000), and parsing is synchronous and
// runs on every note at startup.

// [[wikilinks]]. A #heading, #^block or #page=2 suffix points into the target,
// so [[Note#Heading]] links Note and ![[paper.pdf#page=2]] embeds paper.pdf.
// [[#Heading]] (same note) is not a link.
const WIKILINK = /\[\[([^[\]|#\n]{1,1000})(?:#[^[\]|\n]{0,1000})?(?:\|[^[\]\n]{0,1000})?\]\]/g;

// Markdown link text: plain characters, or one level of [brackets], so
// [see [1]](note.md) and [![thumb](t.png)](full.png) parse. The two
// alternatives never match the same character, so this adds no backtracking.
const LINK_LABEL = String.raw`[^[\]\n]|\[[^[\]\n]{0,1000}\]`;

// [markdown links](path.md), also with a #heading: [x](path.md#Heading) links path.md.
const NOTE_LINK = new RegExp(String.raw`\[(?:${LINK_LABEL}){1,1000}\]\(([^()#\n]{1,1000}\.md)(?:#[^()\n]{0,1000})?\)`, "g");

// Markdown links and embeds to attachments: ![](Attachments/shot.png),
// [report](<docs/Q1 report.pdf>), ![alt](my%20image.png "title").
const ATTACHMENT_LINK = new RegExp(String.raw`\[((?:${LINK_LABEL}){0,1000})\]\((<[^<>\n]{1,1000}>|[^()\s]{1,1000})(?:\s+"[^"\n]{0,1000}")?\)`, "g");

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
        if (/^\p{Nd}+$/u.test(match[2])) continue;
        tags.add(match[2]);
    }

    for (const match of content.matchAll(WIKILINK)) links.push(match[1]);
    for (const match of content.matchAll(NOTE_LINK)) links.push(match[1]);
    addAttachmentLinks(content, links);

    return { frontmatter, tags: [...tags], links: [...new Set(links)] };
}

/**
 * Add the attachment targets of markdown links in `text` to `links`, recorded
 * URL-decoded so list_attachments can tell which files are still used. Also
 * looks inside each link's text once, since matches don't overlap and the
 * outer link of [![thumb](t.png)](full.png) would hide the inner image.
 */
function addAttachmentLinks(text: string, links: string[], nested = false): void {
    for (const match of text.matchAll(ATTACHMENT_LINK)) {
        if (!nested && match[1].includes("[")) addAttachmentLinks(match[1], links, true);
        // Drop a #page=2 fragment, as for wikilinks. Before decoding, since a
        // literal # in a file name is written %23.
        let target = match[2].replace(/^<|>$/g, "").replace(/#.*$/, "");
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.endsWith(".md")) continue;
        // Obsidian URL-decodes markdown link targets (a literal % is written %25).
        try { target = decodeURIComponent(target); } catch { continue; }
        target = target.replace(/^(\.\.?\/)+/, "");
        if (isValidAttachmentPath(target)) links.push(target);
    }
}

/**
 * Replace fenced code blocks (``` or ~~~, opener at line start with up to three
 * spaces of indent, closer of the same character and at least the same length;
 * an unclosed fence runs to the end) and inline code spans (a backtick run of
 * length n closes at the next run of exactly n within the same paragraph — a
 * span never crosses a blank line; an unmatched run is literal)
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
        if (line.trim() === "") {
            flushInline();
            out.push(line);
            continue;
        }
        inline.push(line);
    }
    flushInline();
    return out.join("\n");
}

function maskInlineSpans(text: string): string {
    // Collect backtick runs in one pass, then link each run to the next run of
    // the same length (scanning right to left) so matching stays linear.
    const runs: { at: number; len: number }[] = [];
    for (let i = 0; i < text.length; ) {
        if (text[i] !== "`") { i++; continue; }
        let n = 0;
        while (text[i + n] === "`") n++;
        runs.push({ at: i, len: n });
        i += n;
    }
    const next: number[] = [];
    const seen = new Map<number, number>();
    for (let r = runs.length - 1; r >= 0; r--) {
        next[r] = seen.get(runs[r].len) ?? -1;
        seen.set(runs[r].len, r);
    }
    let result = "";
    let from = 0;
    for (let r = 0; r < runs.length; ) {
        const c = next[r];
        if (c === -1) { r++; continue; }
        const start = runs[r].at;
        const end = runs[c].at + runs[c].len;
        result += text.slice(from, start) + text.slice(start, end).replace(/[^\n]/g, ".");
        from = end;
        r = c + 1;
    }
    return result + text.slice(from);
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
