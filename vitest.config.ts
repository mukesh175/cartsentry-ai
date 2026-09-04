import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "app/**/*.test.tsx", "packages/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules", "build", "extensions/**/node_modules"],
  },
});
