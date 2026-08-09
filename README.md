# HBCA Meta Ads MCP — Render starter

A read-only MCP server that lets ChatGPT query one Meta Ads account through Meta's Marketing API.

## Safety design

- Read-only tools only. There are no pause, budget, create, update, or delete tools.
- Meta access token is read only from a Render environment variable.
- The token is sent to Meta in the Authorization header, not placed in request URLs.
- The MCP endpoint uses a random secret path. This is suitable for a private prototype; for broader/shared production use, add OAuth 2.1.
- Uses MCP SDK 1.26.0, which includes the February 2026 cross-client isolation security fix.
- Creates a fresh MCP server/transport per request to avoid cross-client state sharing.

## Environment variables

Required:

- `META_ACCESS_TOKEN` — your Meta access token. Paste this into Render only.
- `MCP_PATH_SECRET` — a long random secret. `render.yaml` can generate this automatically.

Configured by default:

- `META_AD_ACCOUNT_ID=act_10151727290614507`
- `META_API_VERSION=v26.0`

## Tools

- `get_ad_accounts`
- `get_campaigns`
- `get_adsets`
- `get_ads`
- `get_insights`

## Deploy on Render

1. Create a new GitHub repository, for example `hbca-meta-ads-mcp`.
2. Upload every file in this folder to the repository root and commit.
3. In Render choose **New → Blueprint** and connect the GitHub repository. Render will read `render.yaml`.
4. When prompted for `META_ACCESS_TOKEN`, paste the token directly into Render. Do not put it in GitHub or ChatGPT.
5. Deploy.
6. Open the Render service → **Environment** and copy the generated value for `MCP_PATH_SECRET`.
7. Your ChatGPT MCP URL will be:

   `https://YOUR-RENDER-SERVICE.onrender.com/mcp/YOUR_MCP_PATH_SECRET`

8. Check health first:

   `https://YOUR-RENDER-SERVICE.onrender.com/health`

   It should return JSON with `"ok": true`.

## Connect to ChatGPT

In ChatGPT, enable Developer mode, add a custom MCP/plugin connection, and paste the full HTTPS MCP URL including the secret path.

Use **No Authentication** for this prototype because the endpoint itself contains a high-entropy secret. Do not share the URL. For a team/shared deployment or any write tools, replace this with OAuth 2.1 before proceeding.

Suggested first test prompt:

> Using HBCA Meta Ads, show my campaigns and analyze campaign-level performance for the last 30 days. Do not make any changes.

## Important Meta token note

The token created in Graph API Explorer can expire. After the connection is proven, replace it with a durable Meta Business/System User token appropriate for your business setup and requested permissions.
