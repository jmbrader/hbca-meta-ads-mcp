import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 10000);
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const DEFAULT_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || "act_10151727290614507";
const META_API_VERSION = process.env.META_API_VERSION || "v26.0";
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET;

const MAX_BUDGET_INCREASE_PERCENT = 25;
const MAX_DAILY_BUDGET_USD = 5000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ALLOWED_DESTINATION_HOSTS = (process.env.ALLOWED_DESTINATION_HOSTS || "")
  .split(",")
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

if (!META_ACCESS_TOKEN) throw new Error("META_ACCESS_TOKEN is required");
if (!MCP_PATH_SECRET) throw new Error("MCP_PATH_SECRET is required");

const GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`;
type QueryValue = string | number | boolean | undefined;

function normalizeAccountId(id: string) {
  return id.replace(/^act_/, "");
}

const CONFIGURED_ACCOUNT_NUMERIC = normalizeAccountId(DEFAULT_AD_ACCOUNT_ID);

function validateDestinationUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Destination URL is invalid.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Destination URL must use HTTPS.");
  }

  if (
    ALLOWED_DESTINATION_HOSTS.length > 0 &&
    !ALLOWED_DESTINATION_HOSTS.includes(url.hostname.toLowerCase())
  ) {
    throw new Error(
      `Destination host ${url.hostname} is not in ALLOWED_DESTINATION_HOSTS.`
    );
  }

  return url.toString();
}

async function metaGet(
  path: string,
  params: Record<string, QueryValue> = {}
) {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, "")}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` },
  });

  const text = await res.text();
  let payload: unknown;

  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Meta API ${res.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function metaPost(
  path: string,
  params: Record<string, QueryValue> = {}
) {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, "")}`);
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, String(value));
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  let payload: unknown;

  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Meta API ${res.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

async function assertEntityBelongsToConfiguredAccount(
  entityId: string,
  entityType: "campaign" | "adset" | "ad" | "creative"
) {
  const data = (await metaGet(entityId, {
    fields: "id,account_id,name,status",
  })) as any;

  if (!data?.id) {
    throw new Error(`Unable to verify ${entityType} ${entityId}.`);
  }

  const returnedAccountId = normalizeAccountId(String(data.account_id || ""));

  if (returnedAccountId !== CONFIGURED_ACCOUNT_NUMERIC) {
    throw new Error(
      `Write blocked: ${entityType} ${entityId} does not belong to the configured Meta ad account.`
    );
  }

  return data;
}

function createServer() {
  const server = new McpServer(
    { name: "hbca-meta-ads", version: "3.0.0" },
    {
      instructions:
        "Read and controlled-write access to the configured HBCA Meta Ads account. Never claim a change succeeded unless Meta returned success. New ads must be created PAUSED. Creative replacement is allowed only on paused ads. Writes are restricted to the configured ad account.",
    }
  );

  server.registerTool(
    "get_ad_accounts",
    {
      title: "Get Meta ad accounts",
      description: "List Meta ad accounts visible to the configured token.",
      inputSchema: z.object({}) as any,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () =>
      textResult(
        await metaGet("me/adaccounts", {
          fields: "id,name,account_status,currency,timezone_name",
        })
      )
  );

  server.registerTool(
    "get_campaigns",
    {
      title: "Get campaigns",
      description: "List campaigns for the configured Meta ad account.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(100),
      }) as any,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args: any) =>
      textResult(
        await metaGet(`${DEFAULT_AD_ACCOUNT_ID}/campaigns`, {
          fields:
            "id,name,status,effective_status,objective,buying_type,start_time,stop_time",
          limit: args.limit ?? 100,
        })
      )
  );

  server.registerTool(
    "get_adsets",
    {
      title: "Get ad sets",
      description: "List ad sets for the configured Meta ad account.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(100),
      }) as any,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args: any) =>
      textResult(
        await metaGet(`${DEFAULT_AD_ACCOUNT_ID}/adsets`, {
          fields:
            "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,start_time,end_time,targeting",
          limit: args.limit ?? 100,
        })
      )
  );

  server.registerTool(
    "get_ads",
    {
      title: "Get ads",
      description: "List ads for the configured Meta ad account.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(100),
      }) as any,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args: any) =>
      textResult(
        await metaGet(`${DEFAULT_AD_ACCOUNT_ID}/ads`, {
          fields:
            "id,name,campaign_id,adset_id,status,effective_status,creative{id,name}",
          limit: args.limit ?? 100,
        })
      )
  );

  server.registerTool(
    "get_insights",
    {
      title: "Get Meta Ads performance insights",
      description:
        "Retrieve performance metrics by account, campaign, ad set, or ad.",
      inputSchema: z.object({
        level: z.enum(["account", "campaign", "adset", "ad"]).default("campaign"),
        date_preset: z
          .enum([
            "today",
            "yesterday",
            "last_7d",
            "last_14d",
            "last_30d",
            "this_month",
            "last_month",
            "maximum",
          ])
          .optional(),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }) as any,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args: any) => {
      const {
        level = "campaign",
        date_preset,
        since,
        until,
        limit = 100,
      } = args;

      if ((since && !until) || (!since && until)) {
        throw new Error("Provide both since and until, or neither.");
      }

      if (date_preset && (since || until)) {
        throw new Error("Use date_preset OR since/until, not both.");
      }

      const params: Record<string, QueryValue> = {
        level,
        limit,
        fields:
          "account_id,account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions,cost_per_action_type,date_start,date_stop",
      };

      if (date_preset) params.date_preset = date_preset;
      else if (since && until) {
        params.time_range = JSON.stringify({ since, until });
      } else {
        params.date_preset = "last_30d";
      }

      return textResult(
        await metaGet(`${DEFAULT_AD_ACCOUNT_ID}/insights`, params)
      );
    }
  );

  const statusTool = (
    name: string,
    title: string,
    entityType: "campaign" | "adset" | "ad",
    idField: string,
    status: "PAUSED" | "ACTIVE"
  ) => {
    server.registerTool(
      name,
      {
        title,
        description: `${title} after verifying account ownership.`,
        inputSchema: z.object({ [idField]: z.string().min(1) }) as any,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      async (args: any) => {
        const entityId = args[idField];
        const before = await assertEntityBelongsToConfiguredAccount(
          entityId,
          entityType
        );
        const result = await metaPost(entityId, { status });
        return textResult({
          action: name,
          id: entityId,
          previous_status: before.status,
          meta_response: result,
        });
      }
    );
  };

  statusTool(
    "pause_campaign",
    "Pause Meta campaign",
    "campaign",
    "campaign_id",
    "PAUSED"
  );
  statusTool(
    "resume_campaign",
    "Resume Meta campaign",
    "campaign",
    "campaign_id",
    "ACTIVE"
  );
  statusTool("pause_adset", "Pause Meta ad set", "adset", "adset_id", "PAUSED");
  statusTool("resume_adset", "Resume Meta ad set", "adset", "adset_id", "ACTIVE");
  statusTool("pause_ad", "Pause Meta ad", "ad", "ad_id", "PAUSED");
  statusTool("resume_ad", "Resume Meta ad", "ad", "ad_id", "ACTIVE");

  server.registerTool(
    "update_adset_budget",
    {
      title: "Update Meta ad set daily budget",
      description:
        "Change an ad set daily budget in USD with ownership, 25% increase, and absolute ceiling guardrails.",
      inputSchema: z.object({
        adset_id: z.string().min(1),
        new_daily_budget_usd: z.number().positive().max(MAX_DAILY_BUDGET_USD),
      }) as any,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args: any) => {
      const { adset_id, new_daily_budget_usd } = args;

      await assertEntityBelongsToConfiguredAccount(adset_id, "adset");

      const adset = (await metaGet(adset_id, {
        fields: "id,name,account_id,daily_budget,lifetime_budget,status",
      })) as any;

      if (!adset.daily_budget) {
        throw new Error(
          "Budget update blocked: this ad set does not have an ad-set-level daily_budget."
        );
      }

      const currentBudgetCents = Number(adset.daily_budget);
      const newBudgetCents = Math.round(Number(new_daily_budget_usd) * 100);

      if (!Number.isFinite(currentBudgetCents) || currentBudgetCents <= 0) {
        throw new Error("Unable to determine the current daily budget.");
      }

      const currentBudgetUsd = currentBudgetCents / 100;
      const increasePercent =
        ((newBudgetCents - currentBudgetCents) / currentBudgetCents) * 100;

      if (increasePercent > MAX_BUDGET_INCREASE_PERCENT) {
        throw new Error(
          `Budget update blocked: increase is ${increasePercent.toFixed(
            1
          )}%. Maximum is ${MAX_BUDGET_INCREASE_PERCENT}% per operation.`
        );
      }

      const result = await metaPost(adset_id, {
        daily_budget: newBudgetCents,
      });

      return textResult({
        action: "update_adset_budget",
        adset_id,
        previous_daily_budget_usd: currentBudgetUsd,
        new_daily_budget_usd,
        meta_response: result,
      });
    }
  );

  server.registerTool(
    "upload_ad_image_base64",
    {
      title: "Upload image to Meta ad account",
      description:
        "Upload a base64-encoded image to the configured Meta ad account and return Meta's image hash.",
      inputSchema: z.object({
        file_name: z.string().min(1).max(120),
        image_base64: z.string().min(100),
      }) as any,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args: any) => {
      const { file_name, image_base64 } = args;

      const decoded = Buffer.from(image_base64, "base64");

      if (decoded.length <= 0 || decoded.length > MAX_IMAGE_BYTES) {
        throw new Error(
          `Image upload blocked: decoded image exceeds the ${MAX_IMAGE_BYTES}-byte limit.`
        );
      }

      const result = await metaPost(`${DEFAULT_AD_ACCOUNT_ID}/adimages`, {
        name: file_name,
        bytes: image_base64,
      });

      return textResult({
        action: "upload_ad_image_base64",
        file_name,
        decoded_bytes: decoded.length,
        meta_response: result,
      });
    }
  );

  server.registerTool(
    "create_link_ad_creative",
    {
      title: "Create Meta link ad creative",
      description:
        "Create a link-ad creative from a Page ID, Meta image hash, destination URL, primary text, headline, description, and CTA. This creates a creative only; it does not publish an ad.",
      inputSchema: z.object({
        creative_name: z.string().min(1).max(200),
        page_id: z.string().min(1),
        image_hash: z.string().min(1),
        link_url: z.string().min(1),
        primary_text: z.string().min(1).max(5000),
        headline: z.string().min(1).max(255),
        description: z.string().max(1000).optional(),
        call_to_action_type: z
          .enum([
            "LEARN_MORE",
            "SIGN_UP",
            "CONTACT_US",
            "APPLY_NOW",
            "GET_QUOTE",
            "SHOP_NOW",
            "DOWNLOAD",
            "NO_BUTTON",
          ])
          .default("LEARN_MORE"),
      }) as any,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args: any) => {
      const {
        creative_name,
        page_id,
        image_hash,
        link_url,
        primary_text,
        headline,
        description,
        call_to_action_type = "LEARN_MORE",
      } = args;

      const destination = validateDestinationUrl(link_url);

      const linkData: any = {
        image_hash,
        link: destination,
        message: primary_text,
        name: headline,
      };

      if (description) linkData.description = description;

      if (call_to_action_type !== "NO_BUTTON") {
        linkData.call_to_action = {
          type: call_to_action_type,
          value: { link: destination },
        };
      }

      const result = await metaPost(
        `${DEFAULT_AD_ACCOUNT_ID}/adcreatives`,
        {
          name: creative_name,
          object_story_spec: JSON.stringify({
            page_id,
            link_data: linkData,
          }),
        }
      );

      return textResult({
        action: "create_link_ad_creative",
        creative_name,
        destination,
        meta_response: result,
      });
    }
  );

  server.registerTool(
    "create_ad_paused",
    {
      title: "Create Meta ad in PAUSED state",
      description:
        "Create a new ad using an existing ad set and creative. Ownership is verified and the ad is always created PAUSED.",
      inputSchema: z.object({
        ad_name: z.string().min(1).max(255),
        adset_id: z.string().min(1),
        creative_id: z.string().min(1),
      }) as any,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args: any) => {
      const { ad_name, adset_id, creative_id } = args;

      await assertEntityBelongsToConfiguredAccount(adset_id, "adset");
      await assertEntityBelongsToConfiguredAccount(creative_id, "creative");

      const result = await metaPost(`${DEFAULT_AD_ACCOUNT_ID}/ads`, {
        name: ad_name,
        adset_id,
        creative: JSON.stringify({ creative_id }),
        status: "PAUSED",
      });

      return textResult({
        action: "create_ad_paused",
        ad_name,
        adset_id,
        creative_id,
        status: "PAUSED",
        meta_response: result,
      });
    }
  );

  server.registerTool(
    "replace_paused_ad_creative",
    {
      title: "Replace creative on a paused Meta ad",
      description:
        "Replace the creative attached to an existing ad. The target ad must already be PAUSED and all objects must belong to the configured account.",
      inputSchema: z.object({
        ad_id: z.string().min(1),
        new_creative_id: z.string().min(1),
      }) as any,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args: any) => {
      const { ad_id, new_creative_id } = args;

      const ad = await assertEntityBelongsToConfiguredAccount(ad_id, "ad");

      if (String(ad.status || "").toUpperCase() !== "PAUSED") {
        throw new Error(
          "Creative replacement blocked: the target ad must already be PAUSED."
        );
      }

      await assertEntityBelongsToConfiguredAccount(
        new_creative_id,
        "creative"
      );

      const result = await metaPost(ad_id, {
        creative: JSON.stringify({ creative_id: new_creative_id }),
      });

      return textResult({
        action: "replace_paused_ad_creative",
        ad_id,
        new_creative_id,
        meta_response: result,
      });
    }
  );

  return server;
}

const app = express();

app.use(
  express.json({
    limit: "12mb",
  })
);

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "hbca-meta-ads-mcp",
    mode: "controlled-read-write-creative",
    version: "3.0.0",
    guardrails: {
      configured_account: DEFAULT_AD_ACCOUNT_ID,
      max_budget_increase_percent: MAX_BUDGET_INCREASE_PERCENT,
      max_daily_budget_usd: MAX_DAILY_BUDGET_USD,
      new_ads_created_paused: true,
      creative_replacement_requires_paused_ad: true,
      max_image_bytes: MAX_IMAGE_BYTES,
      destination_host_allowlist_enabled:
        ALLOWED_DESTINATION_HOSTS.length > 0,
    },
  });
});

const mcpPath = `/mcp/${MCP_PATH_SECRET}`;

app.all(mcpPath, async (req: Request, res: Response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(
      "MCP request failed:",
      err instanceof Error ? err.message : err
    );

    if (!res.headersSent) {
      res.status(500).json({ error: "MCP request failed" });
    }
  } finally {
    try {
      await transport.close();
    } catch {}

    try {
      await server.close();
    } catch {}
  }
});

app.use((_req: Request, res: Response) =>
  res.status(404).json({ error: "Not found" })
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HBCA Meta Ads MCP listening on port ${PORT}`);
  console.log(
    "MCP endpoint enabled at a secret path; secret is intentionally not logged."
  );
});
