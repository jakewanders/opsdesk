import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests talk to the LOCAL Supabase stack (`npm run db:start`). They are separate
// from `npm run test:unit` so unit tests never need Docker.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
