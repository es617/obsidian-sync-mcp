import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createHash, randomBytes } from "crypto";
import { mountPasswordAuth } from "./auth.js";

function setup(password = "test-password") {
    const app = new Hono();
    const baseUrl = "https://example.com";
    const auth = mountPasswordAuth(app, baseUrl, password);
    return { app, baseUrl, validateToken: auth.validateToken };
}

function generatePKCE() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

async function registerClient(app: Hono, redirectUri = "https://app.example.com/callback") {
    const resp = await app.request("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "test", redirect_uris: [redirectUri] }),
    });
    return (await resp.json()) as { client_id: string; client_secret: string };
}

function extractHiddenFields(html: string): Record<string, string> {
    const fields: Record<string, string> = {};
    const re = /name="(\w+)"\s+value="([^"]*)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        fields[m[1]] = m[2];
    }
    return fields;
}

async function getAuthorizePage(
    app: Hono,
    clientId: string,
    challenge: string,
    redirectUri = "https://app.example.com/callback",
) {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "test-state",
        response_type: "code",
    });
    const resp = await app.request(`/oauth/authorize?${params}`);
    const html = await resp.text();
    return { resp, html, fields: extractHiddenFields(html) };
}

async function submitPassword(app: Hono, code: string, csrf: string, password: string) {
    return app.request("/oauth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, csrf, password }).toString(),
    });
}

async function completeOAuthFlow(app: Hono, password: string) {
    const pkce = generatePKCE();
    const client = await registerClient(app);
    const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
    const approveResp = await submitPassword(app, fields.code, fields.csrf, password);
    assert.equal(approveResp.status, 302, "approve should redirect");
    const location = approveResp.headers.get("location")!;
    const authCode = new URL(location).searchParams.get("code")!;

    const tokenResp = await app.request("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: authCode,
            client_id: client.client_id,
            code_verifier: pkce.verifier,
            redirect_uri: "https://app.example.com/callback",
        }).toString(),
    });
    return (await tokenResp.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
    };
}

// --- Tests ---

describe("OAuth Discovery", () => {
    it("serves protected resource metadata", async () => {
        const { app, baseUrl } = setup();
        const resp = await app.request("/.well-known/oauth-protected-resource");
        const body = (await resp.json()) as any;
        assert.equal(body.resource, baseUrl);
        assert.deepEqual(body.authorization_servers, [baseUrl]);
    });

    it("serves authorization server metadata with S256", async () => {
        const { app, baseUrl } = setup();
        const resp = await app.request("/.well-known/oauth-authorization-server");
        const body = (await resp.json()) as any;
        assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
        assert.equal(body.token_endpoint, `${baseUrl}/oauth/token`);
        assert.equal(body.registration_endpoint, `${baseUrl}/oauth/register`);
    });
});

describe("Dynamic Client Registration", () => {
    it("returns 201 with client_id and client_secret", async () => {
        const { app } = setup();
        const resp = await app.request("/oauth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_name: "test", redirect_uris: ["https://x.com/cb"] }),
        });
        assert.equal(resp.status, 201);
        const body = (await resp.json()) as any;
        assert.ok(body.client_id);
        assert.ok(body.client_secret);
        assert.deepEqual(body.redirect_uris, ["https://x.com/cb"]);
    });
});

describe("/oauth/authorize", () => {
    it("rejects unknown client_id", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const params = new URLSearchParams({
            client_id: "unknown",
            redirect_uri: "https://x.com/cb",
            code_challenge: pkce.challenge,
            code_challenge_method: "S256",
        });
        const resp = await app.request(`/oauth/authorize?${params}`);
        assert.equal(resp.status, 400);
        assert.ok((await resp.text()).includes("Unknown client"));
    });

    it("rejects unregistered redirect_uri", async () => {
        const { app } = setup();
        const client = await registerClient(app, "https://legit.com/cb");
        const pkce = generatePKCE();
        const params = new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: "https://evil.com/steal",
            code_challenge: pkce.challenge,
            code_challenge_method: "S256",
        });
        const resp = await app.request(`/oauth/authorize?${params}`);
        assert.equal(resp.status, 400);
        assert.ok((await resp.text()).includes("Invalid redirect URI"));
    });

    it("rejects missing code_challenge", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const params = new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: "https://app.example.com/callback",
            code_challenge_method: "S256",
        });
        const resp = await app.request(`/oauth/authorize?${params}`);
        assert.equal(resp.status, 400);
        assert.ok((await resp.text()).includes("PKCE"));
    });

    it("rejects code_challenge_method other than S256", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const params = new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: "https://app.example.com/callback",
            code_challenge: "test",
            code_challenge_method: "plain",
        });
        const resp = await app.request(`/oauth/authorize?${params}`);
        assert.equal(resp.status, 400);
    });

    it("returns HTML form with code and csrf fields", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const pkce = generatePKCE();
        const { resp, fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        assert.equal(resp.status, 200);
        assert.ok(fields.code);
        assert.ok(fields.csrf);
    });
});

describe("/oauth/approve — password validation", () => {
    it("rejects invalid code", async () => {
        const { app } = setup();
        const resp = await submitPassword(app, "bad-code", "bad-csrf", "test-password");
        assert.equal(resp.status, 400);
    });

    it("rejects wrong CSRF token", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const pkce = generatePKCE();
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const resp = await submitPassword(app, fields.code, "wrong-csrf", "test-password");
        assert.equal(resp.status, 403);
    });

    it("rejects wrong password", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const pkce = generatePKCE();
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const resp = await submitPassword(app, fields.code, fields.csrf, "wrong");
        assert.equal(resp.status, 401);
        assert.ok((await resp.text()).includes("Wrong password"));
    });

    it("redirects with code and state on correct password", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const pkce = generatePKCE();
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const resp = await submitPassword(app, fields.code, fields.csrf, "test-password");
        assert.equal(resp.status, 302);
        const location = resp.headers.get("location")!;
        assert.ok(location.includes("code="));
        assert.ok(location.includes("state=test-state"));
    });
});

