import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import baseConfig from "../vite.config.ts";

// Only the test block: the root config's task and cache settings are valid in the workspace root alone.
export default defineConfig({ test: baseConfig.test });
