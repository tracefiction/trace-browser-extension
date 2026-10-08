#!/usr/bin/env node

// Installed Chromium check that reading on records progress by itself. A
// connected reader, in one tab that stays visible and focused, reads long
// enough for the extension's background to go idle, follows AO3's Next
// Chapter link (which AO3 asks Chrome to prerender), opens Entire Work, then
// moves from one FanFiction.net chapter to the next. Each page's progress
// must reach Trace within a few seconds, with no tab switch.
//
// Chrome does not prerender while DevTools (and so Playwright) is attached,
// so the browser runs headless on its own and the pages drive themselves.
// Local stand-ins serve Trace, its API, AO3 and FanFiction.net; no real
// account or site is used.

import assert from "node:assert/strict";
import { deviceSessionFixture } from "./device-session-test-fixture.mjs";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist", "chrome");
const STORY = "/works/28534965";
const CHAPTER_ONE = `${STORY}/chapters/69925506`;
const CHAPTER_TWO = `${STORY}/chapters/71063826`;
const FFN_STORY = "/s/7038840";
// Chrome stops an idle extension service worker after about 30 seconds.
const IDLE_MS = Number(process.env.TRACE_CHAPTER_PROGRESS_IDLE_MS ?? 35_000);
const STEP_MS = 4_000;
const PROGRESS_DEADLINE_MS = 8_000;

const startedAt = Date.now();
const events = [];
const tracks = [];
let connected = false;

function log(...parts) {
  console.log(String(Date.now() - startedAt).padStart(6), ...parts);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(100);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
  });
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function selfSignedCertificate(directory) {
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=archiveofourown.org",
    "-addext", "subjectAltName=DNS:archiveofourown.org,DNS:www.fanfiction.net",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || "openssl failed");
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// Each archive page reports what it sees, then takes the reader's next step
// itself `afterMs` after the reader has it open (a prerendered page waits).
function withPageScript(html, label, nextStep, afterMs = STEP_MS) {
  const step = nextStep
    ? `function read() { setTimeout(function () { report("next"); ${nextStep} }, ${afterMs}); }
       if (document.prerendering) document.addEventListener("prerenderingchange", read);
       else read();`
    : "";
  return html.replace("</body>", `<script>(function () {
    function report(event) {
      navigator.sendBeacon("/__event", JSON.stringify({
        label: ${JSON.stringify(label)},
        event: event,
        prerendering: document.prerendering === true,
      }));
    }
    report("loaded");
    document.addEventListener("prerenderingchange", function () { report("opened"); });
    ${step}
  })();</script></body>`);
}

