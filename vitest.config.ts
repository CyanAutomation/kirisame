import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    config: false,
    main: "tests/worker/test-entrypoint.ts",
    miniflare: { compatibilityDate: "2026-11-21" },
  })],
  test: {
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
  },
});
