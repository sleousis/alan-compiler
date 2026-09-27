// Bundles the extension client and the language server into dist/.
// Run with --watch to rebuild on every change.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: {
    extension: "src/client/extension.ts",
    server: "src/server/server.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
