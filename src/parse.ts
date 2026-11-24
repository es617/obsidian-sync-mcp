/**
 * Parse Obsidian markdown content for frontmatter, tags, and links.
 */

import { isValidAttachmentPath } from "./attachment-path.js";

export interface NoteMetadata {
    frontmatter: Record<string, string>;
    tags: string[];
    links: string[];
}

// Link patterns. Each part stops at a bracket, paren or newline, so a failed
// match only scans up to the next one. Otherwise it rescans the rest of the
// note, which is quadratic on input like "[".repeat(20000), and parsing is
// synchronous and runs on every note at startup. No length cap is needed on
// top: attachment targets are capped by isValidAttachmentPath after decoding.

// [[wikilinks]]. A #heading, #^block or #page=2 suffix points into the target,
// so [[Note#Heading]] links Note and ![[paper.pdf#page=2]] embeds paper.pdf.
// [[#Heading]] (same note) is not a link.
const WIKILINK = /\[\[([^[\]|#\n]+)(?:#[^[\]|\n]*)?(?:\|[^[\]\n]*)?\]\]/dg;

// Markdown link text: plain characters, or one level of [brackets], so
// [see [1]](note.md) and [![thumb](t.png)](full.png) parse. The two
// alternatives never match the same character, so this adds no backtracking.
const LINK_LABEL = String.raw`[^[\]\n]|\[[^[\]\n]*\]`;

// [markdown links](path.md), also with a #heading: [x](path.md#Heading) links path.md.
const NOTE_LINK = new RegExp(String.raw`\[(?:${LINK_LABEL})+\]\(([^()#\n]+\.md)(?:#[^()\n]*)?\)`, "dg");

// Markdown links and embeds to attachments: ![](Attachments/shot.png),
// [report](<docs/Q1 report.pdf>), ![alt](my%20image.png "title").
const ATTACHMENT_LINK = new RegExp(String.raw`\[((?:${LINK_LABEL})*)\]\((<[^<>\n]+>|[^()\s]+)(?:\s+"[^"\n]*")?\)`, "dg");

// The value of a one-line YAML scalar: 'it''s' is it's, "say \"hi\"" is
// say "hi". Anything that isn't one whole quoted scalar ("a" and "b", a lone
// quote, a bare word) is returned as written.
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/" };
function unquote(value: string): string {
    const quote = value[0];
    if (value.length < 2 || (quote !== '"' && quote !== "'") || !value.endsWith(quote)) return value;
    const inner = value.slice(1, -1);
    if (quote === "'") return /^(?:[^']|'')*$/.test(inner) ? inner.replace(/''/g, "'") : value;
    if (!/^(?:[^"\\]|\\.)*$/.test(inner)) return value;
    return inner.replace(/\\(.)/g, (escape, c: string) => DOUBLE_QUOTE_ESCAPES[c] ?? escape);
}

export function parseFrontmatterAndLinks(content: string): NoteMetadata {
    const frontmatter: Record<string, string> = {};
    const tags = new Set<string>();
    const links: string[] = [];

    // Frontmatter runs from a "---" first line to the next "---" line.
    const end = content.startsWith("---\n") ? content.indexOf("\n---", 4) : -1;
    const yaml = end === -1 ? "" : content.slice(4, end);
    const body = end === -1 ? content : content.slice(end + 4);
    parseYaml(yaml, frontmatter, tags);

    // Inline #tags in the body. Obsidian does not read tags out of code, and a
    // tag must contain at least one non-numerical character ("#1984 isn't a
    // valid tag, but #y1984 is" — obsidian.md/help/tags), so code is masked out
    // first and all-digit matches are dropped.
    const masked = maskCode(body);
    for (const match of masked.matchAll(/(^|\s)#([\p{L}\p{N}_/-][\p{L}\p{M}\p{N}_/-]*)/gu)) {
        if (/^\p{Nd}+$/u.test(match[2])) continue;
        tags.add(match[2]);
    }

    // Links in properties (related: "[[Note]]") count; links inside code don't.
    addLinks(yaml, yaml, links);
    addLinks(masked, body, links);

    return { frontmatter, tags: [...tags], links: [...new Set(links)] };
}

/**
 * Read the frontmatter's `key: value` lines into `frontmatter`, and its tags:
 * inline (`tags: [a, b]`, `tags: a, b`) or as a `- a` list on the lines after
 * `tags:`.
 */
function parseYaml(yaml: string, frontmatter: Record<string, string>, tags: Set<string>): void {
    const addTag = (raw: string) => {
        const tag = unquote(raw.trim()).trim();
        if (tag) tags.add(tag);
    };
    let inTagsList = false;
    for (const line of yaml.split("\n")) {
        if (inTagsList) {
            const item = line.match(/^\s+-\s+(.+)/);
            if (item) { addTag(item[1]); continue; }
            inTagsList = false;
        }
        const match = line.match(/^([\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*)\s*:(.*)/u);
        if (!match) continue;
        const [, key, raw] = match;
        const value = raw.trim();
        if (value) frontmatter[key] = unquote(value);
        if (key !== "tags") continue;
        if (value) value.replace(/[[\]]/g, "").split(",").forEach(addTag);
        else inTagsList = true;
    }
}

/**
 * Add the targets of the links in `text` to `links`. The patterns run on
 * `masked`, which is `text` with code blanked out at the same offsets, so a
 * link written inside code isn't one. Each target is then read from `text`, so
 * code inside a link ([[`Note`]]) is kept as written.
 */
function addLinks(masked: string, text: string, links: string[]): void {
    // Inside a table Obsidian writes [[note\|alias]]: the backslash escapes the
    // pipe and is not part of the target.
    for (const match of masked.matchAll(WIKILINK)) links.push(group(text, match, 1).replace(/\\$/, ""));
    for (const match of masked.matchAll(NOTE_LINK)) links.push(group(text, match, 1));
    addAttachmentLinks(masked, text, links);
}

/** Capture group `i` of a match made with the `d` flag, read from `text`. */
function group(text: string, match: RegExpMatchArray, i: number): string {
    const [start, end] = match.indices![i];
    return text.slice(start, end);
}

/**
 * Add the attachment targets of markdown links to `links`, matched on `masked`
 * and read from `text` as in addLinks, recorded URL-decoded so
 * list_attachments can tell which files are still used. Also looks inside each
 * link's text once, since matches don't overlap and the outer link of
 * [![thumb](t.png)](full.png) would hide the inner image.
 */
function addAttachmentLinks(masked: string, text: string, links: string[], nested = false): void {
    for (const match of masked.matchAll(ATTACHMENT_LINK)) {
        const [labelStart, labelEnd] = match.indices![1];
        if (!nested && match[1].includes("[")) {
            addAttachmentLinks(masked.slice(labelStart, labelEnd), text.slice(labelStart, labelEnd), links, true);
        }
        // Drop a #page=2 fragment, as for wikilinks. Before decoding, since a
        // literal # in a file name is written %23.
        let target = group(text, match, 2).replace(/^<|>$/g, "").replace(/#.*$/, "");
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.endsWith(".md")) continue;
        // Obsidian URL-decodes markdown link targets (a literal % is written %25).
        try { target = decodeURIComponent(target); } catch { continue; }
        target = target.replace(/^(\.\.?\/)+/, "");
        if (isValidAttachmentPath(target)) links.push(target);
    }
}

// A code span can't run into a line that starts a new block: a heading, list
// item or table row, or a quote after a line that isn't one. Headings and
// table rows also end with their line.
const BLOCK_START = /^\s*(?:#{1,6}(?:\s|$)|[-*+]\s|\d{1,9}[.)]\s|\|)/;
const ONE_LINE_BLOCK = /^\s*(?:#{1,6}(?:\s|$)|\|)/;
const QUOTE = /^\s*>/;

/**
 * Replace fenced code blocks (``` or ~~~, opener at line start with up to three
 * spaces of indent, closer of the same character and at least the same length;
 * an unclosed fence runs to the end) and inline code spans (see
 * maskInlineSpans; a span stays within one block: it never crosses a blank
 * line or runs into a BLOCK_START line) with dots, so offsets are preserved
 * and nothing inside can start or extend a tag or link. Indented code blocks,
 * %% comments and math are not masked.
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
        if (BLOCK_START.test(line) || (QUOTE.test(line) && !QUOTE.test(inline.at(-1) ?? ""))) flushInline();
        inline.push(line);
        if (ONE_LINE_BLOCK.test(line)) flushInline();
    }
    flushInline();
    return out.join("\n");
}

/**
 * Mask the code spans in one block. A backtick run of length n opens a span
 * that closes at the next run of exactly n; an unmatched run is literal. A
 * backtick after an odd number of backslashes is escaped and literal, so such
 * a run opens with its remaining backticks, if any. Inside a span backslashes
 * are literal, so any run can close it.
 */
function maskInlineSpans(text: string): string {
    const runs: { at: number; len: number; escaped: boolean }[] = [];
    let slashes = 0;
    for (let i = 0; i < text.length; ) {
        if (text[i] !== "`") {
            slashes = text[i] === "\\" ? slashes + 1 : 0;
            i++;
            continue;
        }
        let n = 0;
        while (text[i + n] === "`") n++;
        runs.push({ at: i, len: n, escaped: slashes % 2 === 1 });
        slashes = 0;
        i += n;
    }

    // Run indices by length. Openers are tried left to right, so each list is
    // scanned forward only once and matching stays linear.
    const byLen = new Map<number, number[]>();
    runs.forEach((run, r) => {
        const list = byLen.get(run.len);
        if (list) list.push(r);
        else byLen.set(run.len, [r]);
    });
    const scanned = new Map<number, number>();
    const nextRun = (len: number, after: number): number => {
        const list = byLen.get(len) ?? [];
        let p = scanned.get(len) ?? 0;
        while (p < list.length && list[p] <= after) p++;
        scanned.set(len, p);
        return p < list.length ? list[p] : -1;
    };

    let result = "";
    let from = 0;
    for (let r = 0; r < runs.length; r++) {
        const { at, len, escaped } = runs[r];
        const openLen = escaped ? len - 1 : len;
        const c = openLen > 0 ? nextRun(openLen, r) : -1;
        if (c === -1) continue;
        const start = escaped ? at + 1 : at;
        const end = runs[c].at + runs[c].len;
        result += text.slice(from, start) + text.slice(start, end).replace(/[^\n]/g, ".");
        from = end;
        r = c;
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
