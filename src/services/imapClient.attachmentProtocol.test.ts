import { describe, expect, it } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import { ImapFlow } from "imapflow";
import {
  encodeImapId,
  imapFetchAttachment,
  type ImapClientLike,
  type ImapConfig,
} from "@/services/imapClient.js";

async function fixtureServer(raw: Buffer, sizeDelta = 0) {
  const encoded = Buffer.from(raw.toString("base64"));
  const mime = Buffer.from(
    "Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=fixture.bin\r\n\r\n"
  );
  const commands: string[] = [];
  const server = createServer((socket) => {
    socket.write("* OK fixture ready\r\n");
    let pending = "";
    socket.on("data", (data) => {
      pending += data.toString();
      let index: number;
      while ((index = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        commands.push(line);
        const [tag, command = ""] = line.split(" ");
        const op = command.toUpperCase();
        if (op === "CAPABILITY") socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n`);
        else if (op === "LOGIN") socket.write(`${tag} OK\r\n`);
        else if (op === "LIST") socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK\r\n`);
        else if (op === "SELECT" || op === "EXAMINE")
          socket.write(
            `* 1 EXISTS\r\n* OK [UIDVALIDITY 7] v\r\n* OK [UIDNEXT 10] n\r\n${tag} OK [READ-WRITE] done\r\n`
          );
        else if (op === "UID" && / FETCH /i.test(line) && /BODYSTRUCTURE/i.test(line)) {
          socket.write(
            `* 1 FETCH (UID 9 BODYSTRUCTURE (("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1 NIL NIL NIL NIL)("APPLICATION" "OCTET-STREAM" ("NAME" "fixture.bin") NIL NIL "BASE64" ${encoded.length + sizeDelta} NIL ("ATTACHMENT" ("FILENAME" "fixture.bin")) NIL NIL) "MIXED" ("BOUNDARY" "x") NIL NIL NIL))\r\n${tag} OK\r\n`
          );
        } else if (op === "UID" && / FETCH /i.test(line)) {
          const match = /BODY\.PEEK\[2\]<([0-9]+)\.([0-9]+)>/i.exec(line);
          if (!match) throw new Error(`Unexpected fixture FETCH: ${line}`);
          const start = Number(match[1]);
          const part = encoded.subarray(start, start + Number(match[2]));
          const header = /BODY\.PEEK\[2\.MIME\]/i.test(line)
            ? ` RFC822.SIZE ${encoded.length + mime.length} BODY[2.MIME] {${mime.length}}\r\n${mime.toString()}`
            : "";
          socket.write(`* 1 FETCH (UID 9${header} BODY[2]<${start}> {${part.length}}\r\n`);
          socket.write(part);
          socket.write(`)\r\n${tag} OK\r\n`);
        } else if (op === "LOGOUT") {
          socket.write(`* BYE\r\n${tag} OK\r\n`);
          socket.end();
        } else socket.write(`${tag} OK\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, commands, close: () => server.close() };
}

describe("inline attachment end probe over IMAP", () => {
  it.each([
    { raw: Buffer.from("test"), delta: 0 },
    { raw: Buffer.alloc(0), delta: 0 },
    { raw: Buffer.from("test"), delta: -1 },
    { raw: Buffer.from("test"), delta: 1 },
  ])("checks a $raw.length-byte part with size delta $delta", async ({ raw, delta }) => {
    const server = await fixtureServer(raw, delta);
    const config: ImapConfig = {
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      allowPlaintext: true,
      user: "fixture",
      pass: "fixture",
      accountLabel: "fixture",
    };
    try {
      const result = await imapFetchAttachment(
        encodeImapId("fixture", "INBOX", 9),
        "fixture.bin",
        {
          config,
          connect: async () => {
            const client = new ImapFlow({
              host: config.host,
              port: config.port,
              secure: false,
              doSTARTTLS: false,
              logger: false,
              auth: { user: config.user, pass: config.pass },
            });
            await client.connect();
            return client as unknown as ImapClientLike;
          },
        },
        "inline"
      );
      if (delta === 0) {
        expect(result).toMatchObject({
          success: true,
          bytes: raw.length,
          base64: raw.toString("base64"),
        });
      } else {
        expect(result).toMatchObject({
          success: false,
          error: expect.stringContaining("save-attachment"),
        });
        expect(server.commands.some((line) => /BODY\.PEEK\[2\.MIME\]/i.test(line))).toBe(false);
      }
      expect(server.commands.some((line) => /BODY\.PEEK\[2\]<\d+\.[12]>/i.test(line))).toBe(true);
    } finally {
      server.close();
    }
  });
});