function ao3ChapterTwo(html) {
  return html
    .replace('<option selected="selected" value="69925506">', '<option value="69925506">')
    .replace('<option value="71063826">', '<option selected="selected" value="71063826">')
    .replace('<div class="chapter" id="chapter-1">', '<div class="chapter" id="chapter-2">')
    .replace(/chapters\/69925506">Chapter 1<\/a>/, 'chapters/71063826">Chapter 2</a>')
    .replace(/works\/28534965\/chapters\/69925506/g, "works/28534965/chapters/71063826");
}

function ffnChapterTwo(html) {
  return html
    .replaceAll('<option value="1" selected="">', '<option value="1">')
    .replaceAll('<option value="2">', '<option value="2" selected="">');
}

const ao3Story = fs.readFileSync(path.join(ROOT, "test", "fixtures", "ao3_story.html"), "utf8");
const ffnStory = fs.readFileSync(path.join(ROOT, "test", "fixtures", "ffn_story.html"), "utf8");

function archivePage(host, url) {
  const pathname = url.pathname;
  if (host.startsWith("archiveofourown.org")) {
    if (pathname === CHAPTER_ONE) {
      // AO3's own page asks Chrome to prerender the next chapter.
      return withPageScript(ao3Story, "ao3-chapter-1",
        `document.querySelector("li.chapter.next a").click();`, IDLE_MS);
    }
    if (pathname === CHAPTER_TWO) {
      return withPageScript(ao3ChapterTwo(ao3Story), "ao3-chapter-2",
        `document.querySelector("li.chapter.entire a").click();`);
    }
    if (pathname === STORY && url.searchParams.get("view_full_work") === "true") {
      return withPageScript(ao3Story, "ao3-entire-work",
        `location.href = "https://www.fanfiction.net${FFN_STORY}/1/A-Chance-Encounter";`);
    }
    return null;
  }
  if (host.startsWith("www.fanfiction.net")) {
    if (pathname === `${FFN_STORY}/1/A-Chance-Encounter`) {
      return withPageScript(ffnStory, "ffn-chapter-1",
        `location.href = "${FFN_STORY}/2/A-Chance-Encounter";`);
    }
    if (pathname === `${FFN_STORY}/2/A-Chance-Encounter`) {
      return withPageScript(ffnChapterTwo(ffnStory), "ffn-chapter-2", "");
    }
  }
  return null;
}

const SIGNED_IN_TRACE_PAGE = `<!doctype html><title>Trace</title><body><script>
  const token = "kernel-progress-token";
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.type === "TRACE_FICTION_TOKEN_REQUEST") {
      window.postMessage({
        type: "TRACE_FICTION_TOKEN",
        token,
        ...(data.reason === "credential_grant" && data.protocolVersion === 1
          ? { protocolVersion: 1, requestId: data.requestId }
          : {}),
      }, window.location.origin);
    }
    if (data?.type === "TRACE_EXTENSION_STATUS_READY") {
      window.postMessage({ type: "TRACE_EXTENSION_FIRST_INSTALL_READY", protocolVersion: 1 }, window.location.origin);
    }
  });
  window.postMessage({ type: "TRACE_FICTION_TOKEN", token }, window.location.origin);
  // Once connected, the reader starts reading in this same tab.
  const poll = setInterval(async () => {
    const state = await (await fetch("/__state")).json();
    if (!state.connected) return;
    clearInterval(poll);
    setTimeout(() => { location.href = "https://archiveofourown.org${CHAPTER_ONE}"; }, 1500);
  }, 300);
</script></body>`;

const entries = new Map();

const deviceSessions = deviceSessionFixture();
const traceServer = http.createServer(async (request, response) => {
  if (await deviceSessions(request, response)) return;
  const authorized = (request.headers.authorization ?? "").startsWith("Bearer kernel-");
  if (request.url === "/__state") return json(response, 200, { connected });
  if (request.url === "/api/extension/account") {
    if (!authorized) return json(response, 401, { error: "unauthorized" });
    connected = true;
    return json(response, 200, { account_id: "chapter-progress-account" });
  }
  if (request.url === "/api/extension/library-overlay") {
    if (!authorized) return json(response, 401, { error: "unauthorized" });
    return json(response, 200, {
      success: true,
      data: { entries: {}, workPreferences: {}, syncVersion: "2026-10-04T09:00:00.000Z" },
    });
  }
  if (request.url === "/api/extension/track" && request.method === "POST") {
    if (!authorized) return json(response, 401, { error: "unauthorized" });
    const item = JSON.parse(await readBody(request)).item ?? {};
    const url = String(item.u ?? "");
    const ao3 = url.match(/\/works\/(\d+)/);
    const ffn = url.match(/\/s\/(\d+)/);
    assert.ok(ao3 || ffn, `unexpected track URL ${url}`);
    const workKey = ao3 ? `ao3:${ao3[1]}` : `ffn:${ffn[1]}`;
    const chapter = Number.isInteger(item.chn) ? item.chn : null;
    tracks.push({ workKey, chapter, chapterUrl: item.chu ?? null, at: Date.now() });
    log("track", workKey, `chapter ${chapter}`, item.chu ?? "(no chapter URL)");
    const previous = entries.get(workKey);
    const current = Math.max(previous?.chapters.current ?? 0, chapter > 1 ? chapter : 0);
    const entryId = previous?.entryId ??
      `00000000-0000-4000-8000-${String(entries.size + 1).padStart(12, "0")}`;
    const status = current > 0 ? "READING" : "PLANNING";
    const entry = {
      status,
      readerStatus: status,
      canonicalReaderStatus: current > 0 ? "READING" : "SAVED",
      entryId,
      chapters: { current, total: 17 },
    };
    entries.set(workKey, entry);
    return json(response, 200, {
      success: true,
      data: {
        entry_id: entryId,
        type: previous ? "updated" : "created",
        work_key: workKey,
        entry,
        syncVersion: new Date().toISOString(),
      },
    });
  }
  if (request.url?.startsWith("/api/")) {
    await readBody(request);
    const at = "2026-10-04T09:00:00.000Z";
    return json(response, 200, {
      success: true,
      data: { serverTime: at, syncVersion: at, presets: [], deleted: [] },
    });
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(SIGNED_IN_TRACE_PAGE);
});

const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "trace-chapter-progress-"));
const archiveServer = https.createServer(selfSignedCertificate(workDirectory), async (request, response) => {
  if (request.url === "/__event") {
    const report = JSON.parse(await readBody(request));
    report.at = Date.now();
    events.push(report);
    log("page", report.label, report.event, report.prerendering ? "(prerendering)" : "");
    response.end();
    return;
  }
  const body = archivePage(request.headers.host ?? "", new URL(request.url, "https://archive.invalid"));
  if (body === null) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
});

