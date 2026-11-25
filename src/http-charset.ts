/**
 * Declare `charset=utf-8` on JSON and event-stream responses (#16).
 *
 * The MCP transport (mcp-proxy 6.4, inside fastmcp 3) sends UTF-8 with a bare
 * `application/json` or `text/event-stream`, so clients that fall back to
 * Latin-1 show Cyrillic or CJK text as mojibake. mcp-proxy 6.7+ adds the
 * charset, but it also serves the 2026-07-28 protocol through a handler that
 * servers built by fastmcp 3 and 4 (MCP SDK 1.x) can't use: 6.7 crashed on it
 * (#18) and 6.10 builds and drops a session per connection (#64). So the
 * header is completed here instead, where Node writes it.
 *
 * Every response goes through ServerResponse.writeHead, also one whose headers
 * were only set with setHeader (Node then calls writeHead itself), so wrapping
 * it covers every way a handler can set Content-Type.
 *
 * Remove this once fastmcp is on MCP SDK 2.x and mcp-proxy can be upgraded.
 */

import { ServerResponse } from "node:http";

const NEEDS_CHARSET = /^\s*(?:application\/json|text\/event-stream)\s*(?:;|$)/i;

/** `type` with "; charset=utf-8" added when it is JSON or an event stream without a charset. */
export function withUtf8(type: string): string {
    return NEEDS_CHARSET.test(type) && !/;\s*charset=/i.test(type) ? `${type}; charset=utf-8` : type;
}

const INSTALLED = Symbol.for("obsidian-sync-mcp.utf8-charset");

/** Wrap ServerResponse.writeHead, once per process. */
export function declareUtf8Charset(): void {
    const proto = ServerResponse.prototype as ServerResponse & { [INSTALLED]?: true };
    if (proto[INSTALLED]) return;
    proto[INSTALLED] = true;

    const writeHead = proto.writeHead;
    proto.writeHead = function (this: ServerResponse, ...args: unknown[]) {
        const set = this.getHeader("content-type");
        if (typeof set === "string") this.setHeader("content-type", withUtf8(set));
        // writeHead(statusCode, [statusMessage], [headers])
        const at = typeof args[1] === "string" ? 2 : 1;
        args[at] = withUtf8Headers(args[at]);
        return writeHead.apply(this, args as Parameters<typeof writeHead>);
    } as typeof writeHead;
}

/** A copy of writeHead's headers argument (an object or a flat [name, value, ...] list) with Content-Type completed. */
function withUtf8Headers(headers: unknown): unknown {
    const isContentType = (name: unknown) => typeof name === "string" && name.toLowerCase() === "content-type";
    if (Array.isArray(headers)) {
        return headers.map((value, i) => (i % 2 === 1 && isContentType(headers[i - 1]) && typeof value === "string" ? withUtf8(value) : value));
    }
    if (headers && typeof headers === "object") {
        return Object.fromEntries(
            Object.entries(headers).map(([name, value]) => [name, isContentType(name) && typeof value === "string" ? withUtf8(value) : value]),
        );
    }
    return headers;
}
