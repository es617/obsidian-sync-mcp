/**
 * Parse Obsidian markdown content for frontmatter, tags, and links.
 */

import MarkdownIt, { type Token } from "markdown-it";
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";
import { SUPPORTED_ATTACHMENT_EXTENSIONS, isValidAttachmentPath } from "./attachment-path.js";

/**
 * Changes whenever parseFrontmatterAndLinks may return something different for
 * the same note, so metadata the search index saved from an older parser is
 * parsed again, not reused. Bump the number when changing the parser; the
 * attachment extensions are part of it because they decide which link targets
 * count.
 */
export const PARSER_VERSION = `3:${SUPPORTED_ATTACHMENT_EXTENSIONS.join(",")}`;

export interface NoteMetadata {
    frontmatter: Record<string, string>;
    tags: string[];
    links: string[];
}

// [[wikilinks]] and ![[embeds]], which markdown doesn't know. A #heading,
// #^block or #page=2 suffix points into the target, so [[Note#Heading]] links
// Note; [[#Heading]] (same note) is not a link. Each part stops at a bracket
// or newline, so a failed match only scans up to the next one.
const WIKILINK = /\[\[([^[\]|#\n]+)(?:#[^[\]|\n]*)?(?:\|[^[\]\n]*)?\]\]/g;

// Inline #tags. A tag must contain at least one non-numerical character
// ("#1984 isn't a valid tag, but #y1984 is" — obsidian.md/help/tags).
const TAG = /(^|\s)#([\p{L}\p{N}_/-][\p{L}\p{M}\p{N}_/-]*)/gu;

// CommonMark plus GFM tables. Raw HTML is recognised, so a backtick inside a
// tag's attribute can't open a code span.
const markdown = new MarkdownIt({ html: true, linkify: false });

// markdown-it doesn't say where a code span sits in its block's text, so the
// backticks rule is wrapped to record it: env.codeSpans maps a block's inline
// source to its code spans, start offset to end. Blocks with the same text
// have the same spans, so they share an entry.
type Env = { codeSpans: Map<string, Map<number, number>> };
const backticks = markdown.inline.ruler.__rules__[markdown.inline.ruler.__find__("backticks")].fn;
markdown.inline.ruler.at("backticks", (state, silent) => {
    const start = state.pos;
    if (!backticks(state, silent)) return false;
    if (!silent) {
        const spans = (state.env as Env).codeSpans;
        if (!spans.has(state.src)) spans.set(state.src, new Map());
        spans.get(state.src)!.set(start, state.pos);
    }
    return true;
});

export function parseFrontmatterAndLinks(content: string): NoteMetadata {
    content = content.replace(/\r\n/g, "\n");
    // Frontmatter runs from a "---" first line to the next "---" line.
    const end = content.startsWith("---\n") ? content.indexOf("\n---", 4) : -1;
    const yaml = end === -1 ? "" : content.slice(4, end);
    const body = end === -1 ? content : content.slice(end + 4);

    const { frontmatter, tags: yamlTags } = readFrontmatter(yaml);
    const tags = new Set(yamlTags);
    const links: string[] = [];
    const text = readBody(body, links);
    // Wikilinks in properties (related: "[[Note]]") count too.
    for (const match of (yaml + "\n" + text).matchAll(WIKILINK)) {
        // [[note\|alias]] outside a table: the backslash escapes the pipe.
        links.push(match[1].replace(/\\$/, ""));
    }
    for (const match of text.matchAll(TAG)) {
        if (!/^\p{Nd}+$/u.test(match[2])) tags.add(match[2]);
    }
    return { frontmatter, tags: [...tags], links: [...new Set(links)] };
}

/**
 * Frontmatter as YAML ("failsafe": every value is a string as written, so 1.10
 * stays 1.10 and dates aren't converted). A list of plain values is joined
 * with ", ", anything else is kept as written. Tags come from `tags`, a list
 * or a comma-separated string. Frontmatter that isn't valid YAML is ignored,
 * as Obsidian does. Nodes are read directly rather than through toJS(), which
 * rescans the document for every alias.
 */
function readFrontmatter(yaml: string): { frontmatter: Record<string, string>; tags: string[] } {
    const frontmatter: Record<string, string> = {};
    const tags: string[] = [];
    const doc = parseDocument(yaml, { schema: "failsafe", uniqueKeys: false });
    if (doc.errors.length > 0 || !isMap(doc.contents)) return { frontmatter, tags };

    for (const pair of doc.contents.items) {
        const key = resolve(doc, pair.key);
        if (!isScalar(key)) continue;
        const value = resolve(doc, pair.value);
        const list = plainValues(doc, value);
        const text = list ? list.join(", ") : isMap(value) || isSeq(value) ? yaml.slice(value.range![0], value.range![1]).trim() : "";
        if (text) frontmatter[String(key.value)] = text;
        if (key.value === "tags" && list) {
            for (const tag of isScalar(value) ? list[0].split(",") : list) if (tag.trim()) tags.push(tag.trim());
        }
    }
    return { frontmatter, tags };
}

/** A node, or the node an alias (*name) points to. */
function resolve(doc: Document, node: unknown): unknown {
    return isAlias(node) ? node.resolve(doc) : node;
}

/** A plain value as [value], a list of plain values as its values, else null. */
function plainValues(doc: Document, node: unknown): string[] | null {
    if (isScalar(node)) return [String(node.value ?? "")];
    if (!isSeq(node)) return null;
    const values: string[] = [];
    for (const item of node.items) {
        const value = resolve(doc, item);
        if (!isScalar(value)) return null;
        values.push(String(value.value ?? ""));
    }
    return values;
}

// Blocks that only hold other blocks; their lines are claimed by what's inside.
const CONTAINERS = new Set(["blockquote_open", "bullet_list_open", "ordered_list_open", "list_item_open"]);

/**
 * Add the markdown link and image targets to `links`, and return the note's
 * source text with code left out, for the wikilink and tag patterns: each
 * block's raw text with its code spans blanked out, raw HTML blocks (whose
 * markdown links count too), and the lines no block claims (reference and
 * footnote definitions). Fenced and
 * indented code is left out, as Obsidian doesn't link or tag inside code.
 */
function readBody(body: string, links: string[]): string {
    const env: Env = { codeSpans: new Map() };
    const tokens = markdown.parse(body, env);
    const parts: string[] = [];
    const claimed = new Set<number>();
    for (const token of tokens) {
        if (token.map && !CONTAINERS.has(token.type)) {
            for (let line = token.map[0]; line < token.map[1]; line++) claimed.add(line);
        }
        if (token.type === "inline") {
            parts.push(blankOut(token.content, env.codeSpans.get(token.content)));
            addTargets(token.children ?? [], links);
        } else if (token.type === "html_block") {
            // Markdown inside HTML isn't rendered, but a ![](img.png) there
            // still marks the file as used, so its links are read too.
            parts.push(token.content);
            addTargets(markdown.parseInline(token.content, env)[0].children ?? [], links);
        }
    }
    body.split("\n").forEach((line, i) => {
        if (!claimed.has(i)) parts.push(line);
    });
    return parts.join("\n");
}

/**
 * Replace the code spans in `text` with "|", which can't start a tag or a
 * wikilink target, so `x`#tag isn't a tag and [[`Note`]] isn't a link while
 * [[note|`alias`]] still links note. Newlines are kept.
 */
function blankOut(text: string, spans: Map<number, number> = new Map()): string {
    let out = "";
    let from = 0;
    for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
        if (start < from) continue;
        out += text.slice(from, start) + text.slice(start, end).replace(/[^\n]/g, "|");
        from = end;
    }
    return out + text.slice(from);
}

/** Add the targets of the markdown links and images among `tokens` to `links`. */
function addTargets(tokens: Token[], links: string[]): void {
    for (const token of tokens) {
        if (token.type === "link_open") addTarget(token.attrGet("href"), links);
        if (token.type === "image") {
            addTarget(token.attrGet("src"), links);
            addTargets(token.children ?? [], links);
        }
    }
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
