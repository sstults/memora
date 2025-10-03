import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.spec.ts"],
    setupFiles: ["tests/setup.ts"],
    globals: false,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "lcov"],
      all: true,
      include: ["src/**/*.ts"],
      exclude: [
        "dist/**",
        "node_modules/**",
        "tests/**",
        "src/index.ts",
        "src/routes/**",
        "src/services/os-client.ts",
        "src/services/rerank.ts",
        "src/domain/types.ts"
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 70
      }
    },
    hookTimeout: 20000,
    testTimeout: 10000
  }
});
