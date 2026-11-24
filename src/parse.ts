/**
 * Parse Obsidian markdown content for frontmatter, tags, and links.
 */

import MarkdownIt, { type Token } from "markdown-it";
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit, type Document, type YAMLSeq } from "yaml";
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

// markdown-it doesn't say where a code span sits in its block's text, so its
// backticks rule is wrapped to record that: env.codeSpans maps a block's
// inline source to its code spans, start offset to end. Blocks with the same
// text have the same spans and share an entry. __rules__ and __find__ are
// internal, which is why markdown-it is pinned to an exact version.
type Env = { codeSpans: Map<string, Map<number, number>> };
const backticks = markdown.inline.ruler.__rules__[markdown.inline.ruler.__find__("backticks")].fn;
markdown.inline.ruler.at("backticks", (state, silent) => {
    const start = state.pos;
    const tokens = state.tokens.length;
    if (!backticks(state, silent)) return false;
    // A run with no closing run is literal text (no token is pushed), and the
    // rule also runs silently while markdown-it scans ahead; neither is a span.
    if (!silent && state.tokens.length > tokens && state.tokens.at(-1)?.type === "code_inline") {
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
    const { text, links } = readBody(body);
    const tags = new Set(yamlTags);
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
 * with ", ", anything else is kept as written. Tags come from `tags`: a list,
 * or a string of comma- or line-separated tags. Frontmatter that isn't valid
 * YAML is ignored, as Obsidian does.
 */
function readFrontmatter(yaml: string): { frontmatter: Record<string, string>; tags: string[] } {
    const frontmatter: Record<string, string> = {};
    const tags: string[] = [];
    const doc = parseDocument(yaml, { schema: "failsafe", uniqueKeys: false });
    if (doc.errors.length > 0 || !isMap(doc.contents)) return { frontmatter, tags };

    const resolve = aliasResolver(doc);
    for (const pair of doc.contents.items) {
        const key = resolve(pair.key);
        if (!isScalar(key)) continue;
        const value = resolve(pair.value);
        const shown = showValue(value, resolve, yaml);
        if (shown) frontmatter[String(key.value)] = shown;
        if (key.value !== "tags") continue;
        const raw = isScalar(value) ? String(value.value).split(/[,\n]/) : isSeq(value) ? scalars(value, resolve) : [];
        for (const tag of raw) if (tag.trim()) tags.push(tag.trim());
    }
    return { frontmatter, tags };
}

type Resolve = (node: unknown) => unknown;

/**
 * Resolve aliases (*name) to the node they point to: the last node before
 * them with that anchor. Worked out in one pass, since yaml's Alias.resolve
 * rescans the whole document on every call.
 */
function aliasResolver(doc: Document): Resolve {
    const anchors = new Map<string, unknown>();
    const targets = new Map<unknown, unknown>();
    visit(doc, {
        Node(_, node) {
            if (isAlias(node)) targets.set(node, anchors.get(node.source));
            else if (node.anchor) anchors.set(node.anchor, node);
        },
    });
    return (node) => (isAlias(node) ? targets.get(node) : node);
}

/** The plain values in a list, skipping nested lists and maps. */
function scalars(seq: YAMLSeq, resolve: Resolve): string[] {
    return seq.items.map(resolve).filter(isScalar).map((item) => String(item.value ?? ""));
}

/** A value as get_note_info shows it: as is, a plain list joined, else as written. */
function showValue(value: unknown, resolve: Resolve, yaml: string): string {
    if (isScalar(value)) return String(value.value ?? "");
    if (isSeq(value) && value.items.every((item) => isScalar(resolve(item)))) return scalars(value, resolve).join(", ");
    if ((isMap(value) || isSeq(value)) && value.range) return yaml.slice(value.range[0], value.range[1]).trim();
    return "";
}

// Blocks that only hold other blocks; their lines are claimed by what's inside.
const CONTAINERS = new Set(["blockquote_open", "bullet_list_open", "ordered_list_open", "list_item_open"]);

/**
 * The note's markdown link and image targets, and its source text with code
 * left out, for the wikilink and tag patterns: each block's raw text with its
 * code spans blanked out, and as written, raw HTML blocks (whose markdown
 * links count too), indented code, table rows with more cells than the header
 * (markdown-it drops the extra ones) and the lines no block claims (reference
 * and footnote definitions). Indented code is read because markdown-it
 * doesn't know footnotes, whose continuation lines are indented. Fenced code
 * is left out, as Obsidian doesn't link or tag inside code.
 */
function readBody(body: string): { text: string; links: string[] } {
    const env: Env = { codeSpans: new Map() };
    const tokens = markdown.parse(body, env);
    const lines = body.split("\n");
    const parts: string[] = [];
    const links: string[] = [];
    const claimed = new Set<number>();
    let row = { line: 0, cells: 0 };
    for (const token of tokens) {
        if (token.map && !CONTAINERS.has(token.type)) {
            for (let line = token.map[0]; line < token.map[1]; line++) claimed.add(line);
        }
        switch (token.type) {
            case "inline":
                parts.push(blankOut(token.content, env.codeSpans.get(token.content)));
                addTargets(token.children ?? [], links);
                break;
            case "html_block":
                // Markdown inside HTML isn't rendered, but a ![](img.png)
                // there still marks the file as used.
                parts.push(token.content);
                addTargets(markdown.parseInline(token.content, env)[0].children ?? [], links);
                break;
            case "code_block":
                parts.push(token.content);
                break;
            case "tr_open":
                row = { line: token.map![0], cells: 0 };
                break;
            case "th_open":
            case "td_open":
                row.cells++;
                break;
            case "tr_close":
                if (countCells(lines[row.line]) > row.cells) {
                    parts.push(lines[row.line]);
                    addTargets(markdown.parseInline(lines[row.line], env)[0].children ?? [], links);
                }
                break;
        }
    }
    lines.forEach((line, i) => {
        if (!claimed.has(i)) parts.push(line);
    });
    return { text: parts.join("\n"), links };
}

/** The cells in a table row as written: split at unescaped pipes, outer pipes optional. */
function countCells(line: string): number {
    return line.trim().replace(/^\||(?<!\\)\|$/g, "").split(/(?<!\\)\|/).length;
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
        out += text.slice(from, start) + text.slice(start, end).replace(/[^\n]/g, "|");
        from = end;
    }
    return out + text.slice(from);
}

/**
 * Add the targets of the markdown links and images among `tokens` to `links`.
 * A link's text is among its siblings, but an image's alt text is in its
 * children, where another image can be.
 */
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
