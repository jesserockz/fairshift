import { defineConfig } from "vitest/config";
import { viteSingleFile } from "vite-plugin-singlefile";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Emit a `sw.js` whose cache name embeds a hash of the built index.html, so a
 * changed app produces a changed service worker (which drives the reload
 * prompt). Runs after the single-file bundle is written to disk.
 */
function pwaServiceWorker() {
  let outDir = "dist";
  let root = process.cwd();
  return {
    name: "fairshift-pwa-sw",
    apply: "build" as const,
    configResolved(cfg: { root: string; build: { outDir: string } }) {
      root = cfg.root;
      outDir = cfg.build.outDir;
    },
    closeBundle() {
      const dir = resolve(root, outDir);
      const html = readFileSync(resolve(dir, "index.html"), "utf8");
      const version = createHash("sha256").update(html).digest("hex").slice(0, 12);
      const sw = readFileSync(resolve(root, "pwa/service-worker.js"), "utf8").replace(
        /%VERSION%/g,
        version,
      );
      writeFileSync(resolve(dir, "sw.js"), sw);
    },
  };
}

export default defineConfig({
  // Emit one self-contained dist/index.html so the app stays "a single page"
  // you can drop anywhere, while the source stays modular and typed.
  plugins: [viteSingleFile(), pwaServiceWorker()],
  // Relative base so the service worker registers correctly when served from a
  // subpath (e.g. a GitHub Pages project site at /<repo>/).
  base: "./",
  build: {
    target: "es2022",
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/main.ts",
        "src/pwa.ts",
        "src/types.ts",
        "src/components/**",
      ],
      reporter: ["text", "text-summary"],
    },
  },
});
