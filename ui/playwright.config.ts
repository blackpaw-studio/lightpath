import { defineConfig } from "@playwright/test";

// Specs and webServer arrive in M3; this only pins the toolchain.
export default defineConfig({ testDir: "e2e", testMatch: "**/*.spec.ts" });
