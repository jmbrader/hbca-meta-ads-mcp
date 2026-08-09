import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 10000);

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

const DEFAULT_AD_ACCOUNT_ID =
  process.env.META_AD_ACCOUNT_ID || "act_10151727290614507";

const META_API_VERSION =
  process.env.META_API_VERSION || "v26.0";

const MCP_PATH_SECRET =
  process.env.MCP_PATH_SECRET;

// Maximum allowed budget increase per individual MCP call.
const MAX_BUDGET_INCREASE_PERCENT = 25;

// Additional absolute safety ceiling for a daily budget.
// Change this later if you intentionally want a higher ceiling.
const MAX_DAILY_BUDGET_USD = 5000;

if (!META_ACCESS_TOKEN) {
  throw new Error("META_ACCESS_TOKEN is required");
}

if (!MCP_PATH_SECRET) {
  throw new Error("MCP_PATH_SECRET is required");
}

const GRAPH_BASE =
  `https://graph.facebook.com/${META_API_VERSION}`;

type QueryValue =
  | string
  | number
  | boolean
  | undefined;

function normalizeAccountId(id: string): string {
  return id.replace(/^act_/, "");
}

const CONFIGURED_ACCOUNT_NUMERIC =
  normalizeAccountId(DEFAULT_AD_ACCOUNT_ID);

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

