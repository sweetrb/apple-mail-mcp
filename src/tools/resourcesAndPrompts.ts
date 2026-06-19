/**
 * MCP resources & prompts (D2).
 *
 * Resources expose read-only mail context the client can attach without a tool
 * round-trip (accounts, templates, per-account mailboxes). Prompts package
 * common multi-step workflows (triage, reply, weekly summary) so users can
 * invoke them by name. Both are additive and complement the existing tools.
 *
 * @module tools/resourcesAndPrompts
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleMailManager } from "@/services/appleMailManager.js";

function jsonResource(uri: string, data: unknown) {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
  };
}

export function registerResourcesAndPrompts(
  server: McpServer,
  mailManager: AppleMailManager
): void {
  // --- Resources ---

  server.registerResource(
    "accounts",
    "mail://accounts",
    {
      title: "Mail accounts",
      description: "All configured Mail accounts (name, email, enabled state).",
      mimeType: "application/json",
    },
    (uri) => jsonResource(uri.href, mailManager.listAccounts())
  );

  server.registerResource(
    "templates",
    "mail://templates",
    {
      title: "Email templates",
      description: "Saved, reusable email templates.",
      mimeType: "application/json",
    },
    (uri) => jsonResource(uri.href, mailManager.listTemplates())
  );

  server.registerResource(
    "mailboxes",
    new ResourceTemplate("mail://mailboxes/{account}", {
      list: () => ({
        resources: mailManager.listAccounts().map((a) => ({
          name: `Mailboxes — ${a.name}`,
          uri: `mail://mailboxes/${encodeURIComponent(a.name)}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Mailboxes by account",
      description: "Mailboxes/folders for a given account.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const account = decodeURIComponent(String(variables.account));
      return jsonResource(uri.href, mailManager.listMailboxes(account));
    }
  );

  // --- Prompts ---

  server.registerPrompt(
    "triage-inbox",
    {
      title: "Triage inbox",
      description: "Review unread mail and propose actions (archive, reply, flag, delete).",
      argsSchema: {
        account: z.string().optional().describe("Account to triage (default: all)"),
        limit: z.string().optional().describe("How many unread to review (default 20)"),
      },
    },
    ({ account, limit }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Triage my unread email${account ? ` in the "${account}" account` : ""}. ` +
              `Use list-messages with unreadOnly=true${account ? ` and account="${account}"` : ""}` +
              ` and limit=${limit || "20"}. For each message, give a one-line summary and a ` +
              `recommended action (reply / archive / flag / delete / ignore). Group by priority ` +
              `and call out anything time-sensitive. Do not take any action without my confirmation.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "compose-reply",
    {
      title: "Compose reply",
      description: "Draft a reply to a specific message in a chosen tone.",
      argsSchema: {
        messageId: z.string().describe("ID of the message to reply to"),
        tone: z.string().optional().describe("Tone, e.g. friendly, formal, brief"),
        intent: z.string().optional().describe("What the reply should accomplish"),
      },
    },
    ({ messageId, tone, intent }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Read message ${messageId} with get-message, then draft a ${tone || "professional"} reply` +
              `${intent ? ` that ${intent}` : ""}. Show me the draft first; only send after I approve, ` +
              `using reply-to-message.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "weekly-summary",
    {
      title: "Weekly mail summary",
      description: "Summarize the week's mail activity into a short briefing.",
      argsSchema: {
        account: z.string().optional().describe("Account to summarize (default: all)"),
      },
    },
    ({ account }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Summarize my mail activity over the last 7 days${account ? ` for "${account}"` : ""}. ` +
              `Use get-mail-stats and list-messages (with a 7-day window) to identify the busiest ` +
              `threads, who I owe replies to, and any unresolved items. Produce a concise briefing.`,
          },
        },
      ],
    })
  );
}