describe("/oauth/approve — rate limiting", () => {
    it("locks out after 5 failed attempts", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const pkce = generatePKCE();

        for (let i = 0; i < 5; i++) {
            const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
            const resp = await submitPassword(app, fields.code, fields.csrf, "wrong");
            if (i < 4) {
                assert.equal(resp.status, 401, `attempt ${i + 1} should be 401`);
            } else {
                assert.equal(resp.status, 429, `attempt ${i + 1} should trigger lockout`);
                assert.ok((await resp.text()).includes("Too many attempts"));
            }
        }
    });

    it("resets counters on successful login", async () => {
        const { app } = setup("mypass");
        const client = await registerClient(app);
        const pkce = generatePKCE();

        // Fail 4 times (just under lockout)
        for (let i = 0; i < 4; i++) {
            const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
            await submitPassword(app, fields.code, fields.csrf, "wrong");
        }

        // Succeed
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const resp = await submitPassword(app, fields.code, fields.csrf, "mypass");
        assert.equal(resp.status, 302);

        // Fail 4 more times — should NOT lock out (counter was reset)
        for (let i = 0; i < 4; i++) {
            const { fields: f } = await getAuthorizePage(app, client.client_id, pkce.challenge);
            const r = await submitPassword(app, f.code, f.csrf, "wrong");
            assert.equal(r.status, 401, `post-reset attempt ${i + 1} should be 401, not 429`);
        }
    });
});

describe("Token Exchange", () => {
    it("issues tokens with correct PKCE", async () => {
        const { app } = setup();
        const tokens = await completeOAuthFlow(app, "test-password");
        assert.ok(tokens.access_token);
        assert.ok(tokens.refresh_token);
        assert.equal(tokens.expires_in, 3600);
    });

    it("rejects incorrect PKCE verifier", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const client = await registerClient(app);
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const approveResp = await submitPassword(app, fields.code, fields.csrf, "test-password");
        const location = approveResp.headers.get("location")!;
        const authCode = new URL(location).searchParams.get("code")!;

        const tokenResp = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: authCode,
                client_id: client.client_id,
                code_verifier: "wrong-verifier",
                redirect_uri: "https://app.example.com/callback",
            }).toString(),
        });
        assert.equal(tokenResp.status, 400);
        const body = (await tokenResp.json()) as any;
        assert.equal(body.error, "invalid_grant");
    });

    it("rejects wrong client_id at token exchange", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const client = await registerClient(app);
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const approveResp = await submitPassword(app, fields.code, fields.csrf, "test-password");
        const location = approveResp.headers.get("location")!;
        const authCode = new URL(location).searchParams.get("code")!;

        const tokenResp = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: authCode,
                client_id: "wrong-client-id",
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }).toString(),
        });
        assert.equal(tokenResp.status, 400);
        const body = (await tokenResp.json()) as any;
        assert.equal(body.error, "invalid_grant");
    });

    it("authorization code is single-use", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const client = await registerClient(app);
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const approveResp = await submitPassword(app, fields.code, fields.csrf, "test-password");
        const location = approveResp.headers.get("location")!;
        const authCode = new URL(location).searchParams.get("code")!;

        // First exchange: success
        const resp1 = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: authCode,
                client_id: client.client_id,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }).toString(),
        });
        assert.equal(resp1.status, 200);

        // Second exchange: fail
        const resp2 = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: authCode,
                client_id: client.client_id,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }).toString(),
        });
        assert.equal(resp2.status, 400);
    });

    it("rejects unsupported grant_type", async () => {
        const { app } = setup();
        const resp = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
        });
        assert.equal(resp.status, 400);
    });
});

describe("Token Refresh", () => {
    it("rotates tokens — old ones invalidated", async () => {
        const { app, validateToken } = setup();
        const tokens = await completeOAuthFlow(app, "test-password");

        // Old token works
        assert.ok(validateToken(`Bearer ${tokens.access_token}`));

        // Refresh
        const refreshResp = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: tokens.refresh_token,
            }).toString(),
        });
        assert.equal(refreshResp.status, 200);
        const newTokens = (await refreshResp.json()) as any;
        assert.ok(newTokens.access_token);
        assert.notEqual(newTokens.access_token, tokens.access_token);

        // Old token no longer works
        assert.equal(validateToken(`Bearer ${tokens.access_token}`), false);

        // New token works
        assert.ok(validateToken(`Bearer ${newTokens.access_token}`));

        // Old refresh token no longer works
        const resp2 = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: tokens.refresh_token,
            }).toString(),
        });
        assert.equal(resp2.status, 400);
    });
});

describe("validateToken", () => {
    it("returns false for undefined", () => {
        const { validateToken } = setup();
        assert.equal(validateToken(undefined), false);
    });

    it("returns false for non-Bearer header", () => {
        const { validateToken } = setup();
        assert.equal(validateToken("Basic abc"), false);
    });

    it("returns false for unknown token", () => {
        const { validateToken } = setup();
        assert.equal(validateToken("Bearer bad-token"), false);
    });

    it("returns true for valid token from OAuth flow", async () => {
        const { app, validateToken } = setup();
        const tokens = await completeOAuthFlow(app, "test-password");
        assert.ok(validateToken(`Bearer ${tokens.access_token}`));
    });
});
