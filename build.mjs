import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outdir: "dist",
  external: ["openclaw", "openclaw/*"],
  sourcemap: false,
};

await build({
  ...shared,
  entryPoints: ["index.ts"],
});

await build({
  ...shared,
  entryPoints: ["setup-entry.ts"],
});

console.log("Build complete -> dist/");
