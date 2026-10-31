import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleMailManager } from "@/services/appleMailManager.js";
import { registerResourcesAndPrompts } from "@/tools/resourcesAndPrompts.js";

describe("Mail resource discovery", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
  });

  async function connect() {
    const accounts = [{ name: "Work & Personal", email: "owner@example.com", enabled: true }];
    const mailboxes = [
      { name: "Inbox", account: "Work & Personal", unreadCount: 0, messageCount: 0 },
    ];
    const listAccounts = vi.fn(() => accounts);
    const listMailboxes = vi.fn(() => mailboxes);
    const listAccountsChecked = vi.fn((): ReturnType<AppleMailManager["listAccountsChecked"]> => ({
      accounts,
      failed: false,
    }));
    const listMailboxesChecked = vi.fn(
      (): ReturnType<AppleMailManager["listMailboxesChecked"]> => ({ mailboxes, failed: false })
    );
    const listTemplates = vi.fn(() => []);
    const manager = {
      listAccounts,
      listMailboxes,
      listAccountsChecked,
      listMailboxesChecked,
      listTemplates,
    } as unknown as AppleMailManager;
    const server = new McpServer({ name: "resource-test", version: "0.0.0" });
    registerResourcesAndPrompts(server, manager);

    const client = new Client({ name: "resource-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      client,
      accounts,
      mailboxes,
      listAccounts,
      listMailboxes,
      listAccountsChecked,
      listMailboxesChecked,
      listTemplates,
    };
  }

  it("lists resources and templates without querying Mail", async () => {
    const {
      client,
      listAccounts,
      listMailboxes,
      listAccountsChecked,
      listMailboxesChecked,
      listTemplates,
    } = await connect();
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();

    expect(resources.map(({ uri }) => uri)).toEqual(["mail://accounts", "mail://templates"]);
    expect(resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: "mail://mailboxes/{account}" }),
    ]);
    expect(listAccounts).not.toHaveBeenCalled();
    expect(listMailboxes).not.toHaveBeenCalled();
    expect(listAccountsChecked).not.toHaveBeenCalled();
    expect(listMailboxesChecked).not.toHaveBeenCalled();
    expect(listTemplates).not.toHaveBeenCalled();
  });

  it("reads accounts and the explicitly requested mailbox resource", async () => {
    const { client, accounts, mailboxes, listAccountsChecked, listMailboxesChecked } =
      await connect();
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
    expect(listAccountsChecked).toHaveBeenCalledOnce();
    expect(listMailboxesChecked).toHaveBeenCalledOnce();
    expect(listMailboxesChecked).toHaveBeenCalledWith("Work & Personal");
  });

  it.each([false, true])(
    "rejects a failed accounts read instead of returning a confirmed list (stale cache: %s)",
    async (staleCache) => {
      const { client, accounts, listAccountsChecked } = await connect();
      listAccountsChecked.mockReturnValueOnce({
        accounts: staleCache ? accounts : [],
        failed: true,
        error: "Automation permission denied",
      });

      await expect(client.readResource({ uri: "mail://accounts" })).rejects.toThrow(
        "Could not read Mail accounts: Automation permission denied"
      );
    }
  );

  it("rejects a failed mailbox read and names the requested account", async () => {
    const { client, listMailboxesChecked } = await connect();
    listMailboxesChecked.mockReturnValueOnce({
      mailboxes: [],
      failed: true,
      error: "Mail.app did not answer",
    });

    await expect(
      client.readResource({ uri: "mail://mailboxes/Work%20%26%20Personal" })
    ).rejects.toThrow('Could not read mailboxes for "Work & Personal": Mail.app did not answer');
  });

  it("preserves successful empty resources", async () => {
    const { client, listAccountsChecked, listMailboxesChecked } = await connect();
    listAccountsChecked.mockReturnValueOnce({ accounts: [], failed: false });
    listMailboxesChecked.mockReturnValueOnce({ mailboxes: [], failed: false });

    for (const uri of ["mail://accounts", "mail://mailboxes/Work%20%26%20Personal"]) {
      const resource = await client.readResource({ uri });
      expect(resource.contents).toEqual([{ uri, mimeType: "application/json", text: "[]" }]);
    }
  });
});
