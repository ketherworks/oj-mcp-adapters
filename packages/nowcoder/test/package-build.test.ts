import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("package build scripts", () => {
  test("builds project references before production, test typecheck, and prepack", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts).toMatchObject({
      build: "npm run clean && tsc -b tsconfig.json && node scripts/prepare-bin.mjs",
      typecheck: "npm run clean && tsc -b tsconfig.json",
      "typecheck:test": "npm run typecheck && tsc -p tsconfig.test.json",
      prepack: "npm run build && node scripts/verify-package.mjs"
    });
  });
});
