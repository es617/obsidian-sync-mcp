/** A compact, deterministic representation of one searchable Markdown section. */
export interface MarkdownChunk {
    ordinal: number;
    heading: string;
    breadcrumb: string;
    body: string;
}

const TARGET_WORDS = 400;
const MAX_WORDS = 800;

function wordCount(value: string): number {
    return value.match(/\S+/g)?.length ?? 0;
}

function stripFrontmatter(content: string): string {
    if (!content.startsWith("---\n")) return content;
    const end = content.indexOf("\n---", 4);
    if (end === -1) return content;
    const bodyStart = content.indexOf("\n", end + 4);
    return bodyStart === -1 ? "" : content.slice(bodyStart + 1);
}

function splitOversizedBody(body: string): string[] {
    const normalized = body.trim();
    if (!normalized) return [];
    if (wordCount(normalized) <= MAX_WORDS) return [normalized];

    const pieces: string[] = [];
    let current: string[] = [];
    let currentWords = 0;
    const paragraphs = normalized.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);

    const flush = () => {
        if (current.length > 0) pieces.push(current.join("\n\n"));
        current = [];
        currentWords = 0;
    };

    for (const paragraph of paragraphs) {
        const count = wordCount(paragraph);
        if (count > MAX_WORDS) {
            flush();
            const words = paragraph.match(/\S+/g) ?? [];
            for (let offset = 0; offset < words.length; offset += MAX_WORDS) {
                pieces.push(words.slice(offset, offset + MAX_WORDS).join(" "));
            }
            continue;
        }
        if (currentWords >= TARGET_WORDS && currentWords + count > MAX_WORDS) flush();
        current.push(paragraph);
        currentWords += count;
    }
    flush();
    return pieces;
}

/**
 * Split a note at ATX headings, retaining the heading hierarchy as a breadcrumb.
 * Large sections are divided at paragraph boundaries without overlap.
 */
export function chunkMarkdown(content: string): MarkdownChunk[] {
    const body = stripFrontmatter(content).replace(/\r\n/g, "\n");
    const lines = body.split("\n");
    const headings: string[] = [];
    const sections: Array<{ heading: string; breadcrumb: string; lines: string[] }> = [];
    let current = { heading: "", breadcrumb: "", lines: [] as string[] };

    const pushCurrent = () => {
        if (current.lines.some((line) => line.trim())) sections.push(current);
    };

    for (const line of lines) {
        const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (!match) {
            current.lines.push(line);
            continue;
        }

        pushCurrent();
        const level = match[1].length;
        const heading = match[2].trim();
        headings.length = level - 1;
        headings[level - 1] = heading;
        current = {
            heading,
            breadcrumb: headings.filter(Boolean).join(" > "),
            lines: [],
        };
    }
    pushCurrent();

    const chunks: MarkdownChunk[] = [];
    for (const section of sections) {
        for (const piece of splitOversizedBody(section.lines.join("\n"))) {
            chunks.push({
                ordinal: chunks.length,
                heading: section.heading,
                breadcrumb: section.breadcrumb,
                body: piece,
            });
        }
    }
    return chunks;
}
