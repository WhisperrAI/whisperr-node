import { defineConfig } from "tsup";

export default defineConfig({
  // Core (".") + the optional Express adapter ("./express"), each ESM + CJS,
  // typed. The Express adapter imports express only as a type, so it adds no
  // runtime dependency for users who don't import it.
  entry: ["src/index.ts", "src/express.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  minify: false,
  sourcemap: false,
  target: "node18",
  platform: "node",
});
