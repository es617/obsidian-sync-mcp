# TODO — v0.1.3 Release Plan

## Tomorrow — in order

### 1. Tag v0.1.3 and verify ghcr.io image (~5 min)
- Commit remaining changes, tag, push
- Wait for CI to publish to ghcr.io and npm
- Verify image works: `docker pull ghcr.io/es617/obsidian-sync-mcp:v0.1.3`

### 2. Test `npx obsidian-sync-mcp` (~5 min)
- Verify the npm package works standalone: `VAULT_PATH=~/Documents/MyVault npx obsidian-sync-mcp`
- This is the primary install method in the README

### 3. Test Fly.io deploy button (~10 min)
- Click the Deploy on Fly button from the README
- Verify it clones, builds, and deploys without manual steps
- May need to fix fly.toml or Dockerfile paths

### 4. Test setup.sh (~10 min)
- Fresh: `git clone ... && ./deploy/setup.sh`
- Verify it generates creds, creates volume, deploys
- Verify LiveSync can connect with the output credentials

### 5. Test least-privilege LiveSync user (~15 min)
- Set LIVESYNC_USER + LIVESYNC_PASSWORD on Fly.io test app
- Verify entrypoint creates the user and sets DB security
- Verify LiveSync can connect with the non-admin user
- Verify admin can still access

### 6. Test standalone MCP deploy for existing LiveSync users (~10 min)
- `fly launch --image ghcr.io/es617/obsidian-sync-mcp:v0.1.3`
- Point at the existing test CouchDB
- Verify tools work

### 7. Test deep links on mobile (~5 min)
- Open Claude on phone with the Fly.io MCP connected
- Ask to read a note, tap the obsidian:// link
- Verify it opens Obsidian to the right note

### 8. Publish combined CouchDB+MCP image (~15 min)
- Add CI job to build and push Dockerfile.fly as `obsidian-sync-mcp-fly`
- Enables `fly deploy --image` updates without cloning the repo

### 9. Final cleanup (~10 min)
- Remove Dockerfile.dev.fly reference from gitignore if no longer needed
- Clean up test Fly.io app
- Final README pass
- Tag v0.1.3 if not already done

## Won't fix for v0.1.3

- **Auth tab stays open** — cosmetic, tried multiple approaches, all broke the flow
- **move_note race condition** — edge case, content could change between read and move
- **Browser password save** — browsers don't trigger save on OAuth redirect flows

## Later

- [ ] Multi-vault support
- [ ] Backlinks / graph query tool
- [ ] Attachment support (images, PDFs)
- [ ] Upstream the `_enumerate` bug fix
- [ ] Standalone CouchDB deploy (self-hosted Obsidian Sync without MCP)
- [ ] PR to `vrtmrz/self-hosted-livesync-server` adding Fly.io deploy
- [ ] Support for other backends (S3, etc.)
