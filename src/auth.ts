/**
 * Password-gated OAuth provider for MCP.
 *
 * Implements a self-contained OAuth 2.1 flow:
 * - Claude connects → gets 401 with metadata pointer
 * - Claude discovers /.well-known/oauth-protected-resource
 * - Claude registers via /oauth/register (DCR)
 * - Claude redirects user to /oauth/authorize
 * - User sees a password page, enters MCP_AUTH_TOKEN
 * - Claude exchanges code for access token via /oauth/token
 * - All subsequent requests carry Bearer token
 *
 * No external identity provider needed.
 */

import { randomUUID, randomBytes, createHash } from "crypto";
import type { Hono } from "hono";

interface PendingAuth {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    state: string;
    code: string;
}

interface TokenRecord {
    accessToken: string;
    refreshToken: string;
    clientId: string;
    expiresAt: number;
}

interface RegisteredClient {
    clientId: string;
    clientSecret: string;
    redirectUris: string[];
    clientName?: string;
}

const TOKEN_EXPIRY_MS = 3600 * 1000; // 1 hour

export function mountPasswordAuth(app: Hono, baseUrl: string, password: string) {
    const pendingAuths = new Map<string, PendingAuth>();
    const tokens = new Map<string, TokenRecord>(); // accessToken -> record
    const refreshTokens = new Map<string, TokenRecord>(); // refreshToken -> record
    const clients = new Map<string, RegisteredClient>();

    // --- Discovery endpoints ---

    app.get("/.well-known/oauth-protected-resource", (c) => {
        return c.json({
            resource: baseUrl,
            authorization_servers: [baseUrl],
            scopes_supported: ["mcp"],
        });
    });

    app.get("/.well-known/oauth-authorization-server", (c) => {
        return c.json({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/oauth/authorize`,
            token_endpoint: `${baseUrl}/oauth/token`,
            registration_endpoint: `${baseUrl}/oauth/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
            scopes_supported: ["mcp"],
        });
    });

    // --- Dynamic Client Registration (RFC 7591) ---

    app.post("/oauth/register", async (c) => {
        const body = await c.req.json();
        const clientId = randomUUID();
        const clientSecret = randomBytes(32).toString("hex");

        const client: RegisteredClient = {
            clientId,
            clientSecret,
            redirectUris: body.redirect_uris || [],
            clientName: body.client_name,
        };
        clients.set(clientId, client);

        return c.json({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris: client.redirectUris,
            client_name: client.clientName,
            token_endpoint_auth_method: "client_secret_post",
        }, 201);
    });

    // --- Authorization endpoint ---

    app.get("/oauth/authorize", (c) => {
        const clientId = c.req.query("client_id") ?? "";
        const redirectUri = c.req.query("redirect_uri") ?? "";
        const codeChallenge = c.req.query("code_challenge") ?? "";
        const codeChallengeMethod = c.req.query("code_challenge_method") ?? "S256";
        const state = c.req.query("state") ?? "";

        const code = randomBytes(32).toString("hex");
        pendingAuths.set(code, {
            clientId,
            redirectUri,
            codeChallenge,
            codeChallengeMethod,
            state,
            code,
        });

        // Render password page
        const html = `<!DOCTYPE html>
<html><head><title>Obsidian Sync MCP - Authorize</title>
<style>
  body { font-family: system-ui; max-width: 400px; margin: 80px auto; padding: 0 20px; }
  h1 { font-size: 1.3em; }
  input[type=password] { width: 100%; padding: 10px; margin: 10px 0; box-sizing: border-box; font-size: 1em; }
  button { padding: 10px 20px; font-size: 1em; cursor: pointer; }
  .error { color: red; }
</style></head>
<body>
  <h1>Obsidian Sync MCP</h1>
  <p>Enter the server password to authorize access to your vault.</p>
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="code" value="${code}">
    <input type="password" name="password" placeholder="Password" autofocus required>
    <br><button type="submit">Authorize</button>
  </form>
</body></html>`;

        return c.html(html);
    });

    // --- Approval handler ---

    app.post("/oauth/approve", async (c) => {
        const body = await c.req.parseBody();
        const code = body["code"] as string;
        const submittedPassword = body["password"] as string;

        const pending = pendingAuths.get(code);
        if (!pending) {
            return c.html("<p>Invalid or expired authorization request.</p>", 400);
        }

        if (submittedPassword !== password) {
            // Re-render with error
            const html = `<!DOCTYPE html>
<html><head><title>Obsidian Sync MCP - Authorize</title>
<style>
  body { font-family: system-ui; max-width: 400px; margin: 80px auto; padding: 0 20px; }
  h1 { font-size: 1.3em; }
  input[type=password] { width: 100%; padding: 10px; margin: 10px 0; box-sizing: border-box; font-size: 1em; }
  button { padding: 10px 20px; font-size: 1em; cursor: pointer; }
  .error { color: red; }
</style></head>
<body>
  <h1>Obsidian Sync MCP</h1>
  <p class="error">Wrong password. Try again.</p>
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="code" value="${code}">
    <input type="password" name="password" placeholder="Password" autofocus required>
    <br><button type="submit">Authorize</button>
  </form>
</body></html>`;
            return c.html(html, 401);
        }

        // Password correct — redirect back with auth code
        const url = new URL(pending.redirectUri);
        url.searchParams.set("code", code);
        if (pending.state) url.searchParams.set("state", pending.state);

        return c.redirect(url.toString());
    });

    // --- Token endpoint ---

    app.post("/oauth/token", async (c) => {
        const body = await c.req.parseBody();
        const grantType = body["grant_type"] as string;

        if (grantType === "authorization_code") {
            const code = body["code"] as string;
            const codeVerifier = body["code_verifier"] as string;

            const pending = pendingAuths.get(code);
            if (!pending) {
                return c.json({ error: "invalid_grant" }, 400);
            }

            // Verify PKCE
            if (pending.codeChallengeMethod === "S256") {
                const expected = createHash("sha256")
                    .update(codeVerifier)
                    .digest("base64url");
                if (expected !== pending.codeChallenge) {
                    return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
                }
            }

            pendingAuths.delete(code);

            const accessToken = randomBytes(32).toString("hex");
            const refreshToken = randomBytes(32).toString("hex");
            const record: TokenRecord = {
                accessToken,
                refreshToken,
                clientId: pending.clientId,
                expiresAt: Date.now() + TOKEN_EXPIRY_MS,
            };
            tokens.set(accessToken, record);
            refreshTokens.set(refreshToken, record);

            return c.json({
                access_token: accessToken,
                token_type: "Bearer",
                expires_in: TOKEN_EXPIRY_MS / 1000,
                refresh_token: refreshToken,
            });
        }

        if (grantType === "refresh_token") {
            const refreshToken = body["refresh_token"] as string;
            const old = refreshTokens.get(refreshToken);
            if (!old) {
                return c.json({ error: "invalid_grant" }, 400);
            }

            // Revoke old tokens
            tokens.delete(old.accessToken);
            refreshTokens.delete(refreshToken);

            // Issue new tokens
            const accessToken = randomBytes(32).toString("hex");
            const newRefreshToken = randomBytes(32).toString("hex");
            const record: TokenRecord = {
                accessToken,
                refreshToken: newRefreshToken,
                clientId: old.clientId,
                expiresAt: Date.now() + TOKEN_EXPIRY_MS,
            };
            tokens.set(accessToken, record);
            refreshTokens.set(newRefreshToken, record);

            return c.json({
                access_token: accessToken,
                token_type: "Bearer",
                expires_in: TOKEN_EXPIRY_MS / 1000,
                refresh_token: newRefreshToken,
            });
        }

        return c.json({ error: "unsupported_grant_type" }, 400);
    });

    // Return a middleware function that validates Bearer tokens
    return function validateToken(authHeader: string | undefined): boolean {
        if (!authHeader?.startsWith("Bearer ")) return false;
        const token = authHeader.slice(7);
        const record = tokens.get(token);
        if (!record) return false;
        if (Date.now() > record.expiresAt) {
            tokens.delete(token);
            return false;
        }
        return true;
    };
}
