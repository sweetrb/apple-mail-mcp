/** Loopback SMTP provider for synthetic acceptance and lost-acknowledgment tests. */
import { createServer, type Socket } from "node:net";
import type { SmtpConfig } from "@/services/smtpMailer.js";

export async function withSmtpFixture(
  refused: string[],
  check: (config: SmtpConfig, submissions: string[]) => Promise<void>,
  finalReply: "accept" | "close-after-data" | "reject-data" = "accept"
) {
  const sockets = new Set<Socket>();
  const submissions: string[] = [];
  const provider = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 fixture.invalid ESMTP\r\n");
    let buffer = "";
    let message: string[] | undefined;
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (message) {
          if (line === ".") {
            submissions.push(message.join("\r\n"));
            message = undefined;
            if (finalReply === "close-after-data") socket.destroy();
            else if (finalReply === "reject-data") socket.write("550 5.7.1 Message refused\r\n");
            else socket.write("250 2.0.0 Message accepted\r\n");
          } else message.push(line);
        } else if (line.startsWith("EHLO")) {
          socket.write("250-fixture.invalid\r\n250 AUTH PLAIN\r\n");
        } else if (line.startsWith("AUTH")) {
          socket.write("235 2.7.0 Authenticated\r\n");
        } else if (line.startsWith("RCPT TO:")) {
          const rejected = refused.some((address) => line.includes(`<${address}>`));
          socket.write(rejected ? "550 5.1.1 Recipient refused\r\n" : "250 Recipient OK\r\n");
        } else if (line === "DATA") {
          message = [];
          socket.write("354 End with a dot\r\n");
        } else if (line === "QUIT") socket.end("221 Goodbye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("No fixture TCP port");
    await check(
      {
        host: "127.0.0.1",
        port: address.port,
        secure: false,
        allowPlaintext: true,
        user: "fixture@example.test",
        pass: "synthetic",
        from: "fixture@example.test",
      },
      submissions
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}
