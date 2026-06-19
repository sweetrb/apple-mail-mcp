import { defineConfig } from "vitest/config";
import path from "path";

// IMAP integration suite — runs the IMAP backend against a real IMAP server
// (GreenMail in CI / Docker). Unlike the Mail.app integration suite this needs
// no macOS, so it runs on a Linux CI runner. Gated by RUN_IMAP_IT so it never
// runs as part of the unit suite.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/imap.integration.test.ts"],
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
