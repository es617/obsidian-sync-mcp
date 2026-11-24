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
// say "hi", and a trailing # comment is dropped. Anything else — a bare
// word, "a" and "b", a lone quote, an escape not decoded here — is returned
// as written.
const SINGLE_QUOTED = /^'((?:[^']|'')*)'(?:\s+#.*)?$/;
const DOUBLE_QUOTED = /^"((?:[^"\\]|\\["\\/nrt])*)"(?:\s+#.*)?$/;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };
function unquote(value: string): string {
    const single = value.match(SINGLE_QUOTED);
    if (single) return single[1].replace(/''/g, "'");
    const double = value.match(DOUBLE_QUOTED);
    if (double) return double[1].replace(/\\(.)/g, (_, c: string) => ESCAPES[c] ?? c);
    return value;
}

export function parseFrontmatterAndLinks(content: string): NoteMetadata {
    content = content.replace(/\r\n/g, "\n");

    // Frontmatter runs from a "---" first line to the next "---" line.
    const end = content.startsWith("---\n") ? content.indexOf("\n---", 4) : -1;
    const yaml = end === -1 ? "" : content.slice(4, end);
    const body = end === -1 ? content : content.slice(end + 4);
    const { frontmatter, tags: yamlTags } = parseYaml(yaml);
    const tags = new Set(yamlTags);

    // Inline #tags, in the body only. Obsidian does not read tags out of code,
    // and a tag must contain at least one non-numerical character ("#1984
    // isn't a valid tag, but #y1984 is" — obsidian.md/help/tags), so code is
    // masked out first and all-digit matches are dropped.
    const masked = maskCode(body);
    for (const match of masked.matchAll(/(^|\s)#([\p{L}\p{N}_/-][\p{L}\p{M}\p{N}_/-]*)/gu)) {
        if (/^\p{Nd}+$/u.test(match[2])) continue;
        tags.add(match[2]);
    }

    // Links in properties (related: "[[Note]]") count; links inside code don't.
    const links: string[] = [];
    addLinks(yaml, links);
    addLinks(body, links, masked);

    return { frontmatter, tags: [...tags], links: [...new Set(links)] };
}

/**
 * The frontmatter's `key: value` lines, and its tags: inline (`tags: [a, b]`,
 * `tags: a, b`) or a `- a` list on the lines after `tags:`.
 */
function parseYaml(yaml: string): { frontmatter: Record<string, string>; tags: string[] } {
    const frontmatter: Record<string, string> = {};
    const tags: string[] = [];
    const addTag = (raw: string) => {
        const tag = unquote(raw.trim()).trim();
        if (tag) tags.push(tag);
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
    return { frontmatter, tags };
}

/**
 * Add the targets of the links in `text` to `links`. The patterns run on
 * `masked`, which is `text` with code blanked out at the same offsets, so a
 * link written inside code isn't one. Each target is then read from `text`, so
 * code inside a link ([[`Note`]]) is kept as written.
 */
function addLinks(text: string, links: string[], masked = text): void {
    // Inside a table Obsidian writes [[note\|alias]]: the backslash escapes the
    // pipe and is not part of the target.
    for (const match of masked.matchAll(WIKILINK)) links.push(capture(text, match, 1).replace(/\\$/, ""));
    for (const match of masked.matchAll(NOTE_LINK)) links.push(capture(text, match, 1));
    addAttachmentLinks(text, links, masked);
}

/** Capture group `i` of a match made with the `d` flag, read from `text`. */
function capture(text: string, match: RegExpMatchArray, i: number): string {
    const [start, end] = match.indices![i];
    return text.slice(start, end);
}

/**
 * Add the attachment targets of markdown links to `links`, matched and read as
 * in addLinks, recorded URL-decoded so list_attachments can tell which files
 * are still used. Also looks inside each link's text once, since matches don't
 * overlap and the outer link of [![thumb](t.png)](full.png) would hide the
 * inner image.
 */
function addAttachmentLinks(text: string, links: string[], masked = text, nested = false): void {
    for (const match of masked.matchAll(ATTACHMENT_LINK)) {
        const [labelStart, labelEnd] = match.indices![1];
        if (!nested && match[1].includes("[")) {
            addAttachmentLinks(text.slice(labelStart, labelEnd), links, masked.slice(labelStart, labelEnd), true);
        }
        // Drop a #page=2 fragment, as for wikilinks. Before decoding, since a
        // literal # in a file name is written %23.
        let target = capture(text, match, 2).replace(/^<|>$/g, "").replace(/#.*$/, "");
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.endsWith(".md")) continue;
        // Obsidian URL-decodes markdown link targets (a literal % is written %25).
        try { target = decodeURIComponent(target); } catch { continue; }
        target = target.replace(/^(\.\.?\/)+/, "");
        if (isValidAttachmentPath(target)) links.push(target);
    }
}

// A fence line: ``` or ~~~, after any indent and quote or list markers, so
// fences in callouts and list items count. Group 2 is the info string.
const FENCE = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])[ \t]))*[ \t]*(`{3,}|~{3,})(.*)$/;
const TABLE_ROW = /^[ \t>]*\|/;

/**
 * Blank out code with dots, keeping offsets, so nothing inside it can be read
 * as a tag or link.
 *
 * A fenced block runs from an opening fence to the next fence line of the same
 * character, at least as long and with nothing after it. An opener with no
 * closer is left as text. Code spans are masked line by line, and cell by cell
 * in a table row: a span that wraps onto the next line is missed, which can
 * index a bogus link, but a stray backtick can never hide real links in a
 * later line. Indented code blocks, %% comments and math are not masked, and
 * a backtick inside an autolink or HTML attribute can still pair with one later
 * on its line.
 */
export function maskCode(content: string): string {
    const lines = content.split("\n");
    const fences = lines.map((line) => {
        const m = line.match(FENCE);
        if (!m) return null;
        const char = m[1][0];
        return { char, len: m[1].length, opens: char === "~" || !m[2].includes("`"), closes: m[2].trim() === "" };
    });
    const closes = (i: number, char: string, len: number) => {
        const f = fences[i];
        return f !== null && f.closes && f.char === char && f.len >= len;
    };
    // The longest closing fence of each character at or after each line, so
    // finding out whether an opener closes doesn't rescan the note.
    const longest = { "`": Array.from({ length: lines.length + 1 }, () => 0), "~": Array.from({ length: lines.length + 1 }, () => 0) };
    for (let i = lines.length - 1; i >= 0; i--) {
        longest["`"][i] = longest["`"][i + 1];
        longest["~"][i] = longest["~"][i + 1];
        const f = fences[i];
        if (f?.closes) longest[f.char as "`" | "~"][i] = Math.max(longest[f.char as "`" | "~"][i], f.len);
    }

    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const f = fences[i];
        if (f?.opens && longest[f.char as "`" | "~"][i + 1] >= f.len) {
            let j = i + 1;
            while (!closes(j, f.char, f.len)) j++;
            for (; i <= j; i++) out.push(".".repeat(lines[i].length));
            i = j;
            continue;
        }
        const line = lines[i];
        out.push(TABLE_ROW.test(line) ? line.split(/(?<!\\)\|/).map(maskCodeSpans).join("|") : maskCodeSpans(line));
    }
    return out.join("\n");
}

/**
 * Mask the code spans in one line. A backtick run of length n opens a span
 * that closes at the next run of exactly n; an unmatched run is literal. A
 * backtick after an odd number of backslashes is escaped and literal, so such
 * a run opens with its remaining backticks, if any. Inside a span backslashes
 * are literal, so any run can close it.
 */
function maskCodeSpans(text: string): string {
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

    // closer[r]: the next run after r that closes what r opens, or -1.
    const closer: number[] = [];
    const nextOfLen = new Map<number, number>();
    for (let r = runs.length - 1; r >= 0; r--) {
        const { len, escaped } = runs[r];
        closer[r] = nextOfLen.get(escaped ? len - 1 : len) ?? -1;
        nextOfLen.set(len, r);
    }

    let result = "";
    let from = 0;
    for (let r = 0; r < runs.length; r++) {
        const c = closer[r];
        if (c === -1) continue;
        const start = runs[r].escaped ? runs[r].at + 1 : runs[r].at;
        const end = runs[c].at + runs[c].len;
        result += text.slice(from, start) + ".".repeat(end - start);
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
