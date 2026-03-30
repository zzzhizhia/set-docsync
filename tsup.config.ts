import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  banner: { js: "#!/usr/bin/env node" },
  target: "node18",
  clean: true,
  splitting: false,
});
