import { defineConfig } from "tsup";
import path from "path";
import type { Plugin } from "esbuild";

const livesyncAliases: Plugin = {
    name: "livesync-aliases",
    setup(build) {
        const libSrc = path.resolve("lib/livesync-commonlib/src");
        const stubs = path.resolve("src/stubs");

        // Redirect bgWorker to mock (no web workers in Node)
        build.onResolve({ filter: /bgWorker/ }, (args) => {
            return { path: path.join(libSrc, "worker/bgWorker.mock.ts") };
        });

        // Redirect pouchdb-browser to pouchdb-http (no IndexedDB in Node)
        build.onResolve({ filter: /pouchdb-browser/ }, (args) => {
            return { path: path.join(libSrc, "pouchdb/pouchdb-http.ts") };
        });

        // Resolve @lib/ paths
        build.onResolve({ filter: /^@lib\// }, (args) => {
            const resolved = args.path.replace(/^@lib\//, "");
            return { path: path.join(libSrc, resolved) };
        });

        // Resolve @/ paths to stubs
        build.onResolve({ filter: /^@\// }, (args) => {
            const resolved = args.path.replace(/^@\//, "");
            return { path: path.join(stubs, resolved) };
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
        js: `// Node polyfills for livesync-commonlib browser globals
if(!("navigator" in globalThis)){globalThis.navigator={language:"en"};}`,
    },
    esbuildPlugins: [livesyncAliases],
});
