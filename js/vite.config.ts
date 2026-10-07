import { defineConfig } from "vitest/config";

// VR_PORT: each checkout or agent picks its own port (docs/WORKFLOWS.md section 0).
const port = Number(process.env.VR_PORT ?? 5187);

export default defineConfig({
  server: {
    port,
    strictPort: true,
    // The repo's schema/ and vector folders live one level up and are imported directly.
    fs: { allow: [".."] },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The engine tests integrate stiff kinetics for many steps and take about 5 s on a busy CI runner, the default
    // limit, so one or two of them time out in each run (main and two pull requests failed on 2026-10-07 with
    // "Test timed out in 5000ms" in different tests each time). A timeout is not a result; allow 60 s.
    testTimeout: 60000,
  },
});
