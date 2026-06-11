import { defineConfig } from "tsup";

// Build with tsup (esbuild) instead of plain tsc so the source can use
// extensionless relative imports — tsup resolves and bundles them into working
// ESM. Each public entry point in package.json (bin/main/exports/apps) gets its
// own output; shared code (createApp, version) is split into a common chunk so
// it isn't duplicated across them. Runtime deps stay external (not bundled).
export default defineConfig({
  entry: [
    "src/cli.ts",
    "src/index.ts",
    "src/app.ts",
    "src/server.ts",
    "src/pm2-module.ts",
  ],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  dts: true,
  splitting: true,
  clean: true,
  sourcemap: false,
});
