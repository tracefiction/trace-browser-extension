import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

// A real cross-origin browser fetch, with no API host permission exemption.
// The API models the old/new ff allow-list. Count actual mutations, not fetch mocks.
test("real CORS: legacy/new allow-lists preserve one save; Firefox sends no metadata", async () => {
  const bundle = await build({
    entryPoints: ["src/extension-runtime/activity-fetch.mts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "TraceActivity",
    platform: "browser",
  });
  let mode = "old";
  const writes = [];
  const api = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,HEAD,POST,PATCH,DELETE,OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      mode === "old"
        ? "Content-Type,Authorization"
        : "Content-Type,Authorization,X-Trace-Platform,X-Trace-Extension-Browser,X-Trace-Extension-Version",
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    let body = "";
    for await (const part of req) body += part;
    writes.push({ headers: req.headers, body, method: req.method });
    res.setHeader("Content-Type", "application/json");
    res.end('{"saved":true}');
  });
  const web = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><script>" + bundle.outputFiles[0].text + "</script>",
    );
  });
  const listen = (s) =>
    new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  await listen(api);
  await listen(web);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.TRACE_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.TRACE_TEST_BROWSER_EXECUTABLE }
      : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${web.address().port}`);
    const apiBase = `http://127.0.0.1:${api.address().port}`;
    for (const scenario of ["old", "new", "firefox"]) {
      mode = scenario === "old" ? "old" : "new";
      writes.length = 0;
      const result = await page.evaluate(
        async ({ apiBase, scenario }) => {
          const runtime = {
            getURL: () =>
              scenario === "firefox"
                ? "moz-extension://test/"
                : "safari-web-extension://test/",
            getManifest: () => ({ version: "0.7.0" }),
            getPlatformInfo: async () => ({ os: "ios" }),
          };
          const send = TraceActivity.createActivityFetch(
            fetch.bind(globalThis),
            runtime,
            "promise",
            apiBase,
          );
          return (
            await send(apiBase + "/api/extension/track?case=" + scenario, {
              method: "POST",
              headers: {
                Authorization: "Bearer test",
                "Content-Type": "application/json",
              },
              body: '{"operationId":"one-save"}',
            })
          ).json();
        },
        { apiBase, scenario },
      );
      assert.deepEqual(result, { saved: true });
      assert.equal(writes.length, 1, scenario);
      assert.equal(writes[0].body, '{"operationId":"one-save"}');
      assert.equal(writes[0].headers.authorization, "Bearer test");
      assert.equal(
        writes[0].headers["x-trace-extension-version"],
        scenario === "new" ? "0.7.0" : undefined,
        scenario,
      );
      if (scenario === "firefox")
        assert.equal(
          Object.keys(writes[0].headers).some((k) => k.startsWith("x-trace-")),
          false,
        );
    }
  } finally {
    await browser.close();
    await Promise.all([
      new Promise((r) => api.close(r)),
      new Promise((r) => web.close(r)),
    ]);
  }
});
