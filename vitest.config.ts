import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "app/**/*.test.tsx", "packages/**/*.test.ts", "tests/**/*.test.ts"],
    // `**/node_modules/**`, not `node_modules`: the latter only excludes the
    // root. npm hoists dependencies there, but pnpm installs them under each
    // workspace package, so `packages/**` would otherwise match the test suites
    // shipped inside our own dependencies — zod alone adds 1534 of them.
    exclude: ["**/node_modules/**", "**/build/**", "**/dist/**"],
  },
});
