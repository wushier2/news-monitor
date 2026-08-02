import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("declares the production Worker and D1 deployment contract", async () => {
  const [wranglerText, packageText, viteConfig] = await Promise.all([
    readFile(new URL("wrangler.jsonc", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("vite.config.ts", root), "utf8"),
  ]);
  const wrangler = JSON.parse(wranglerText);
  const packageJson = JSON.parse(packageText);

  assert.equal(wrangler.name, "news-monitor");
  assert.equal(wrangler.main, "./worker/index.ts");
  assert.equal(wrangler.compatibility_date, "2026-05-22");
  assert.deepEqual(wrangler.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(wrangler.assets, { binding: "ASSETS" });
  assert.deepEqual(wrangler.images, { binding: "IMAGES" });
  assert.deepEqual(wrangler.d1_databases, [
    {
      binding: "DB",
      database_name: "news-monitor-db",
      database_id: "75190b32-a7c4-4fa4-9441-1697207bbbed",
      migrations_dir: "drizzle",
    },
  ]);

  assert.equal(packageJson.scripts.deploy, "vinext deploy");
  assert.equal(
    packageJson.scripts["db:migrate:remote"],
    "wrangler d1 migrations apply news-monitor-db --remote",
  );
  assert.match(viteConfig, /configPath:\s*["']\.\/wrangler\.jsonc["']/);
  assert.doesNotMatch(viteConfig, /00000000-0000-4000-8000-000000000000/);
});
