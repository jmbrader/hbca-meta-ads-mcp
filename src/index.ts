import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 10000);

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const DEFAULT_AD_ACCOUNT_ID =
  process.env.META_AD_ACCOUNT_ID || "act_10151727290614507";
const META_API_VERSION = process.env.META_API_VERSION || "v26.0";
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET;

if (!META_ACCESS_TOKEN) {
  throw new Error("META_ACCESS_TOKEN is required");
}

if (!MCP_PATH_SECRET) {
  throw new Error("MCP_PATH_SECRET is required");
}

const GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

type QueryValue = string | number | boolean | undefined;

async function metaGet(
  path: string,
  params: Record<string, QueryValue> = {}
) {
  const url = new URL(
    `${GRAPH_BASE}/${path.replace(/^\//, "")}`
  );

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  // Keep Meta token out of URLs and logs.
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
    },
  });

  const text = await res.text();

  let payload: unknown;

  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `Meta API ${res.status}: ${JSON.stringify(payload)}`
    );
  }

  return payload;
}

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data),
      },
    ],
  };
}

function createServer() {
  const server = new McpServer(
    {
      name: "hbca-meta-ads",
      version: "1.0.0",
    },
    {
      instructions:
        "Read-only access to HBCA Meta Ads data. Never claim a tool changed campaigns, budgets, ads, or account settings. Use get_insights for performance analysis and list tools for hierarchy and IDs.",
    }
  );

  server.registerTool(
    "get_ad_accounts",
    {
      title: "Get Meta ad accounts",
      description:
        "List Meta ad accounts visible to the configured Meta access token.",
      inputSchema: z.object({}) as any,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const data = await metaGet("me/adaccounts", {
        fields:
          "id,name,account_status,currency,timezone_name",
      });

      return textResult(data);
    }
  );

  server.registerTool(
    "get_campaigns",
    {
      title: "Get campaigns",
      description:
        "List campaigns for a Meta ad account with names, statuses, objectives, and dates.",

      inputSchema: z.object({
        ad_account_id: z
          .string()
          .optional()
          .describe(
            "Meta ad account ID, e.g. act_123. Defaults to configured account."
          ),

        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100),
      }) as any,

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const {
        ad_account_id,
        limit = 100,
      } = args;

      const account =
        ad_account_id || DEFAULT_AD_ACCOUNT_ID;

      const data = await metaGet(
        `${account}/campaigns`,
        {
          fields:
            "id,name,status,effective_status,objective,buying_type,start_time,stop_time",
          limit,
        }
      );

      return textResult(data);
    }
  );

  server.registerTool(
    "get_adsets",
    {
      title: "Get ad sets",
      description:
        "List ad sets for a Meta ad account, including campaign IDs, statuses, budgets, optimization goal, and targeting summary.",

      inputSchema: z.object({
        ad_account_id: z
          .string()
          .optional()
          .describe(
            "Meta ad account ID. Defaults to configured account."
          ),

        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100),
      }) as any,

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const {
        ad_account_id,
        limit = 100,
      } = args;

      const account =
        ad_account_id || DEFAULT_AD_ACCOUNT_ID;

      const data = await metaGet(
        `${account}/adsets`,
        {
          fields:
            "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,start_time,end_time,targeting",
          limit,
        }
      );

      return textResult(data);
    }
  );

  server.registerTool(
    "get_ads",
    {
      title: "Get ads",
      description:
        "List ads for a Meta ad account, including campaign and ad set IDs, status, creative ID, and ad name.",

      inputSchema: z.object({
        ad_account_id: z
          .string()
          .optional()
          .describe(
            "Meta ad account ID. Defaults to configured account."
          ),

        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100),
      }) as any,

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const {
        ad_account_id,
        limit = 100,
      } = args;

      const account =
        ad_account_id || DEFAULT_AD_ACCOUNT_ID;

      const data = await metaGet(
        `${account}/ads`,
        {
          fields:
            "id,name,campaign_id,adset_id,status,effective_status,creative{id,name}",
          limit,
        }
      );

      return textResult(data);
    }
  );

  server.registerTool(
    "get_insights",
    {
      title: "Get Meta Ads performance insights",

      description:
        "Retrieve read-only Meta Ads performance metrics by account, campaign, ad set, or ad for a date range or date preset.",

      inputSchema: z.object({
        ad_account_id: z
          .string()
          .optional()
          .describe(
            "Meta ad account ID. Defaults to configured account."
          ),

        level: z
          .enum([
            "account",
            "campaign",
            "adset",
            "ad",
          ])
          .default("campaign"),

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

        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),

        until: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),

        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100),
      }) as any,

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const {
        ad_account_id,
        level = "campaign",
        date_preset,
        since,
        until,
        limit = 100,
      } = args;

      if ((since && !until) || (!since && until)) {
        throw new Error(
          "Provide both since and until, or neither."
        );
      }

      if (
        date_preset &&
        (since || until)
      ) {
        throw new Error(
          "Use date_preset OR since/until, not both."
        );
      }

      const account =
        ad_account_id || DEFAULT_AD_ACCOUNT_ID;

      const params: Record<string, QueryValue> = {
        level,
        limit,
        fields:
          "account_id,account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions,cost_per_action_type,date_start,date_stop",
      };

      if (date_preset) {
        params.date_preset = date_preset;
      } else if (since && until) {
        params.time_range =
          JSON.stringify({
            since,
            until,
          });
      } else {
        params.date_preset = "last_30d";
      }

      const data = await metaGet(
        `${account}/insights`,
        params
      );

      return textResult(data);
    }
  );

  return server;
}

const app = express();

app.use(
  express.json({
    limit: "2mb",
  })
);

app.get(
  "/health",
  (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: "hbca-meta-ads-mcp",
      mode: "read-only",
    });
  }
);

const mcpPath =
  `/mcp/${MCP_PATH_SECRET}`;

app.all(
  mcpPath,
  async (
    req: Request,
    res: Response
  ) => {
    const server = createServer();

    const transport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

    try {
      await server.connect(transport);

      await transport.handleRequest(
        req,
        res,
        req.body
      );
    } catch (err) {
      console.error(
        "MCP request failed:",
        err instanceof Error
          ? err.message
          : err
      );

      if (!res.headersSent) {
        res
          .status(500)
          .json({
            error:
              "MCP request failed",
          });
      }
    } finally {
      try {
        await transport.close();
      } catch {}

      try {
        await server.close();
      } catch {}
    }
  }
);

app.use(
  (_req: Request, res: Response) =>
    res
      .status(404)
      .json({
        error: "Not found",
      })
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `HBCA Meta Ads MCP listening on port ${PORT}`
    );

    console.log(
      "MCP endpoint enabled at a secret path; secret is intentionally not logged."
    );
  }
);