function pageEvent(label, name, since = 0) {
  return events.find((entry) => entry.label === label && entry.event === name && entry.at >= since) ?? null;
}

async function expectTrack(label, since, matches) {
  const track = await waitFor(
    () => tracks.find((entry) => entry.at >= since && matches(entry)),
    `${label} to be recorded without leaving the tab`,
    PROGRESS_DEADLINE_MS,
  );
  log(`${label}: recorded ${track.at - since} ms after the reader moved on`);
}

let browser = null;
try {
  await listen(traceServer);
  await listen(archiveServer);
  const origin = `http://127.0.0.1:${traceServer.address().port}`;
  const build = spawnSync("npm", ["run", "build:kernel"], {
    cwd: ROOT,
    env: { ...process.env, TRACE_API_BASE: origin, TRACE_WEB_ORIGIN: origin },
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr || "kernel build failed");

  const archivePort = archiveServer.address().port;
  browser = spawn(chromium.executablePath(), [
    "--headless=new",
    `--user-data-dir=${path.join(workDirectory, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    `--host-resolver-rules=MAP archiveofourown.org 127.0.0.1:${archivePort}, MAP www.fanfiction.net 127.0.0.1:${archivePort}`,
    "--ignore-certificate-errors",
    "about:blank",
  ], { stdio: "ignore" });

  await waitFor(() => connected, "the extension connecting", 20_000);
  log("connected");

  // AO3: chapter 1, a long read, then Next Chapter in the same tab.
  await waitFor(() => pageEvent("ao3-chapter-1", "loaded"), "AO3 chapter 1", 15_000);
  const next = await waitFor(() => pageEvent("ao3-chapter-1", "next"), "the Next Chapter click", IDLE_MS + 15_000);
  await expectTrack("AO3 next chapter", next.at,
    (entry) => entry.workKey === "ao3:28534965" && entry.chapter === 2);
  assert.ok(pageEvent("ao3-chapter-2", "opened", next.at),
    "Chrome should have opened AO3's prerendered next chapter, the case this check covers");

  // AO3 Entire Work from the chapter page.
  const entire = await waitFor(() => pageEvent("ao3-chapter-2", "next", next.at), "the Entire Work click", STEP_MS + 10_000);
  await expectTrack("AO3 entire work", entire.at,
    (entry) => entry.workKey === "ao3:28534965" && entry.chapterUrl === null);

  // FanFiction.net: chapter 1, then chapter 2 in the same tab.
  const ffnOne = await waitFor(() => pageEvent("ao3-entire-work", "next", entire.at), "opening FanFiction.net", STEP_MS + 10_000);
  await expectTrack("FFN chapter 1", ffnOne.at, (entry) => entry.workKey === "ffn:7038840");
  const ffnTwo = await waitFor(() => pageEvent("ffn-chapter-1", "next", ffnOne.at), "the next FanFiction.net chapter", STEP_MS + 10_000);
  await expectTrack("FFN next chapter", ffnTwo.at,
    (entry) => entry.workKey === "ffn:7038840" && entry.chapter === 2);

  console.log("chapter progress passed");
} finally {
  if (browser && browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill();
    await Promise.race([exited, delay(5_000)]);
  }
  await new Promise((resolve) => traceServer.close(resolve));
  await new Promise((resolve) => archiveServer.close(resolve));
  fs.rmSync(workDirectory, { recursive: true, force: true });
}
