const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

async function loadScript() {
  return import("../scripts/prepare-store-screenshots.mjs");
}

async function loadSharp() {
  return (await import("sharp")).default;
}

test("prepareStoreScreenshots writes exact portrait store target sizes", async () => {
  const sharp = await loadSharp();
  const { prepareStoreScreenshots } = await loadScript();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trace-store-shots-"));
  const input = path.join(tmp, "phone-screenshot.png");
  const outDir = path.join(tmp, "out");

  await sharp({
    create: {
      width: 1290,
      height: 2796,
      channels: 3,
      background: "#336699",
    },
  })
    .png()
    .toFile(input);

  const outputs = await prepareStoreScreenshots([input], { outDir });

  assert.deepEqual(
    outputs.map((output) => `${output.width}x${output.height}`).sort(),
    ["1242x2688", "1284x2778"],
  );

  for (const output of outputs) {
    const metadata = await sharp(output.output).metadata();
    assert.equal(metadata.width, output.width);
    assert.equal(metadata.height, output.height);
  }

  const rerunOutputs = await prepareStoreScreenshots([input], { outDir });
  assert.deepEqual(
    rerunOutputs.map((output) => path.basename(output.output)).sort(),
    outputs.map((output) => path.basename(output.output)).sort(),
  );
});

test("prepareStoreScreenshots can force all target orientations", async () => {
  const sharp = await loadSharp();
  const { prepareStoreScreenshots } = await loadScript();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trace-store-shots-"));
  const input = path.join(tmp, "landscape-screenshot.jpg");
  const outDir = path.join(tmp, "out");

  await sharp({
    create: {
      width: 2796,
      height: 1290,
      channels: 3,
      background: "#663399",
    },
  })
    .jpeg()
    .toFile(input);

  const outputs = await prepareStoreScreenshots([input], {
    orientation: "all",
    outDir,
  });

  assert.deepEqual(
    outputs.map((output) => `${output.width}x${output.height}`).sort(),
    ["1242x2688", "1284x2778", "2688x1242", "2778x1284"],
  );
});
