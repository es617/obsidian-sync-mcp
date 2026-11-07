import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatterAndLinks } from "./parse.js";

describe("parseFrontmatterAndLinks", () => {
    it("parses YAML frontmatter", () => {
        const content = `---
title: My Note
date: 2026-03-24
status: draft
---

# Content`;
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.frontmatter.title, "My Note");
        assert.equal(result.frontmatter.date, "2026-03-24");
        assert.equal(result.frontmatter.status, "draft");
    });

    it("parses frontmatter tags", () => {
        const content = `---
tags: [project, active, important]
---

Content`;
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.tags.includes("project"));
        assert.ok(result.tags.includes("active"));
        assert.ok(result.tags.includes("important"));
    });

    it("parses multi-line YAML tags", () => {
        const content = `---
tags:
  - project
  - active
  - important
---

Content`;
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.tags.includes("project"));
        assert.ok(result.tags.includes("active"));
        assert.ok(result.tags.includes("important"));
    });

    it("parses inline #tags", () => {
        const content = "Some text #idea and #project/sub-tag here";
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.tags.includes("idea"));
        assert.ok(result.tags.includes("project/sub-tag"));
    });

    it("parses frontmatter keys with non-ASCII letters", () => {
        const content = `---
ämne: unicode
senast_ändrad: 2026-09-16
title: plain
---

Content`;
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.frontmatter["ämne"], "unicode");
        assert.equal(result.frontmatter["senast_ändrad"], "2026-09-16");
        assert.equal(result.frontmatter.title, "plain");
    });

    it("parses inline #tags with non-ASCII letters as whole tags", () => {
        const content = "Se #lägen och #art/rutin-för-personal här, samt #日本語";
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.tags.includes("lägen"));
        assert.ok(result.tags.includes("art/rutin-för-personal"));
        assert.ok(result.tags.includes("日本語"));
        // No truncated stubs from cutting at the first non-ASCII character
        assert.ok(!result.tags.includes("l"));
        assert.ok(!result.tags.includes("art/rutin-f"));
    });

    it("keeps combining marks (NFD) inside keys and tags", () => {
        // "ä" as base letter + U+0308, built explicitly so the test does not
        // depend on the editor's normalisation form.
        const nfdKey = "a\u0308mne";
        const nfdTag = "la\u0308gen";
        const content = `---
${nfdKey}: nfd
---

Text #${nfdTag} here`;
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.frontmatter[nfdKey], "nfd");
        assert.ok(result.tags.includes(nfdTag));
        assert.ok(!result.tags.includes("la"));
    });

    it("ignores #tags inside inline code spans", () => {
        const content = "Set the `#Kategori` field and ``#Household`` too, but keep #real here";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, ["real"]);
    });

    it("ignores #tags inside fenced code blocks", () => {
        const content = "#before\n```\n#Household\n#inside/nested\n```\n#after\n~~~md\n#tilde\n~~~\n";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, ["before", "after"]);
    });

    it("treats an unclosed fence as running to the end", () => {
        const content = "#kept\n```\n#lost\n#also-lost";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, ["kept"]);
    });

    it("leaves an unmatched backtick run as literal text", () => {
        const content = "A stray ` here and #tag stays; a ``span with #hidden`` hides it";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, ["tag"]);
    });

    it("does not let a stray backtick pair across a blank line", () => {
        const sections = Array.from({ length: 20 }, (_, i) => `## Section ${i}\nSome notes here. #tag${i}`);
        const content = [
            "The user`s request needs follow up. #important",
            ...sections,
            "Circling back, thats it`s done. #wrapup",
        ].join("\n\n");
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.tags.length, 22);
        assert.ok(result.tags.includes("important"));
        assert.ok(result.tags.includes("tag0") && result.tags.includes("tag19"));
        assert.ok(result.tags.includes("wrapup"));
    });

    it("masks many unmatched backtick runs in linear time", () => {
        const parts: string[] = [];
        for (let n = 1, len = 0; len < 2_000_000; n++) {
            parts.push("`".repeat(n) + " x ");
            len += n + 3;
        }
        const content = parts.join("") + "#end";
        const start = performance.now();
        const result = parseFrontmatterAndLinks(content);
        assert.ok(performance.now() - start < 2000);
        assert.deepEqual(result.tags, ["end"]);
    });

    it("does not let masking create or extend a tag", () => {
        const content = "`x`#glued and #tag`y` and `#a`#b";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, ["tag"]);
    });

    it("rejects all-numeric tags but keeps tags with a non-numerical character", () => {
        const content = "See PR #1984 and issue #20; #y1984 and #2026/09 and #x-1 are tags";
        const result = parseFrontmatterAndLinks(content);
        assert.ok(!result.tags.includes("1984"));
        assert.ok(!result.tags.includes("20"));
        assert.ok(result.tags.includes("y1984"));
        // Literal reading of "at least one non-numerical character"; whether
        // Obsidian counts "/" for that is checked against the app (uppdrag 71).
        assert.ok(result.tags.includes("2026/09"));
        assert.ok(result.tags.includes("x-1"));
    });

    it("keeps tags made of non-decimal number characters", () => {
        const content = "Chapter #Ⅳ and footnote #² are tags, #42 is not";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, ["Ⅳ", "²"]);
    });

    it("keeps frontmatter tags even when all-numeric", () => {
        const content = "---\ntags: [2024, project]\n---\nText";
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.tags.includes("2024"));
        assert.ok(result.tags.includes("project"));
    });

    it("deduplicates tags from frontmatter and inline", () => {
        const content = `---
tags: [shared]
---

Also #shared inline`;
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.tags.filter((t) => t === "shared").length, 1);
    });

    it("parses [[wikilinks]]", () => {
        const content = "See [[Other Note]] and [[folder/Linked Note|display text]]";
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.links.includes("Other Note"));
        assert.ok(result.links.includes("folder/Linked Note"));
    });

    it("drops #heading, #^block and #page anchors from wikilink targets", () => {
        const content = "[[Note#Heading]] [[folder/Other#^abc123|alias]] ![[paper.pdf#page=2]] ![[clip.mp4#t=10]] [[#Local heading]]";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.links.sort(), ["Note", "clip.mp4", "folder/Other", "paper.pdf"]);
    });

    it("parses markdown links to .md files", () => {
        const content = "See [my link](other-note.md) and [another](folder/note.md)";
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.links.includes("other-note.md"));
        assert.ok(result.links.includes("folder/note.md"));
    });

    it("drops a #heading from markdown links to .md files", () => {
        const content = "[a](other-note.md#Heading) [b](folder/note.md#^block) [c](plain.md)";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.links.sort(), ["folder/note.md", "other-note.md", "plain.md"]);
    });

    it("ignores URLs and links to files that are neither notes nor attachments", () => {
        const content = "See [link](https://example.com), [x](file:///etc/passwd), [data](data.json) and [script](x.js)";
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.links.length, 0);
    });

    it("records markdown links and embeds to attachments, decoded", () => {
        const content = [
            "![](Attachments/shot.png)",
            "[img](photo.png)",
            '![alt](my%20image.JPG "title")',
            "[report](<docs/Q1 report.pdf>)",
            "![](./rel/clip.mp4)",
            "![](../up/audio.mp3)",
        ].join("\n");
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.links.sort(), [
            "Attachments/shot.png", "docs/Q1 report.pdf", "my image.JPG", "photo.png", "rel/clip.mp4", "up/audio.mp3",
        ].sort());
    });

    it("drops #fragments from markdown attachment links but keeps an encoded # in the name", () => {
        const content = "![](paper.pdf#page=2) [clip](<media/my clip.mp4#t=10>) ![](odd%23name.png)";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.links.sort(), ["media/my clip.mp4", "odd#name.png", "paper.pdf"]);
    });

    it("parses links in linear time on hostile input", () => {
        const hostile = [
            "[".repeat(20000), "[[".repeat(10000), "[[a|".repeat(10000), "[[a#".repeat(10000),
            "[](a".repeat(10000), "[](<".repeat(10000), "[a](b.md".repeat(10000),
            "[[a]".repeat(10000), "[" + "[a]".repeat(10000), "[![a](b)".repeat(10000),
        ];
        for (const content of hostile) {
            const start = performance.now();
            parseFrontmatterAndLinks(content + " [[end]]");
            const ms = performance.now() - start;
            // Unbounded patterns took 0.35-1.5 s on these; the bounded ones take under 50 ms.
            assert.ok(ms < 200, `${JSON.stringify(content.slice(0, 8))}... took ${ms.toFixed(0)} ms`);
        }
        assert.deepEqual(parseFrontmatterAndLinks("[](a".repeat(10000) + " [[end]]").links, ["end"]);
    });

    it("still finds links next to other brackets", () => {
        const content = "[see [1]](note.md) [![thumb](t.png)](full.png) [[a]][[b]] ([[c]]) [x](d.md)(e)";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.links.sort(), ["a", "b", "c", "d.md", "full.png", "note.md", "t.png"]);
    });

    it("does not let a link span lines", () => {
        const result = parseFrontmatterAndLinks("[[broken\nlink]] [label\n](x.png)");
        assert.deepEqual(result.links, []);
    });

    it("deduplicates links", () => {
        const content = "See [[Note]] and [[Note]] again";
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.links.filter((l) => l === "Note").length, 1);
    });

    it("returns empty results for plain text", () => {
        const result = parseFrontmatterAndLinks("Just plain text, no metadata.");
        assert.deepEqual(result.frontmatter, {});
        assert.deepEqual(result.tags, []);
        assert.deepEqual(result.links, []);
    });

    it("handles content with no frontmatter closing delimiter", () => {
        const content = "---\ntitle: Broken\nNo closing delimiter";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.frontmatter, {});
    });
});
