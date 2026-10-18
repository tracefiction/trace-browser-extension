#!/usr/bin/env node
/**
 * Rasterizes Shared (Extension)/Resources/images/trace-icon.svg into PNGs for manifest.icons.
 * trace-icon.svg is Trace's app icon in its light appearance, flattened: the
 * refined fingerprint mark (#FBF3EA, 60% of the tile's height) on the madder
 * field as the system renders it (#C24C22 to #A63D1A, top to bottom) with a
 * faint top rim light, on a rounded tile, so Safari's Page Menu and the
 * toolbar match the Home Screen icon. The app icon's glass can't be drawn in
 * a flat PNG. Browsers draw extension icons without a platform mask. Safari
 * greys the icon itself on sites Trace may not run on.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SVG_PATH = path.join(
  ROOT,
  "Shared (Extension)",
  "Resources",
  "images",
  "trace-icon.svg",
);
const OUT_DIR = path.dirname(SVG_PATH);
const SIZES = [16, 32, 48, 96, 128, 256, 512];

async function main() {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.error(
      "Missing sharp. Run: yarn install (or npm install) in the extension repo.",
    );
    process.exit(1);
  }

  if (!fs.existsSync(SVG_PATH)) {
    console.error("Expected SVG at", SVG_PATH);
    process.exit(1);
  }

  const svg = fs.readFileSync(SVG_PATH);
  for (const size of SIZES) {
    const dest = path.join(OUT_DIR, `icon-${size}.png`);
    await sharp(svg, { density: 320 })
      .resize(size, size)
      .png()
      .toFile(dest);
    console.log("Wrote", path.relative(ROOT, dest));
  }
}

await main();
