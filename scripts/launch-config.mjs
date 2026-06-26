import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

function normalizeBuildId(value) {
  const input = String(value ?? "").trim().toLowerCase();
  const readable = input
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const digest = createHash("sha256").update(input || "auri-build").digest("hex").slice(0, 10);
  return `${readable || "instance"}-${digest}`;
}

export const RELEASE_ICON_PATHS = Object.freeze([
  "icons/release/32x32.png",
  "icons/release/128x128.png",
  "icons/release/128x128@2x.png",
  "icons/release/icon.icns",
  "icons/release/icon.ico"
]);

export function bundleIdentifierForBuild(buildId) {
  return `app.auri.desktop.build.${normalizeBuildId(buildId)}`;
}

export function createTauriLaunchOverride(buildId, devUrl, productName) {
  const override = {
    identifier: bundleIdentifierForBuild(buildId),
    app: { enableGTKAppId: true }
  };
  if (productName) override.productName = productName;
  if (devUrl) override.build = { devUrl };
  return override;
}

export function createTauriBuildOverride(buildId) {
  return {
    ...createTauriLaunchOverride(buildId),
    bundle: { icon: [...RELEASE_ICON_PATHS] }
  };
}

export function createUniqueBuildId(prefix = "build") {
  return `${prefix}-${Date.now().toString(36)}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [, , buildId, devUrl, productName] = process.argv;
  if (!buildId) {
    console.error("Usage: node scripts/launch-config.mjs <build-id> [dev-url] [product-name]");
    process.exit(2);
  }
  console.log(JSON.stringify(createTauriLaunchOverride(buildId, devUrl, productName)));
}
