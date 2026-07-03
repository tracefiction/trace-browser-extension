#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

export const STORE_SCREENSHOT_TARGETS = [
  { width: 1284, height: 2778, orientation: "portrait" },
  { width: 1242, height: 2688, orientation: "portrait" },
  { width: 2778, height: 1284, orientation: "landscape" },
  { width: 2688, height: 1242, orientation: "landscape" },
];

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const DEFAULT_OPTIONS = {
  background: "#ffffff",
  fit: "cover",
  orientation: "same",
  outDir: path.join(ROOT, "dist", "store-screenshots"),
};

function usage() {
  return [
    "Usage: node scripts/prepare-store-screenshots.mjs [options] <image-or-directory...>",
    "",
    "Options:",
    "  --out <dir>                 Output directory. Default: dist/store-screenshots",
    "  --fit <cover|contain>       Resize mode. Default: cover",
    "  --background <color>        Background for --fit contain. Default: #ffffff",
    "  --orientation <mode>        same, portrait, landscape, or all. Default: same",
    "  --help                      Show this help",
    "",
    "Targets:",
    "  1284x2778, 1242x2688, 2778x1284, 2688x1242",
  ].join("\n");
}

function parseArgs(args) {
  const options = { ...DEFAULT_OPTIONS };
  const inputs = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true, inputs, options };
    }

    if (arg === "--out") {
      const value = args[++i];
      if (!value) throw new Error("--out requires a directory.");
      options.outDir = path.resolve(ROOT, value);
      continue;
    }

    if (arg === "--fit") {
      const value = args[++i];
      if (value !== "cover" && value !== "contain") {
        throw new Error("--fit must be cover or contain.");
      }
      options.fit = value;
      continue;
    }

    if (arg === "--background") {
      const value = args[++i];
      if (!value) throw new Error("--background requires a color value.");
      options.background = value;
      continue;
    }

    if (arg === "--orientation") {
      const value = args[++i];
      if (!["same", "portrait", "landscape", "all"].includes(value)) {
        throw new Error("--orientation must be same, portrait, landscape, or all.");
      }
      options.orientation = value;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    inputs.push(path.resolve(ROOT, arg));
  }

  return { help: false, inputs, options };
}

function isImagePath(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function findImageInputs(inputPaths) {
  const files = [];

  for (const inputPath of inputPaths) {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input does not exist: ${inputPath}`);
    }

    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(inputPath, { withFileTypes: true })) {
        const child = path.join(inputPath, entry.name);
        if (entry.isDirectory()) {
          files.push(...findImageInputs([child]));
        } else if (entry.isFile() && isImagePath(child)) {
          files.push(child);
        }
      }
      continue;
    }

    if (stat.isFile() && isImagePath(inputPath)) {
      files.push(inputPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function sourceOrientation(metadata) {
  if (metadata.orientedWidth > metadata.orientedHeight) return "landscape";
  return "portrait";
}

function targetsForImage(metadata, mode) {
  if (mode === "all") return STORE_SCREENSHOT_TARGETS;
  const orientation = mode === "same" ? sourceOrientation(metadata) : mode;
  return STORE_SCREENSHOT_TARGETS.filter((target) => target.orientation === orientation);
}

function slugForFile(filePath) {
  const parsed = path.parse(filePath);
  return parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    || "screenshot";
}

function uniquePath(filePath, usedPaths) {
  if (!usedPaths.has(filePath)) {
    usedPaths.add(filePath);
    return filePath;
  }

  const parsed = path.parse(filePath);
  let index = 2;
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!usedPaths.has(candidate)) {
      usedPaths.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

async function loadSharp() {
  try {
    return (await import("sharp")).default;
  } catch {
    throw new Error("Missing sharp. Run: npm install");
  }
}

function orientMetadata(metadata) {
  const orientationSwapsDimensions =
    metadata.orientation >= 5 && metadata.orientation <= 8;
  return {
    ...metadata,
    orientedWidth: orientationSwapsDimensions ? metadata.height : metadata.width,
    orientedHeight: orientationSwapsDimensions ? metadata.width : metadata.height,
  };
}

export async function prepareStoreScreenshots(inputPaths, options = {}) {
  const effectiveOptions = { ...DEFAULT_OPTIONS, ...options };
  const sharp = await loadSharp();
  const files = findImageInputs(inputPaths);
  if (files.length === 0) {
    throw new Error("No supported image files found.");
  }

  fs.mkdirSync(effectiveOptions.outDir, { recursive: true });

  const usedPaths = new Set();
  const outputs = [];
  for (const filePath of files) {
    const metadata = orientMetadata(await sharp(filePath).metadata());
    const targets = targetsForImage(metadata, effectiveOptions.orientation);
    const slug = slugForFile(filePath);

    for (const target of targets) {
      const outPath = uniquePath(
        path.join(
          effectiveOptions.outDir,
          `${slug}-${target.width}x${target.height}.png`,
        ),
        usedPaths,
      );
      await sharp(filePath)
        .rotate()
        .resize({
          width: target.width,
          height: target.height,
          fit: effectiveOptions.fit,
          position: "center",
          background: effectiveOptions.background,
        })
        .png({ compressionLevel: 9 })
        .toFile(outPath);

      outputs.push({
        input: filePath,
        output: outPath,
        sourceWidth: metadata.orientedWidth,
        sourceHeight: metadata.orientedHeight,
        width: target.width,
        height: target.height,
      });
    }
  }

  return outputs;
}

export async function main(args = process.argv.slice(2), consoleImpl = console) {
  const { help, inputs, options } = parseArgs(args);
  if (help) {
    consoleImpl.log(usage());
    return;
  }

  if (inputs.length === 0) {
    throw new Error(`${usage()}\n\nAt least one image or directory is required.`);
  }

  const outputs = await prepareStoreScreenshots(inputs, options);
  for (const output of outputs) {
    consoleImpl.log(
      `Wrote ${path.relative(ROOT, output.output)} ` +
        `(${output.width}x${output.height}) from ` +
        `${path.relative(ROOT, output.input)}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