async function metaPost(
  path: string,
  params: Record<string, QueryValue> = {}
) {
  const url = new URL(
    `${GRAPH_BASE}/${path.replace(/^\//, "")}`
  );

  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      body.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      "Content-Type":
        "application/x-www-form-urlencoded",
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

/*
 * GUARDRAIL:
 * Before modifying any campaign, ad set, or ad,
 * confirm Meta reports that it belongs to the configured account.
 */
async function assertEntityBelongsToConfiguredAccount(
  entityId: string,
  entityType: "campaign" | "adset" | "ad"
) {
  const data = (await metaGet(entityId, {
    fields: "id,account_id,name,status",
  })) as any;

  if (!data?.id) {
    throw new Error(
      `Unable to verify ${entityType} ${entityId}.`
    );
  }

  const returnedAccountId =
    normalizeAccountId(String(data.account_id || ""));

  if (
    returnedAccountId !==
    CONFIGURED_ACCOUNT_NUMERIC
  ) {
    throw new Error(
      `Write blocked: ${entityType} ${entityId} does not belong to the configured Meta ad account.`
    );
  }

  return data;
}

function createServer() {
  const server = new McpServer(
    {
      name: "hbca-meta-ads",
      version: "2.0.0",
    },
    {
      instructions:
        "Read and controlled-write access to the configured HBCA Meta Ads account. Never claim a change succeeded unless the relevant write tool returned a successful Meta response. Writes are restricted to entities belonging to the configured ad account. Budget increases are limited by server-side safety rules.",
    }
  );

  /*
   * -------------------------
   * READ TOOLS
   * -------------------------
   */

  server.registerTool(
    "get_ad_accounts",
    {
      title: "Get Meta ad accounts",

      description:
        "List Meta ad accounts visible to the configured Meta access token.",

      inputSchema:
        z.object({}) as any,

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },

    async () => {
      const data =
        await metaGet(
          "me/adaccounts",
          {
            fields:
              "id,name,account_status,currency,timezone_name",
          }
        );

      return textResult(data);
    }
  );

  server.registerTool(
    "get_campaigns",
    {
      title: "Get campaigns",

      description:
        "List campaigns for the configured Meta ad account.",

      inputSchema:
        z.object({
          ad_account_id:
            z.string().optional(),

          limit:
            z.number()
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
        ad_account_id ||
        DEFAULT_AD_ACCOUNT_ID;

      const data =
        await metaGet(
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
        "List ad sets for the configured Meta ad account.",

      inputSchema:
        z.object({
          ad_account_id:
            z.string().optional(),

          limit:
            z.number()
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
        ad_account_id ||
        DEFAULT_AD_ACCOUNT_ID;

      const data =
        await metaGet(
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
        "List ads for the configured Meta ad account.",

      inputSchema:
        z.object({
          ad_account_id:
            z.string().optional(),

          limit:
            z.number()
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
        ad_account_id ||
        DEFAULT_AD_ACCOUNT_ID;

      const data =
        await metaGet(
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
      title:
        "Get Meta Ads performance insights",

      description:
        "Retrieve Meta Ads performance metrics by account, campaign, ad set, or ad.",

      inputSchema:
        z.object({
          ad_account_id:
            z.string().optional(),

          level:
            z.enum([
              "account",
              "campaign",
              "adset",
              "ad",
            ])
            .default("campaign"),

          date_preset:
            z.enum([
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

          since:
            z.string()
              .regex(
                /^\d{4}-\d{2}-\d{2}$/
              )
              .optional(),

          until:
            z.string()
              .regex(
                /^\d{4}-\d{2}-\d{2}$/
              )
              .optional(),

          limit:
            z.number()
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

      if (
        (since && !until) ||
        (!since && until)
      ) {
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
        ad_account_id ||
        DEFAULT_AD_ACCOUNT_ID;

      const params:
        Record<string, QueryValue> = {
          level,
          limit,

          fields:
            "account_id,account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions,cost_per_action_type,date_start,date_stop",
        };

      if (date_preset) {
        params.date_preset =
          date_preset;
      } else if (
        since &&
        until
      ) {
        params.time_range =
          JSON.stringify({
            since,
            until,
          });
      } else {
        params.date_preset =
          "last_30d";
      }

      const data =
        await metaGet(
          `${account}/insights`,
          params
        );

      return textResult(data);
    }
  );

  /*
   * -------------------------
   * CAMPAIGN WRITE TOOLS
   * -------------------------
   */

  server.registerTool(
    "pause_campaign",
    {
      title: "Pause Meta campaign",

      description:
        "Pause one campaign. The server verifies that it belongs to the configured ad account before making the change.",

      inputSchema:
        z.object({
          campaign_id:
            z.string().min(1),
        }) as any,

      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const { campaign_id } =
        args;

      const before =
        await assertEntityBelongsToConfiguredAccount(
          campaign_id,
          "campaign"
        );

      const result =
        await metaPost(
          campaign_id,
          {
            status: "PAUSED",
          }
        );

      return textResult({
        action:
          "pause_campaign",
        campaign_id,
        previous_status:
          before.status,
        meta_response:
          result,
      });
    }
  );

  server.registerTool(
    "resume_campaign",
    {
      title: "Resume Meta campaign",

      description:
        "Activate one campaign after verifying it belongs to the configured ad account.",

      inputSchema:
        z.object({
          campaign_id:
            z.string().min(1),
        }) as any,

      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const { campaign_id } =
        args;

      const before =
        await assertEntityBelongsToConfiguredAccount(
          campaign_id,
          "campaign"
        );

      const result =
        await metaPost(
          campaign_id,
          {
            status: "ACTIVE",
          }
        );

      return textResult({
        action:
          "resume_campaign",
        campaign_id,
        previous_status:
          before.status,
        meta_response:
          result,
      });
    }
  );

  /*
   * -------------------------
   * AD SET WRITE TOOLS
   * -------------------------
   */

  server.registerTool(
    "pause_adset",
    {
      title: "Pause Meta ad set",

      description:
        "Pause one ad set after verifying it belongs to the configured ad account.",

      inputSchema:
        z.object({
          adset_id:
            z.string().min(1),
        }) as any,

      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const { adset_id } =
        args;

      const before =
        await assertEntityBelongsToConfiguredAccount(
          adset_id,
          "adset"
        );

      const result =
        await metaPost(
          adset_id,
          {
            status: "PAUSED",
          }
        );

      return textResult({
        action:
          "pause_adset",
        adset_id,
        previous_status:
          before.status,
        meta_response:
          result,
      });
    }
  );

  server.registerTool(
    "resume_adset",
    {
      title: "Resume Meta ad set",

      description:
        "Activate one ad set after verifying it belongs to the configured ad account.",

      inputSchema:
        z.object({
          adset_id:
            z.string().min(1),
        }) as any,

      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const { adset_id } =
        args;

      const before =
        await assertEntityBelongsToConfiguredAccount(
          adset_id,
          "adset"
        );

      const result =
        await metaPost(
          adset_id,
          {
            status: "ACTIVE",
          }
        );

      return textResult({
        action:
          "resume_adset",
        adset_id,
        previous_status:
          before.status,
        meta_response:
          result,
      });
    }
  );

  /*
   * -------------------------
   * AD WRITE TOOLS
   * -------------------------
   */

  server.registerTool(
    "pause_ad",
    {
      title: "Pause Meta ad",

      description:
        "Pause one ad after verifying it belongs to the configured ad account.",

      inputSchema:
        z.object({
          ad_id:
            z.string().min(1),
        }) as any,

      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const { ad_id } =
        args;

      const before =
        await assertEntityBelongsToConfiguredAccount(
          ad_id,
          "ad"
        );

      const result =
        await metaPost(
          ad_id,
          {
            status: "PAUSED",
          }
        );

      return textResult({
        action:
          "pause_ad",
        ad_id,
        previous_status:
          before.status,
        meta_response:
          result,
      });
    }
  );

  server.registerTool(
    "resume_ad",
    {
      title: "Resume Meta ad",

      description:
        "Activate one ad after verifying it belongs to the configured ad account.",

      inputSchema:
        z.object({
          ad_id:
            z.string().min(1),
        }) as any,

      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const { ad_id } =
        args;

      const before =
        await assertEntityBelongsToConfiguredAccount(
          ad_id,
          "ad"
        );

      const result =
        await metaPost(
          ad_id,
          {
            status: "ACTIVE",
          }
        );

      return textResult({
        action:
          "resume_ad",
        ad_id,
        previous_status:
          before.status,
        meta_response:
          result,
      });
    }
  );

  /*
   * -------------------------
   * BUDGET WRITE TOOL
   * -------------------------
   */

  server.registerTool(
    "update_adset_budget",
    {
      title:
        "Update Meta ad set daily budget",

      description:
        "Change an ad set's daily budget in USD. Server guardrails verify account ownership, enforce a maximum 25% increase per operation, and impose an absolute daily-budget ceiling.",

      inputSchema:
        z.object({
          adset_id:
            z.string().min(1),

          new_daily_budget_usd:
            z.number()
              .positive()
              .max(
                MAX_DAILY_BUDGET_USD
              ),
        }) as any,

      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },

    async (args: any) => {
      const {
        adset_id,
        new_daily_budget_usd,
      } = args;

      await assertEntityBelongsToConfiguredAccount(
        adset_id,
        "adset"
      );

      const adset =
        (await metaGet(
          adset_id,
          {
            fields:
              "id,name,account_id,daily_budget,lifetime_budget,status",
          }
        )) as any;

      if (!adset.daily_budget) {
        throw new Error(
          "Budget update blocked: this ad set does not have an ad-set-level daily_budget. It may be using campaign-level budgeting or lifetime budgeting."
        );
      }

      /*
       * Meta daily_budget is returned in the
       * currency's smallest unit.
       * HBCA Arkansas is USD, so 100 = $1.00.
       */
      const currentBudgetCents =
        Number(
          adset.daily_budget
        );

      if (
        !Number.isFinite(
          currentBudgetCents
        ) ||
        currentBudgetCents <= 0
      ) {
        throw new Error(
          "Unable to determine the current daily budget."
        );
      }

      const newBudgetCents =
        Math.round(
          Number(
            new_daily_budget_usd
          ) * 100
        );

      if (newBudgetCents <= 0) {
        throw new Error(
          "New daily budget must be greater than zero."
        );
      }

      const currentBudgetUsd =
        currentBudgetCents / 100;

      const increasePercent =
        ((newBudgetCents -
          currentBudgetCents) /
          currentBudgetCents) *
        100;

      if (
        increasePercent >
        MAX_BUDGET_INCREASE_PERCENT
      ) {
        throw new Error(
          `Budget update blocked: increasing from $${currentBudgetUsd.toFixed(
            2
          )} to $${Number(
            new_daily_budget_usd
          ).toFixed(
            2
          )} is a ${increasePercent.toFixed(
            1
          )}% increase. The server allows a maximum increase of ${MAX_BUDGET_INCREASE_PERCENT}% per operation.`
        );
      }

      if (
        new_daily_budget_usd >
        MAX_DAILY_BUDGET_USD
      ) {
        throw new Error(
          `Budget update blocked: maximum allowed daily budget is $${MAX_DAILY_BUDGET_USD}.`
        );
      }

      const result =
        await metaPost(
          adset_id,
          {
            daily_budget:
              newBudgetCents,
          }
        );

      return textResult({
        action:
          "update_adset_budget",

        adset_id,

        adset_name:
          adset.name,

        previous_daily_budget_usd:
          currentBudgetUsd,

        new_daily_budget_usd,

        percentage_change:
          Number(
            increasePercent.toFixed(
              2
            )
          ),

        meta_response:
          result,
      });
    }
  );

  return server;
}

/*
 * -------------------------
 * EXPRESS / MCP TRANSPORT
 * -------------------------
 */

const app = express();

app.use(
  express.json({
    limit: "2mb",
  })
);

app.get(
  "/health",
  (
    _req: Request,
    res: Response
  ) => {
    res.json({
      ok: true,
      service:
        "hbca-meta-ads-mcp",
      mode:
        "controlled-read-write",

      guardrails: {
        configured_account:
          DEFAULT_AD_ACCOUNT_ID,

        max_budget_increase_percent:
          MAX_BUDGET_INCREASE_PERCENT,

        max_daily_budget_usd:
          MAX_DAILY_BUDGET_USD,
      },
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
    const server =
      createServer();

    const transport =
      new StreamableHTTPServerTransport(
        {
          sessionIdGenerator:
            undefined,

          enableJsonResponse:
            true,
        }
      );

    try {
      await server.connect(
        transport
      );

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

      if (
        !res.headersSent
      ) {
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
  (
    _req: Request,
    res: Response
  ) =>
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

    console.log(
      `Write guardrails: account=${DEFAULT_AD_ACCOUNT_ID}, max budget increase=${MAX_BUDGET_INCREASE_PERCENT}%, max daily budget=$${MAX_DAILY_BUDGET_USD}.`
    );
  }
);
