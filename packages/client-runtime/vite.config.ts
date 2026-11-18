import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { TEST_MAX_WORKERS } from "../../scripts/lib/test-workers.ts";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: TEST_MAX_WORKERS,
    include: ["src/**/*.test.ts"],
    setupFiles: [
      "../shared/src/testing/longTempDir.ts",
      "../shared/src/testing/providerEnv.ts",
      "../shared/src/testing/locale.ts",
    ],
  },
});
