import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleMailManager } from "@/services/appleMailManager.js";
import { registerResourcesAndPrompts } from "@/tools/resourcesAndPrompts.js";

/** The prompts as registered, by name, with whether each is on offer. */
function promptsOffered(toolAllowed?: (tool: string) => boolean): Record<string, boolean> {
  const server = new McpServer({ name: "test", version: "0" });
  const register = vi.spyOn(server, "registerPrompt");
  registerResourcesAndPrompts(server, {} as AppleMailManager, toolAllowed);
  return Object.fromEntries(
    register.mock.calls.map((call, i) => [call[0], register.mock.results[i].value.enabled])
  );
}

describe("prompts follow the tool gate", () => {
  it("offers every prompt when every tool is allowed", () => {
    expect(promptsOffered()).toEqual({
      "triage-inbox": true,
      "compose-reply": true,
      "weekly-summary": true,
    });
  });

  it("drops the reply prompt when reply-to-message is not available", () => {
    expect(promptsOffered((tool) => tool !== "reply-to-message")).toEqual({
      "triage-inbox": true,
      "compose-reply": false,
      "weekly-summary": true,
    });
  });
});

describe("Mail resource discovery", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
  });

  async function connect() {
    const accounts = [{ name: "Work & Personal", email: "owner@example.com", enabled: true }];
    const mailboxes = [{ name: "Inbox" }];
    const listAccounts = vi.fn(() => accounts);
    const listMailboxes = vi.fn(() => mailboxes);
    const listTemplates = vi.fn(() => []);
    const manager = { listAccounts, listMailboxes, listTemplates } as unknown as AppleMailManager;
    const server = new McpServer({ name: "resource-test", version: "0.0.0" });
    registerResourcesAndPrompts(server, manager);

    const client = new Client({ name: "resource-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, accounts, mailboxes, listAccounts, listMailboxes, listTemplates };
  }

  it("lists resources and templates without querying Mail", async () => {
    const { client, listAccounts, listMailboxes, listTemplates } = await connect();
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();

    expect(resources.map(({ uri }) => uri)).toEqual(["mail://accounts", "mail://templates"]);
    expect(resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: "mail://mailboxes/{account}" }),
    ]);
    expect(listAccounts).not.toHaveBeenCalled();
    expect(listMailboxes).not.toHaveBeenCalled();
    expect(listTemplates).not.toHaveBeenCalled();
  });

  it("reads accounts and the explicitly requested mailbox resource", async () => {
    const { client, accounts, mailboxes, listAccounts, listMailboxes } = await connect();
    const accountResource = await client.readResource({ uri: "mail://accounts" });
    const mailboxUri = "mail://mailboxes/Work%20%26%20Personal";
    const mailboxResource = await client.readResource({ uri: mailboxUri });

    expect(accountResource.contents).toEqual([
      {
        uri: "mail://accounts",
        mimeType: "application/json",
        text: JSON.stringify(accounts, null, 2),
      },
    ]);
    expect(mailboxResource.contents).toEqual([
      { uri: mailboxUri, mimeType: "application/json", text: JSON.stringify(mailboxes, null, 2) },
    ]);
    expect(listAccounts).toHaveBeenCalledOnce();
    expect(listMailboxes).toHaveBeenCalledOnce();
    expect(listMailboxes).toHaveBeenCalledWith("Work & Personal");
  });
});
