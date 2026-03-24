import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDeepLink } from "./deeplink.js";

describe("makeDeepLink", () => {
    it("strips .md extension from path", () => {
        assert.equal(
            makeDeepLink("MyVault", "notes/hello.md"),
            "obsidian://open?vault=MyVault&file=notes%2Fhello",
        );
    });

    it("handles path without .md extension", () => {
        assert.equal(
            makeDeepLink("MyVault", "notes/hello"),
            "obsidian://open?vault=MyVault&file=notes%2Fhello",
        );
    });

    it("encodes spaces in vault name", () => {
        assert.equal(
            makeDeepLink("My Vault", "note.md"),
            "obsidian://open?vault=My%20Vault&file=note",
        );
    });

    it("encodes spaces and slashes in path", () => {
        assert.equal(
            makeDeepLink("V", "folder/sub folder/note.md"),
            "obsidian://open?vault=V&file=folder%2Fsub%20folder%2Fnote",
        );
    });

    it("handles empty path", () => {
        assert.equal(makeDeepLink("V", ""), "obsidian://open?vault=V&file=");
    });

    it("only strips trailing .md, not mid-path", () => {
        assert.equal(
            makeDeepLink("V", "my.md.backup/note.md"),
            "obsidian://open?vault=V&file=my.md.backup%2Fnote",
        );
    });
});
