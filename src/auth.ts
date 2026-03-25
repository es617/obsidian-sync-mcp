/**
 * Password-gated OAuth provider for MCP.
 *
 * Implements a self-contained OAuth 2.1 flow:
 * - Claude connects -> gets 401 with metadata pointer
 * - Claude discovers /.well-known/oauth-protected-resource
 * - Claude registers via /oauth/register (DCR)
 * - Claude redirects user to /oauth/authorize
 * - User sees a password page, enters MCP_AUTH_TOKEN
 * - Claude exchanges code for access token via /oauth/token
 * - All subsequent requests carry Bearer token
 *
 * No external identity provider needed.
 */

import { randomUUID, randomBytes, createHash, timingSafeEqual } from "crypto";
import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";
import type { Hono } from "hono";

interface PendingAuth {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    state: string;
    code: string;
    createdAt: number;
}

interface TokenRecord {
    accessToken: string;
    refreshToken: string;
    clientId: string;
    expiresAt: number;
    refreshExpiresAt: number;
}

interface RegisteredClient {
    clientId: string;
    clientSecret: string;
    redirectUris: string[];
    clientName?: string;
}

const TOKEN_EXPIRY_MS = 3600 * 1000; // 1 hour
const DEFAULT_REFRESH_DAYS = 14;
const REFRESH_EXPIRY_MS = parseInt(process.env.MCP_REFRESH_DAYS ?? String(DEFAULT_REFRESH_DAYS)) * 24 * 3600 * 1000;
const MAX_FAILED_BEFORE_LOCKOUT = 5;
const BASE_LOCKOUT_MS = 5 * 1000; // 5 seconds, doubles each lockout
const MAX_CLIENTS = 100;
const MAX_PENDING = 100;
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface AuthHandle {
    validateToken: (auth: string | undefined) => boolean;
    saveTokens: () => Promise<void>;
    loadTokens: () => Promise<boolean>;
}

