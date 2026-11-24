/**
 * Parse Obsidian markdown content for frontmatter, tags, and links.
 */

import MarkdownIt, { type Token } from "markdown-it";
import { parse as parseYaml } from "yaml";
import { isValidAttachmentPath } from "./attachment-path.js";

export interface NoteMetadata {
    frontmatter: Record<string, string>;
    tags: string[];
    links: string[];
}

// [[wikilinks]] and ![[embeds]], which markdown doesn't know, so they are
// matched in the text markdown-it leaves outside code. A #heading, #^block or
// #page=2 suffix points into the target, so [[Note#Heading]] links Note;
// [[#Heading]] (same note) is not a link. Each part stops at a bracket or
// newline, so a failed match only scans up to the next one.
const WIKILINK = /\[\[([^[\]|#\n]+)(?:#[^[\]|\n]*)?(?:\|[^[\]\n]*)?\]\]/g;

// Inline #tags. A tag must contain at least one non-numerical character
// ("#1984 isn't a valid tag, but #y1984 is" — obsidian.md/help/tags).
const TAG = /(^|\s)#([\p{L}\p{N}_/-][\p{L}\p{M}\p{N}_/-]*)/gu;

// CommonMark plus GFM tables. Raw HTML is recognised, so a backtick inside a
// tag's attribute can't open a code span; text between tags is still read.
const markdown = new MarkdownIt({ html: true, linkify: false });

export function parseFrontmatterAndLinks(content: string): NoteMetadata {
    content = content.replace(/\r\n/g, "\n");
    // Frontmatter runs from a "---" first line to the next "---" line.
    const end = content.startsWith("---\n") ? content.indexOf("\n---", 4) : -1;
    const yaml = end === -1 ? "" : content.slice(4, end);
    const body = end === -1 ? content : content.slice(end + 4);

    const { frontmatter, tags } = readFrontmatter(yaml);
    const links: string[] = [];
    // Links in properties (related: "[[Note]]") count.
    for (const match of yaml.matchAll(WIKILINK)) links.push(match[1]);

    const text = readBody(markdown.parse(body, {}), links);
    for (const match of text.matchAll(WIKILINK)) links.push(match[1]);
    for (const match of text.matchAll(TAG)) {
        if (!/^\p{Nd}+$/u.test(match[2])) tags.add(match[2]);
    }
    return { frontmatter, tags: [...tags], links: [...new Set(links)] };
}

/**
 * Frontmatter as YAML, every value kept as a string ("failsafe": 1.10 stays
 * 1.10, dates aren't converted); a list is joined with ", ". Tags come from
 * `tags`, as a list or a comma-separated string. Frontmatter that isn't valid
 * YAML, or uses aliases, is ignored, as Obsidian does for invalid YAML.
 */
function readFrontmatter(yaml: string): { frontmatter: Record<string, string>; tags: Set<string> } {
    const frontmatter: Record<string, string> = {};
    const tags = new Set<string>();
    let data: unknown;
    try {
        // maxAliasCount 0 rejects YAML aliases (*x): resolving them rescans the
        // document, which hostile frontmatter can make take minutes.
        data = parseYaml(yaml, { schema: "failsafe", uniqueKeys: false, maxAliasCount: 0 });
    } catch {
        return { frontmatter, tags };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { frontmatter, tags };

    for (const [key, value] of Object.entries(data)) {
        if (value === "" || value === null) continue;
        frontmatter[key] = typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : JSON.stringify(value);
    }
    const raw: unknown = (data as Record<string, unknown>).tags;
    for (const tag of Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : []) {
        if (typeof tag === "string" && tag.trim()) tags.add(tag.trim());
    }
    return { frontmatter, tags };
}

/**
 * Walk markdown-it's tokens: add markdown link and image targets to `links`,
 * and return the note's text outside code, one block per line, for the
 * wikilink and tag patterns. Code spans, fenced and indented code are left
 * out, since Obsidian doesn't link or tag inside them.
 */
function readBody(tokens: Token[], links: string[]): string {
    let text = "";
    const visit = (tokens: Token[]) => {
        for (const token of tokens) {
            switch (token.type) {
                case "inline": visit(token.children ?? []); break;
                case "text": text += token.content; break;
                // A code span leaves a "|", which can't start a tag or a
                // wikilink target, so its neighbours don't join up:
                // `x`#tag isn't a tag, [[note|`alias`]] still links note.
                case "code_inline": text += "|"; break;
                case "softbreak": case "hardbreak": text += "\n"; break;
                case "link_open": addTarget(token.attrGet("href"), links); break;
                case "image": addTarget(token.attrGet("src"), links); visit(token.children ?? []); break;
                default: if (token.block && token.nesting === -1) text += "\n";
            }
        }
    };
    visit(tokens);
    return text;
}

/**
 * Record a markdown link target: a note (.md) or an attachment, URL-decoded as
 * Obsidian does, so list_attachments can tell which files are still used.
 * External URLs and same-note #heading links are skipped.
 */
function addTarget(href: string | number | null, links: string[]): void {
    // Drop a #heading or #page=2 fragment. Before decoding, since a literal #
    // in a file name is written %23.
    let target = String(href ?? "").replace(/#.*$/, "");
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return;
    try { target = decodeURIComponent(target); } catch { return; }
    target = target.replace(/^(\.\.?\/)+/, "");
    if (target.endsWith(".md") || isValidAttachmentPath(target)) links.push(target);
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
