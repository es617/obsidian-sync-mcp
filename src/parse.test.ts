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

    it("parses markdown links to .md files", () => {
        const content = "See [my link](other-note.md) and [another](folder/note.md)";
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.links.includes("other-note.md"));
        assert.ok(result.links.includes("folder/note.md"));
    });

    it("ignores non-md markdown links", () => {
        const content = "See [link](https://example.com) and [img](photo.png)";
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.links.length, 0);
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
