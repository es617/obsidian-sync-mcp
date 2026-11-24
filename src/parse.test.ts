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

    it("strips YAML quotes from frontmatter tags", () => {
        const inline = parseFrontmatterAndLinks(`---\ntags: ["alpha", 'beta/gamma', delta]\n---\nText`);
        assert.deepEqual(inline.tags.sort(), ["alpha", "beta/gamma", "delta"]);

        const list = parseFrontmatterAndLinks(`---\ntags:\n  - "alpha"\n  - 'beta/gamma'\n  - delta\n---\nText`);
        assert.deepEqual(list.tags.sort(), ["alpha", "beta/gamma", "delta"]);
    });

    it("strips YAML quotes from frontmatter values", () => {
        const result = parseFrontmatterAndLinks(`---\ntitle: "My Note"\nstatus: 'draft'\nnote: it's "fine"\n---\nText`);
        assert.equal(result.frontmatter.title, "My Note");
        assert.equal(result.frontmatter.status, "draft");
        assert.equal(result.frontmatter.note, `it's "fine"`);
    });

    it("reads YAML quoting rules in frontmatter values", () => {
        const yaml = String.raw`---
single: 'it''s'
double: "say \"hi\"\tthen"
padded: "  kept  "
commented: "My Note" # draft
version: 1.10
list: [a, "b"]
---
Text`;
        const fm = parseFrontmatterAndLinks(yaml).frontmatter;
        assert.equal(fm.single, "it's");
        assert.equal(fm.double, 'say "hi"\tthen');
        assert.equal(fm.padded, "  kept  ");
        assert.equal(fm.commented, "My Note");
        assert.equal(fm.version, "1.10", "values stay strings as written");
        assert.equal(fm.list, "a, b");
    });

    it("reads YAML aliases, quickly", () => {
        const result = parseFrontmatterAndLinks("---\ncommon: &t [work, review]\ntags: *t\nsame: *t\n---\nBody");
        assert.deepEqual(result.tags, ["work", "review"]);
        assert.equal(result.frontmatter.same, "work, review");

        const hostile = "---\na: &x [" + "*x,".repeat(50) + "]\n" + "k: v\n".repeat(20000) + "---\nBody [[L]]";
        const start = performance.now();
        assert.deepEqual(parseFrontmatterAndLinks(hostile).links, ["L"]);
        assert.ok(performance.now() - start < 2000);
    });

    it("resolves many alias references in linear time", () => {
        const time = (n: number) => {
            const yaml = "---\nbase: &a [x, y]\n" + Array.from({ length: n }, (_, i) => `k${i}: *a`).join("\n") + "\n---\n";
            const start = performance.now();
            assert.equal(parseFrontmatterAndLinks(yaml).frontmatter[`k${n - 1}`], "x, y");
            return performance.now() - start;
        };
        time(500);
        assert.ok(time(8000) < 2000, "8000 alias references took over 2 s");
    });

    it("reads the plain tags of a list that also holds other values", () => {
        assert.deepEqual(parseFrontmatterAndLinks("---\ntags: [a, [x, y], b]\n---\n").tags, ["a", "b"]);
        assert.deepEqual(parseFrontmatterAndLinks("---\ntags: |\n  a\n  b\n---\n").tags, ["a", "b"]);
    });

    it("keeps nested frontmatter values as written", () => {
        const fm = parseFrontmatterAndLinks("---\nlist:\n  - [a, b]\n  - {k: v}\nmap:\n  k: v\n---\n").frontmatter;
        assert.equal(fm.list, "- [a, b]\n  - {k: v}");
        assert.equal(fm.map, "k: v");
    });

    it("ignores frontmatter that isn't valid YAML, as Obsidian does", () => {
        const result = parseFrontmatterAndLinks(`---\ntitle: "a" and "b"\ntags: ["alpha', it's]\n---\nBody #real`);
        assert.deepEqual(result.frontmatter, {});
        assert.deepEqual(result.tags, ["real"]);
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
        const content = "#kept\n```\n#lost [[Lost]]";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, ["kept"]);
        assert.deepEqual(result.links, []);
    });

    it("masks fences in list items and callouts", () => {
        const content = "- ```bash\n  [[in-list]]\n  ```\n- see [[Next]]\n> [!note]\n> ```\n> [[in-callout]]\n> ```\n\nMore [[After]]";
        assert.deepEqual(parseFrontmatterAndLinks(content).links.sort(), ["After", "Next"]);
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

    it("drops the escape backslash of a table wikilink alias", () => {
        const content = "| Note | Where |\n| --- | --- |\n| [[folder/note\\|label]] | [[other\\|x]] |";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.links.sort(), ["folder/note", "other"]);
    });

    it("ignores links written inside code", () => {
        const content = "Use `[[span]]` or `[x](span.md)`.\n\n```md\n[[fenced]] ![](fenced.png)\n```\n\n[[real]]";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.links, ["real"]);
    });

    it("keeps links whose label contains code", () => {
        const content = "[`run`](scripts/run.md) [[note|`alias`]] ![`shot`](img/shot.png)";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.links.sort(), ["img/shot.png", "note", "scripts/run.md"]);
    });

    it("does not link a wikilink whose target is code", () => {
        assert.deepEqual(parseFrontmatterAndLinks("[[`Note`]]").links, []);
    });

    it("does not let a stray backtick hide links in the next block", () => {
        const cases: [string, string[]][] = [
            ["- run `foo\n- see [[List]] and `bar`", ["List"]],
            ["# Use ` here\n[[Heading]] then `code`", ["Heading"]],
            ["| `x | [[Row]] |\n|---|---|\n| ![](pic.png) | y` |", ["Row", "pic.png"]],
            ["Text `x\n> [[Quote]] `y`", ["Quote"]],
            ["---\ncmd: `ls\n---\nSee [[Body]] and ![](img.png) then `x`", ["Body", "img.png"]],
        ];
        for (const [content, links] of cases) {
            assert.deepEqual(parseFrontmatterAndLinks(content).links.sort(), links.sort(), content);
        }
    });

    it("masks code spans across lines and per table cell", () => {
        const cases: [string, string[]][] = [
            ["Title `x\n===\n[[Setext]] `y`", ["Setext"]],
            ["a `x\n***\n[[Break]] `y`", ["Break"]],
            ["> - a `x\n> - see [[Callout]] `y`", ["Callout"]],
            ["[^1]: `x\n[^2]: [[Footnote]] `y`", ["Footnote"]],
            ["| a | b |\n|---|---|\n| `x | [[Cell]] | y` |", ["Cell"]],
            ["| `[[a\\|b]]` | `[[c]]` |", []],
            ["See `[[wrapped\nspan]]` and `[[in-code]]`", []],
        ];
        for (const [content, links] of cases) {
            assert.deepEqual(parseFrontmatterAndLinks(content).links.sort(), links.sort(), content);
        }
    });

    it("reads CRLF notes like LF ones", () => {
        const result = parseFrontmatterAndLinks("---\r\ntitle: \"T\"\r\ncmd: \"a ` b\"\r\ntags: [a]\r\n---\r\n[[Body]] `x`\r\n");
        assert.equal(result.frontmatter.title, "T");
        assert.deepEqual(result.tags, ["a"]);
        assert.deepEqual(result.links, ["Body"]);
    });

    it("does not read inline #tags from frontmatter values", () => {
        const result = parseFrontmatterAndLinks("---\ncolor: #ff0000\nnote: see #idea\n---\nBody #real");
        assert.deepEqual(result.tags, ["real"]);
    });

    it("does not read escaped or entity-encoded tags and links", () => {
        const result = parseFrontmatterAndLinks("\\#escaped &#35;entity #tag \\[\\[escaped]] [[a\\|alias]] [[link]]");
        assert.deepEqual(result.tags, ["tag"]);
        assert.deepEqual(result.links.sort(), ["a", "link"]);
    });

    it("stays fast with many code spans, also in identical blocks", () => {
        for (const content of ["`a` ".repeat(100000), "| `a` |\n|---|\n" + "| `a` |\n".repeat(50000)]) {
            const start = performance.now();
            parseFrontmatterAndLinks(content);
            assert.ok(performance.now() - start < 3000, `${content.slice(0, 20)}… took too long`);
        }
    });

    it("reads links in table cells beyond the header's", () => {
        const cases: [string, string[]][] = [
            ["| h |\n|---|\n| a | [[Extra]] |", ["Extra"]],
            ["| h | i |\n|---|---|\n| a | b | ![](extra.png) |", ["extra.png"]],
            ["h | i\n--|--\na | b | [[NoPipes]]", ["NoPipes"]],
            ["| h | i |\n|---|---|\n| [[a\\|alias]] | b |", ["a"]],
        ];
        for (const [content, links] of cases) assert.deepEqual(parseFrontmatterAndLinks(content).links, links, content);
    });

    it("reads indented lines, which continue footnotes in Obsidian", () => {
        assert.deepEqual(parseFrontmatterAndLinks("[^1]: Source\n    more [[Cont]] #fn").links, ["Cont"]);
        assert.deepEqual(parseFrontmatterAndLinks("[^1]: Source\n    more [[Cont]] #fn").tags, ["fn"]);
        assert.deepEqual(parseFrontmatterAndLinks("# Heading\n\t[[A]]").links, ["A"]);
        assert.deepEqual(parseFrontmatterAndLinks("---\ntitle: x\n---\n\t[[AfterFM]]").links, ["AfterFM"]);
    });

    it("does not treat an unmatched backtick as code", () => {
        assert.deepEqual(parseFrontmatterAndLinks("![[embed `x.png]]").links, ["embed `x.png"]);
        assert.deepEqual(parseFrontmatterAndLinks("[[My `note]] and #tag").links, ["My `note"]);
    });

    it("reads wikilinks in reference and footnote definitions", () => {
        const content = "x[^a] and [see][src]\n\n[^a]: ![[diagram.png]]\n[src]: [[Other]]\n> [^q]: [[Quoted]]";
        assert.deepEqual(parseFrontmatterAndLinks(content).links.sort(), ["Other", "Quoted", "diagram.png"]);
    });

    it("does not let a reference definition hide a wikilink", () => {
        const content = "See [[Project]] and ![[logo.png]].\n\n[project]: https://x\n[logo.png]: https://y";
        assert.deepEqual(parseFrontmatterAndLinks(content).links.sort(), ["Project", "logo.png"]);
    });

    it("keeps emphasis characters in wikilink targets", () => {
        const content = "![[_assets/img_.png]] [[__init__]] [[_a]] and [[b_]] [[a ~~b~~ c]] [[x]](y.md)";
        assert.deepEqual(parseFrontmatterAndLinks(content).links.sort(), ["__init__", "_a", "_assets/img_.png", "a ~~b~~ c", "b_", "x", "y.md"]);
    });

    it("reads links inside HTML blocks and an unclosed comment", () => {
        const content = '<p align="center">![](logo.png)</p>\n\n<details><summary>s</summary>\n[[det]]\n</details>\n\n<!-- todo\n\n[[later]]';
        assert.deepEqual(parseFrontmatterAndLinks(content).links.sort(), ["det", "later", "logo.png"]);
    });

    it("reads no tags or links out of image alt text after the image", () => {
        assert.deepEqual(parseFrontmatterAndLinks("![](a.png)#t [[![x](i.png)]]").tags, []);
        assert.deepEqual(parseFrontmatterAndLinks("[[a\\#b]]").links, ["a"]);
    });

    it("treats a backslash-escaped backtick as literal", () => {
        assert.deepEqual(parseFrontmatterAndLinks("\\`[[a]]\\` [[b]]").links.sort(), ["a", "b"]);
        // The rest of an escaped run still opens a span: \``x` is a literal ` and then code `x`.
        assert.deepEqual(parseFrontmatterAndLinks("\\``[[a]]` [[b]]").links, ["b"]);
        // An even number of backslashes escapes nothing.
        assert.deepEqual(parseFrontmatterAndLinks("\\\\`[[a]]` [[b]]").links, ["b"]);
        // Inside a span a backslash is literal, so `C:\` closes.
        assert.deepEqual(parseFrontmatterAndLinks("`C:\\` [[b]] `[[c]]`").links, ["b"]);
        assert.deepEqual(parseFrontmatterAndLinks("\\` #tag \\`").tags, ["tag"]);
    });

    it("drops #heading, #^block and #page anchors from wikilink targets", () => {
        const content = "[[Note#Heading]] [[folder/Other#^abc123|alias]] ![[paper.pdf#page=2]] ![[clip.mp4#t=10]] [[#Local heading]]";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.links.sort(), ["Note", "clip.mp4", "folder/Other", "paper.pdf"]);
    });

    it("handles anchors combined with aliases, sizes and titles", () => {
        const cases: Array<[string, string[]]> = [
            ["[[Note|see #3]]", ["Note"]], // a # in the alias is not an anchor
            ["[[Note#Heading|alias]]", ["Note"]],
            ["[[Note#]]", ["Note"]],
            ["[[Note#a#b]]", ["Note"]],
            ["![[img.png|300]]", ["img.png"]],
            ["![[img.png#crop|300]]", ["img.png"]], // anchor and embed size
            ['![](a.png#x "title")', ["a.png"]],
            ["[x](#heading)", []], // fragment only: a heading in the same note
        ];
        for (const [content, links] of cases) {
            assert.deepEqual(parseFrontmatterAndLinks(content).links, links, content);
        }
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
        const n = 40000;
        const hostile = [
            "[".repeat(2 * n), "[[".repeat(n), "[[a|".repeat(n), "[[a#".repeat(n),
            "[](a".repeat(n), "[](<".repeat(n), "[a](b.md".repeat(n),
            "[[a]".repeat(n), "[" + "[a]".repeat(n), "[![a](b)".repeat(n),
        ];
        for (const content of hostile) {
            const start = performance.now();
            parseFrontmatterAndLinks(content + " [[end]]");
            const ms = performance.now() - start;
            // Large enough that quadratic patterns take around 10 s here, so the
            // limit is far above linear time even on a slow CI runner.
            assert.ok(ms < 1000, `${JSON.stringify(content.slice(0, 8))}... took ${ms.toFixed(0)} ms`);
        }
        assert.deepEqual(parseFrontmatterAndLinks("[](a".repeat(10000) + " [[end]]").links, ["end"]);
    });

    it("keeps links with long text, aliases or percent-encoded targets", () => {
        const long = "x".repeat(5000);
        // 200 CJK characters are 1800 characters encoded but 200 decoded.
        const cjk = "图".repeat(200) + ".png";
        const content = [
            `![${long}](alt.png)`,
            `[[Note|${long}]]`,
            `[[Other#${long}]]`,
            `[${long}](linked.md)`,
            `![](${encodeURIComponent(cjk)})`,
        ].join("\n");
        assert.deepEqual(parseFrontmatterAndLinks(content).links.sort(), [cjk, "Note", "Other", "alt.png", "linked.md"].sort());
    });

    it("still drops attachment targets over the path length limit once decoded", () => {
        assert.deepEqual(parseFrontmatterAndLinks(`![](${"a".repeat(1001)}.png)`).links, []);
    });

    it("still finds links next to other brackets", () => {
        const content = "[see [1]](note.md) [![thumb](t.png)](full.png) [[a]][[b]] ([[c]]) [x](d.md)(e)";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.links.sort(), ["a", "b", "c", "d.md", "full.png", "note.md", "t.png"]);
    });

    it("does not let a link span lines", () => {
        // A markdown link's text may wrap (CommonMark), a wikilink may not.
        const result = parseFrontmatterAndLinks("[[broken\nlink]] [label\n](x.png)");
        assert.deepEqual(result.links, ["x.png"]);
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