export function mountPasswordAuth(app: Hono, baseUrl: string, password: string, persistPath?: string): AuthHandle {
    const pendingAuths = new Map<string, PendingAuth>();
    const csrfTokens = new Map<string, string>(); // code -> csrf token
    const tokens = new Map<string, TokenRecord>();
    const refreshTokens = new Map<string, TokenRecord>();
    const clients = new Map<string, RegisteredClient>();

    // Cleanup expired pending auths and CSRF tokens
    function cleanupPending() {
        const now = Date.now();
        for (const [code, pending] of pendingAuths) {
            if (now - pending.createdAt > PENDING_TTL_MS) {
                pendingAuths.delete(code);
                csrfTokens.delete(code);
            }
        }
    }

    // Rate limiting: exponential backoff, never resets until success
    let failedAttempts = 0;
    let lockoutCount = 0;
    let lockedUntil = 0;

    // HTTPS warning
    if (!baseUrl.startsWith("https://") && !baseUrl.includes("localhost")) {
        console.warn("WARNING: BASE_URL is not HTTPS. OAuth tokens will be sent in cleartext. Use a tunnel (cloudflared, tailscale, ngrok) to provide TLS.");
    }

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
        if (clients.size >= MAX_CLIENTS) {
            return c.json({ error: "too_many_clients" }, 429);
        }
        const body = await c.req.json();

        // Validate redirect_uris
        const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.slice(0, 5) : [];
        if (redirectUris.length === 0) {
            return c.json({ error: "invalid_client_metadata", error_description: "redirect_uris required" }, 400);
        }
        if (redirectUris.some((u: any) => typeof u !== "string" || u.length > 2048)) {
            return c.json({ error: "invalid_client_metadata", error_description: "invalid redirect_uri" }, 400);
        }

        const clientId = randomUUID();
        const clientSecret = randomBytes(32).toString("hex");
        const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 256) : undefined;

        const client: RegisteredClient = {
            clientId,
            clientSecret,
            redirectUris,
            clientName,
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

        // Validate redirect URI against registered client
        const client = clients.get(clientId);
        if (!client) {
            return c.text("Unknown client", 400);
        }
        if (!client.redirectUris.includes(redirectUri)) {
            return c.text("Invalid redirect URI", 400);
        }

        // Require S256 PKCE
        if (codeChallengeMethod !== "S256" || !codeChallenge) {
            return c.text("PKCE with S256 is required", 400);
        }

        cleanupPending();
        if (pendingAuths.size >= MAX_PENDING) {
            return c.text("Too many pending authorizations", 429);
        }

        const code = randomBytes(32).toString("hex");
        pendingAuths.set(code, {
            clientId,
            redirectUri,
            codeChallenge,
            codeChallengeMethod,
            state,
            code,
            createdAt: Date.now(),
        });

        const csrf = randomBytes(32).toString("hex");
        csrfTokens.set(code, csrf);
        return c.html(renderPasswordPage(code, csrf));
    });

    // --- Approval handler ---

    app.post("/oauth/approve", async (c) => {
        const body = await c.req.parseBody();
        const code = body["code"] as string;
        const submittedCsrf = body["csrf"] as string;
        const submittedPassword = body["password"] as string;

        const pending = pendingAuths.get(code);
        const expectedCsrf = csrfTokens.get(code);
        if (!pending || !expectedCsrf) {
            return c.html("<p>Invalid or expired authorization request.</p>", 400);
        }

        // Validate CSRF token
        const csrfA = Buffer.from(submittedCsrf ?? "");
        const csrfB = Buffer.from(expectedCsrf);
        if (csrfA.length !== csrfB.length || !timingSafeEqual(csrfA, csrfB)) {
            return c.html("<p>Invalid request.</p>", 403);
        }

        // Rate limiting: check lockout
        if (Date.now() < lockedUntil) {
            const waitSec = Math.ceil((lockedUntil - Date.now()) / 1000);
            console.warn(`Auth: locked out, ${waitSec}s remaining`);
            return c.html(renderPasswordPage(code, expectedCsrf, `Too many attempts. Try again in ${waitSec} seconds.`), 429);
        }

        const a = Buffer.from(submittedPassword);
        const b = Buffer.from(password);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
            failedAttempts++;
            console.warn(`Auth: failed attempt ${failedAttempts} total`);

            if (failedAttempts >= MAX_FAILED_BEFORE_LOCKOUT) {
                lockoutCount++;
                const lockoutMs = BASE_LOCKOUT_MS * Math.pow(2, lockoutCount - 1);
                lockedUntil = Date.now() + lockoutMs;
                console.warn(`Auth: lockout #${lockoutCount}, ${lockoutMs / 1000}s`);
                return c.html(renderPasswordPage(code, expectedCsrf, `Too many attempts. Try again in ${Math.ceil(lockoutMs / 1000)} seconds.`), 429);
            }

            return c.html(renderPasswordPage(code, expectedCsrf, "Wrong password."), 401);
        }

        // Password correct — reset everything
        failedAttempts = 0;
        lockoutCount = 0;
        lockedUntil = 0;
        csrfTokens.delete(code);
        console.log("Auth: password accepted, issuing authorization code.");

        const url = new URL(pending.redirectUri);
        url.searchParams.set("code", code);
        if (pending.state) url.searchParams.set("state", pending.state);
        const redirectUrl = url.toString();

        return c.redirect(redirectUrl);
    });

    // --- Token endpoint ---

    app.post("/oauth/token", async (c) => {
        const body = await c.req.parseBody();
        const grantType = body["grant_type"] as string;

        if (grantType === "authorization_code") {
            const code = body["code"] as string;
            const codeVerifier = body["code_verifier"] as string;
            const redirectUri = body["redirect_uri"] as string;

            const pending = pendingAuths.get(code);
            if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
                if (pending) pendingAuths.delete(code);
                return c.json({ error: "invalid_grant" }, 400);
            }

            // Verify redirect_uri matches the original request
            if (redirectUri !== pending.redirectUri) {
                return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
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
                refreshExpiresAt: Date.now() + REFRESH_EXPIRY_MS,
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

            // Check refresh token expiry
            if (Date.now() > old.refreshExpiresAt) {
                tokens.delete(old.accessToken);
                refreshTokens.delete(refreshToken);
                console.log("Auth: refresh token expired, user must re-authenticate.");
                return c.json({ error: "invalid_grant", error_description: "Refresh token expired" }, 400);
            }

            tokens.delete(old.accessToken);
            refreshTokens.delete(refreshToken);

            const accessToken = randomBytes(32).toString("hex");
            const newRefreshToken = randomBytes(32).toString("hex");
            const record: TokenRecord = {
                accessToken,
                refreshToken: newRefreshToken,
                clientId: old.clientId,
                expiresAt: Date.now() + TOKEN_EXPIRY_MS,
                refreshExpiresAt: old.refreshExpiresAt, // keep original expiry
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

    return {
        validateToken(authHeader: string | undefined): boolean {
            if (!authHeader?.startsWith("Bearer ")) return false;
            const token = authHeader.slice(7);
            const record = tokens.get(token);
            if (!record) return false;
            if (Date.now() > record.expiresAt) {
                tokens.delete(token);
                return false;
            }
            return true;
        },

        async saveTokens(): Promise<void> {
            if (!persistPath) return;
            try {
                await mkdir(dirname(persistPath), { recursive: true });
                const data = JSON.stringify({
                    tokens: Object.fromEntries(tokens),
                    refreshTokens: Object.fromEntries(refreshTokens),
                    clients: Object.fromEntries(clients),
                });
                await writeFile(persistPath, data, { encoding: "utf-8", mode: 0o600 });
                await chmod(persistPath, 0o600);
                console.log(`Auth tokens saved to disk (${tokens.size} sessions).`);
            } catch (err) {
                console.error("Failed to save auth tokens:", err);
            }
        },

        async loadTokens(): Promise<boolean> {
            if (!persistPath) return false;
            try {
                const raw = await readFile(persistPath, "utf-8");
                const data = JSON.parse(raw);
                const now = Date.now();
                for (const [k, v] of Object.entries(data.tokens ?? {})) {
                    const record = v as TokenRecord;
                    if (record.expiresAt > now) tokens.set(k, record);
                }
                for (const [k, v] of Object.entries(data.refreshTokens ?? {})) {
                    const record = v as TokenRecord;
                    if (record.refreshExpiresAt > now) refreshTokens.set(k, record);
                }
                for (const [k, v] of Object.entries(data.clients ?? {})) {
                    clients.set(k, v as RegisteredClient);
                }
                console.log(`Auth tokens loaded from disk (${tokens.size} sessions).`);
                return tokens.size > 0;
            } catch {
                return false;
            }
        },
    };
}

function renderPasswordPage(code: string, csrf: string, error?: string): string {
    return `<!DOCTYPE html>
<html><head><title>Obsidian Sync MCP - Authorize</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  body { font-family: system-ui; max-width: 400px; margin: 80px auto; padding: 0 20px; }
  h1 { font-size: 1.3em; }
  input[type=password] { width: 100%; padding: 10px; margin: 10px 0; box-sizing: border-box; font-size: 1em; }
  button { padding: 10px 20px; font-size: 1em; cursor: pointer; }
  .error { color: red; }
</style></head>
<body>
  <h1>Obsidian Sync MCP</h1>
  ${error ? `<p class="error">${error.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>` : "<p>Enter the server password to authorize access to your vault.</p>"}
  <form method="POST" action="/oauth/approve" autocomplete="on">
    <input type="hidden" name="code" value="${code}">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="text" name="username" id="username" value="obsidian-sync-mcp" autocomplete="username" style="position:absolute;opacity:0;width:1px;height:1px;pointer-events:none">
    <input type="password" name="password" id="password" placeholder="Password" autocomplete="current-password" autofocus required>
    <br><button type="submit">Authorize</button>
  </form>
</body></html>`;
}
