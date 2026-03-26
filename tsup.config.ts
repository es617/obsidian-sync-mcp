import { defineConfig } from "tsup";
import path from "path";
import { readFileSync, existsSync } from "fs";
import type { Plugin } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

function resolveWithExtensions(base: string, rel: string): string | null {
    const full = path.join(base, rel);
    // Try exact, then .ts, then /index.ts
    for (const candidate of [full, full + ".ts", path.join(full, "index.ts")]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

const livesyncAliases: Plugin = {
    name: "livesync-aliases",
    setup(build) {
        const libSrc = path.resolve("lib/livesync-commonlib/src");
        const stubs = path.resolve("src/stubs");

        // Redirect bgWorker to mock (no web workers in Node)
        build.onResolve({ filter: /bgWorker/ }, () => {
            return { path: path.join(libSrc, "worker/bgWorker.mock.ts") };
        });

        // Redirect pouchdb-browser to pouchdb-http (no IndexedDB in Node)
        build.onResolve({ filter: /pouchdb-browser/ }, () => {
            return { path: path.join(libSrc, "pouchdb/pouchdb-http.ts") };
        });

        // Stub out svelte (UI components we don't need in Node)
        build.onResolve({ filter: /^svelte/ }, () => {
            return { path: path.join(stubs, "svelte.ts") };
        });

        // Resolve @lib/ paths (livesync-commonlib source)
        build.onResolve({ filter: /^@lib\// }, (args) => {
            const rel = args.path.replace(/^@lib\//, "");
            const resolved = resolveWithExtensions(libSrc, rel);
            if (resolved) return { path: resolved };
        });

        // Resolve @/ paths to stubs
        build.onResolve({ filter: /^@\// }, (args) => {
            const rel = args.path.replace(/^@\//, "");
            const resolved = resolveWithExtensions(stubs, rel);
            if (resolved) return { path: resolved };
        });
    },
};

export default defineConfig({
    entry: ["src/main.ts"],
    format: ["esm"],
    target: "node22",
    platform: "node",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    noExternal: [/livesync-commonlib/, /\.\/stubs/],
    banner: {
        js: `#!/usr/bin/env node
// Node polyfills for livesync-commonlib browser globals
if(!("navigator" in globalThis)){globalThis.navigator={language:"en"};}`,
    },
    define: {
        "process.env.npm_package_version": JSON.stringify(pkg.version),
    },
    esbuildPlugins: [livesyncAliases],
});
