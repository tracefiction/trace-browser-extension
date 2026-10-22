const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "ao3-saved-filters.js",
);
const RESOURCE_DIR = path.dirname(SCRIPT_PATH);
const MANIFEST_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "manifest.json",
);
const FIXTURE_PATH = path.join(__dirname, "fixtures", "ao3_listing.html");
const STORY_FIXTURE_PATH = path.join(__dirname, "fixtures", "ao3_story.html");
const STORAGE_KEY = "traceAo3SavedFiltersV1";
const ACTIVE_KEY = "traceAo3SavedFiltersActiveV1";
const DELETED_KEY = "traceAo3SavedFiltersDeletedV1";
const PANEL_COLLAPSED_KEY = "traceAo3SavedFiltersPanelCollapsedV1";
const SYNC_META_KEY = "traceAo3SavedFiltersSyncV1";
const PREF_AO3_SAVED_FILTERS_KEY = "prefAo3SavedFiltersEnabled";
const LAST_USED_KEY = "traceAo3SavedFiltersLastUsedV1";

async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadFixture() {
  return fs.readFileSync(FIXTURE_PATH, "utf8");
}

function loadStoryFixture() {
  return fs.readFileSync(STORY_FIXTURE_PATH, "utf8");
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makePreset(overrides = {}) {
  return Object.assign(
    {
      id: "preset-a",
      name: "Long complete",
      params: [
        ["work_search[complete]", "T"],
        ["work_search[sort_column]", "kudos_count"],
      ],
      scope: "context",
      summary: ["Status: Complete works only", "Sort: Kudos"],
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    },
    overrides,
  );
}

async function renderSavedFilters({
  html = loadFixture(),
  url = "https://archiveofourown.org/works?work_search%5Bsort_column%5D=kudos_count&work_search%5Bcomplete%5D=T&work_search%5Bwords_from%5D=50000&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling&page=2&commit=Sort+and+Filter",
  storage = {},
  setErrorMessage = "",
  earnedPermissionComplete,
  narrow = false,
  session = {},
} = {}) {
  const script = fs.readFileSync(SCRIPT_PATH, "utf8");
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    contentType: "text/html",
  });
  const { window } = dom;
  const storageState = Object.assign({}, storage);
  let storageError = setErrorMessage;
  const changeListeners = [];
  const navigations = [];
  const runtimeMessages = [];
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, cb) {
        runtimeMessages.push(message);
        if (typeof cb === "function") cb({ ok: true });
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) out[key] = storageState[key];
          cb(out);
        },
        set(patch, cb) {
          if (storageError) {
            chrome.runtime.lastError = { message: storageError };
            if (typeof cb === "function") cb();
            chrome.runtime.lastError = null;
            return;
          }
          const changes = {};
          for (const [key, value] of Object.entries(patch || {})) {
            changes[key] = {
              oldValue: storageState[key],
              newValue: value,
            };
            storageState[key] = value;
          }
          if (typeof cb === "function") cb();
          for (const listener of changeListeners) listener(changes, "local");
        },
      },
      onChanged: {
        addListener(fn) {
          changeListeners.push(fn);
        },
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  if (narrow) {
    // A phone: AO3's narrow layout (max-width: 42em) applies.
    window.matchMedia = (query) => ({
      matches: /max-width:\s*42em/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    });
  }
  if (typeof earnedPermissionComplete === "boolean") {
    window.TRACE_IOS_EARNED_PERMISSION_ONBOARDING = {
      registrationMode: "static",
    };
    window.TRACE_EARNED_PERMISSION_COMPLETE = earnedPermissionComplete;
  }
  for (const [key, value] of Object.entries(session)) window.sessionStorage.setItem(key, value);
  window.__TRACE_AO3_SAVED_FILTERS_TESTS__ = true;
  window.__traceAo3SavedFiltersNavigate = (href) => {
    navigations.push(href);
  };
  window.eval(script);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  await sleep(80);
  return {
    window,
    storageState,
    navigations,
    runtimeMessages,
    setStorageError(message) {
      storageError = message;
    },
    async grantEarnedPermission() {
      window.TRACE_EARNED_PERMISSION_COMPLETE = true;
      window.document.dispatchEvent(
        new window.CustomEvent("trace-earned-permission-ready"),
      );
      window.document.dispatchEvent(
        new window.Event("DOMContentLoaded", { bubbles: true }),
      );
      await sleep(80);
    },
    emitStorageChange(changes, area = "local") {
      if (area === "local") {
        for (const [key, change] of Object.entries(changes || {})) {
          if (change && Object.prototype.hasOwnProperty.call(change, "newValue")) {
            if (change.newValue === undefined) {
              delete storageState[key];
            } else {
              storageState[key] = change.newValue;
            }
          }
        }
      }
      for (const listener of changeListeners) listener(changes, area);
    },
  };
}

function root(window) {
  return window.document.querySelector("[data-trace-ao3-saved-filters]");
}

test("AO3 saved filters remain inert until the complete Safari grant", async () => {
  const harness = await renderSavedFilters({ earnedPermissionComplete: false });
  assert.equal(root(harness.window), null);
  assert.deepEqual(harness.runtimeMessages, []);

  await harness.grantEarnedPermission();

  assert.ok(root(harness.window));
});

test("manifest loads AO3 saved filters with the generated archive content scripts", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  // The iPhone build declares no page scripts in its manifest: the background
  // registers the ones listed in the generated config once the reader allows
  // the story sites. Either way the same two bundles must be described.
  let pageScripts = manifest.content_scripts;
  if (!pageScripts) {
    const config = {};
    vm.runInNewContext(
      fs.readFileSync(path.join(path.dirname(MANIFEST_PATH), "popup-config.js"), "utf8"),
      config,
    );
    pageScripts = config.TRACE_IOS_EARNED_PERMISSION_ONBOARDING.registrations.map(
      (registration) => ({ js: Array.from(registration.js), matches: Array.from(registration.matches) }),
    );
  }
  const archiveEntry = pageScripts.find((entry) =>
    (entry.js || []).includes("collector.js"),
  );
  const savedFiltersEntry = pageScripts.find((entry) =>
    (entry.js || []).includes("ao3-saved-filters.js"),
  );
  assert.ok(archiveEntry, "expected archive content script entry");
  assert.ok(savedFiltersEntry, "expected AO3 saved filters content script entry");
  assert.ok(
    ["content-config.js", "popup-config.js"].includes(archiveEntry.js[0]),
    "expected the archive bundle's generated config owner",
  );
  assert.deepEqual(archiveEntry.js.slice(1), [
    "trace-finish-qualify.js",
    "collector.js",
    "library-overlay-keys.js",
    "library-overlay.js",
  ]);
  assert.deepEqual(savedFiltersEntry.js, ["ao3-saved-filters.js"]);
  assert.ok(
    savedFiltersEntry.matches.every((pattern) => /archiveofourown|transformativeworks|ao3/.test(pattern)),
    "saved filters should only inject on AO3-family hosts",
  );
  assert.ok(
    !savedFiltersEntry.matches.some((pattern) => /fanfiction\.net/.test(pattern)),
    "saved filters should not inject on FFN hosts",
  );
});

test("packaged extension resources avoid AMO-flagged HTML sinks", () => {
  const unsafeAssignments = [];
  for (const file of fs.readdirSync(RESOURCE_DIR)) {
    if (!file.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(RESOURCE_DIR, file), "utf8");
    if (/\.\s*(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/.test(text)) {
      unsafeAssignments.push(file);
    }
  }
  assert.deepEqual(unsafeAssignments, []);
});

test("AO3 saved filters never mounts into the Recent Works header search", async () => {
  const html = `<!doctype html>
    <html>
      <body>
        <header>
          <form class="search" id="search" action="/works/search">
            <fieldset>
              <legend>Search</legend>
              <input name="work_search[query]" type="text">
              <button type="submit">Search</button>
            </fieldset>
          </form>
        </header>
        <main>
          <h2>Recent Works</h2>
        </main>
      </body>
    </html>`;
  const { window } = await renderSavedFilters({
    html,
    url: "https://archiveofourown.org/works",
  });

  assert.equal(root(window), null);
  assert.equal(
    window.document.getElementById("trace-ao3-saved-filters-style"),
    null,
  );
  assert.equal(
    window.document.querySelector("#search [data-trace-ao3-saved-filters]"),
    null,
  );
});

function rowTokens(window) {
  return Array.from(root(window).querySelectorAll(".trace-sf-col-row")).map((row) => {
    const tokens = row.querySelector(".trace-sf-col-tokens");
    const name = row.querySelector(".trace-sf-col-name");
    return tokens && tokens.textContent !== "Any tag" ? tokens.textContent.replace(/^Any tag · /, "") : name.textContent;
  });
}

test("AO3 saved filters saves normalized current URL params locally", async () => {
  const { window, storageState, runtimeMessages } = await renderSavedFilters();
  const form = window.document.getElementById("work-filters");
  const fieldset = form.querySelector("fieldset");
  const mount = root(window);

  assert.ok(mount, "expected saved filters module");
  assert.equal(mount.parentElement, fieldset, "module should sit inside AO3's filter fieldset");
  assert.equal(mount.previousElementSibling.tagName, "LEGEND", "module should preserve the fieldset legend");
  assert.equal(mount.nextElementSibling.tagName, "DL", "module should stay above the AO3 filter controls");
  assert.equal(mount.querySelectorAll("[data-trace-sf-action='sheet-save']").length, 1, "one Save in the column");
  assert.equal(line(window).querySelector(".trace-sf-line-text").textContent, "Filtered: Complete · 50k+ words · By kudos");

  line(window).querySelector("[data-trace-sf-action='sheet-save']").click();
  await sleep(10);
  const host = sheet(window);
  const nameInput = host.querySelector("[data-trace-sf-name]");
  assert.equal(nameInput.value, "", "the name is optional");
  assert.equal(nameInput.getAttribute("placeholder"), "Complete · 50k+ words · By kudos");
  host.querySelector("[data-trace-sf-action='scope-context']").click();
  await sleep(10);
  const field = sheet(window).querySelector("[data-trace-sf-name]");
  field.value = "Long complete Bakudeku";
  field.dispatchEvent(new window.Event("input", { bubbles: true, cancelable: true }));
  sheet(window).querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);

  assert.equal(storageState[STORAGE_KEY].length, 1);
  const preset = storageState[STORAGE_KEY][0];
  assert.equal(preset.name, "Long complete Bakudeku");
  assert.equal(preset.clientId, preset.id);
  assert.equal(preset.dirty, true);
  assert.equal(preset.clientUpdatedAt, preset.updatedAt);
  assert.equal(preset.scope, "context");
  assert.equal(preset.contextKey, "tagId:Harry Potter - J*d* K*d* Rowling");
  assert.deepEqual(plain(preset.params), [
    ["work_search[complete]", "T"],
    ["work_search[sort_column]", "kudos_count"],
    ["work_search[words_from]", "50000"],
  ]);
  assert.ok(!preset.params.some(([key]) => key === "tag_id" || key === "page" || key === "commit"));
  assert.equal(storageState[ACTIVE_KEY].id, preset.id);
  assert.deepEqual(plain(runtimeMessages.at(-1)), { type: "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST" });
  assert.equal(line(window).querySelector(".trace-sf-line-text").textContent, "Showing Long complete Bakudeku");
  assert.equal(mount.querySelector("[data-trace-sf-action='sheet-save']"), null, "nothing left to save");
});

test("AO3 saved filters applies context presets to the current tag context", async () => {
  const preset = makePreset();
  const { window, storageState, navigations } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto",
    storage: { [STORAGE_KEY]: [preset] },
  });

  root(window).querySelector(".trace-sf-col-row").click();
  await sleep(80);

  assert.equal(navigations.length, 1);
  const target = new URL(navigations[0]);
  assert.equal(target.pathname, "/works");
  assert.equal(target.searchParams.get("tag_id"), "Naruto");
  assert.equal(target.searchParams.get("work_search[complete]"), "T");
  assert.equal(target.searchParams.get("work_search[sort_column]"), "kudos_count");
  assert.equal(storageState[ACTIVE_KEY].id, "preset-a");
  assert.equal(storageState[ACTIVE_KEY].contextKey, "tagId:Naruto");
});

test("AO3 saved filters applies global presets to the current tag context", async () => {
  const preset = makePreset({
    id: "anywhere-a",
    name: "Global relationship filters",
    scope: "global",
    params: [
      ["exclude_work_search[archive_warning_ids][]", "16"],
      ["exclude_work_search[freeform_ids][]", "110"],
      ["include_work_search[archive_warning_ids][]", "14"],
      ["include_work_search[category_ids][]", "22"],
      ["include_work_search[rating_ids][]", "10"],
      ["include_work_search[relationship_ids][]", "3741107"],
      ["work_search[sort_column]", "kudos_count"],
    ],
  });
  const { storageState, navigations, window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Avatar%3A+The+Last+Airbender&work_search%5Bsort_column%5D=updated_at",
    storage: { [STORAGE_KEY]: [preset] },
  });

  root(window).querySelector(".trace-sf-col-row").click();
  await sleep(80);

  assert.equal(navigations.length, 1);
  const target = new URL(navigations[0]);
  assert.equal(target.pathname, "/works");
  assert.equal(target.searchParams.get("tag_id"), "Avatar: The Last Airbender");
  assert.equal(target.searchParams.get("exclude_work_search[archive_warning_ids][]"), "16");
  assert.equal(target.searchParams.get("exclude_work_search[freeform_ids][]"), "110");
  assert.equal(target.searchParams.get("include_work_search[relationship_ids][]"), "3741107");
  assert.equal(target.searchParams.get("work_search[sort_column]"), "kudos_count");
  assert.equal(storageState[ACTIVE_KEY].id, "anywhere-a");
  assert.equal(storageState[ACTIVE_KEY].contextKey, "tagId:Avatar: The Last Airbender");
});

test("AO3 saved filters shows this tag's and any-tag presets, and says how many are on other tags", async () => {
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto&work_search%5Bsort_column%5D=kudos_count",
    storage: {
      [STORAGE_KEY]: [
        makePreset({ id: "context-naruto", name: "Naruto context filter", scope: "context", contextKey: "tagId:Naruto", contextLabel: "Naruto" }),
        makePreset({ id: "context-avatar", name: "Avatar context filter", scope: "context", contextKey: "tagId:Avatar: The Last Airbender", contextLabel: "Avatar: The Last Airbender" }),
        makePreset({ id: "global-a", name: "Reusable anywhere filter", scope: "global" }),
      ],
    },
  });
  const mount = root(window);
  assert.deepEqual(columnIds(window), ["context-naruto", "global-a"]);
  assert.doesNotMatch(mount.textContent, /Avatar context filter/);
  assert.equal(mount.querySelector("[data-trace-sf-action='sheet-open-others']").textContent, "1 more on other tags");
});

test("AO3 saved filters shows a filter saved on a tag's filtered results back on that tag's listing", async () => {
  // AO3's filter form submits to /works?tag_id=..., so a filter is saved on
  // that URL; the tag's own listing is /tags/<tag>/works.
  const saved = await renderSavedFilters();
  root(saved.window).querySelector("[data-trace-sf-action='sheet-save']").click();
  await sleep(10);
  sheet(saved.window).querySelector("[data-trace-sf-action='scope-context']").click();
  await sleep(10);
  sheet(saved.window).querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);
  assert.equal(saved.storageState[STORAGE_KEY].length, 1);

  const listing = await renderSavedFilters({
    url: "https://archiveofourown.org/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works",
    storage: plain(saved.storageState),
  });
  assert.deepEqual(rowTokens(listing.window), ["Complete · 50k+ words · By kudos"]);

  const otherTag = await renderSavedFilters({
    url: "https://archiveofourown.org/tags/Naruto/works",
    storage: plain(saved.storageState),
  });
  assert.equal(root(otherTag.window).querySelectorAll(".trace-sf-col-row").length, 0);
  assert.equal(root(otherTag.window).querySelector("[data-trace-sf-action='sheet-open-others']").textContent, "1 on other tags");
});

test("AO3 saved filters shows filters a pull brings in without a reload", async () => {
  const harness = await renderSavedFilters({ url: "https://archiveofourown.org/tags/Naruto/works" });
  assert.equal(root(harness.window).querySelectorAll(".trace-sf-col-row").length, 0);
  harness.emitStorageChange({
    [STORAGE_KEY]: { newValue: [makePreset({ id: "pulled", name: "From the account", scope: "global" })] },
    [SYNC_META_KEY]: { newValue: { syncVersion: "v2", lastSyncedAt: new Date().toISOString() } },
  });
  await sleep(80);
  assert.deepEqual(columnIds(harness.window), ["pulled"]);
  assert.equal(root(harness.window).querySelector(".trace-sf-col-name").textContent, "From the account");
});

test("AO3 saved filters keeps Trace control events away from AO3 filter handlers", async () => {
  const { window, emitStorageChange } = await renderSavedFilters();
  const mount = root(window);
  const form = window.document.getElementById("work-filters");
  const saveButton = mount.querySelector("[data-trace-sf-action='sheet-save']");
  const counts = { form: 0, click: 0, pointerdown: 0, pointerup: 0, mousedown: 0, mouseup: 0, touchend: 0, keydown: 0 };
  form.addEventListener("click", () => { counts.form += 1; });
  for (const type of ["click", "pointerdown", "pointerup", "mousedown", "mouseup", "touchend", "keydown"]) {
    window.document.addEventListener(type, () => { counts[type] += 1; });
  }
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"]) {
    saveButton.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  }
  saveButton.click();
  await sleep(10);
  assert.deepEqual(counts, { form: 0, click: 0, pointerdown: 0, pointerup: 0, mousedown: 0, mouseup: 0, touchend: 0, keydown: 0 });
  const nameInput = sheet(window).querySelector("[data-trace-sf-name]");
  assert.ok(nameInput, "Trace action should still run");

  nameInput.value = "Draft should stay";
  nameInput.dispatchEvent(new window.Event("input", { bubbles: true, cancelable: true }));
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"]) {
    nameInput.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  }
  nameInput.click();
  nameInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "M", bubbles: true, cancelable: true }));
  await sleep(0);
  assert.deepEqual(counts, { form: 0, click: 0, pointerdown: 0, pointerup: 0, mousedown: 0, mouseup: 0, touchend: 0, keydown: 0 });

  emitStorageChange({ [ACTIVE_KEY]: { oldValue: null, newValue: null } });
  await sleep(80);
  assert.equal(sheet(window).querySelector("[data-trace-sf-name]").value, "Draft should stay", "a pull doesn't lose the draft");
});

test("AO3 saved filters names every token from the page's own labels", async () => {
  const longTags = "Found Family,Emotional Hurt/Comfort with a Very Long Happy Ending That Keeps Going";
  const params = [
    ["include_work_search[rating_ids][]", "11"],
    ["include_work_search[archive_warning_ids][]", "16"],
    ["include_work_search[category_ids][]", "23"],
    ["include_work_search[relationship_ids][]", "1110"],
    ["include_work_search[freeform_ids][]", "143795"],
    ["include_work_search[freeform_ids][]", "2379"],
    ["exclude_work_search[archive_warning_ids][]", "18"],
    ["work_search[other_tag_names]", longTags],
    ["work_search[complete]", "T"],
    ["work_search[words_from]", "10000"],
    ["work_search[words_to]", "50000"],
    ["work_search[sort_column]", "kudos_count"],
  ];
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Harry+Potter+-+J*d*+K*d*+Rowling",
    storage: {
      [STORAGE_KEY]: [makePreset({
        id: "long",
        name: "A long saved filter",
        params,
        // An older save's truncated summary is ignored when the page can label every value.
        summary: ["Include: Teen And Up Audiences", "+11 more"],
      })],
    },
  });
  const row = root(window).querySelector(".trace-sf-col-row");
  const tokens = row.querySelector(".trace-sf-col-tokens").textContent;
  assert.equal(tokens, "Alternate Universe - Canon Divergence · Hurt/Comfort · Sirius Black/Remus Lupin · Found Family · Emotional Hurt/Comfort with a Very Long Happy Ending That Keeps Going · " +
    "Teen And Up Audiences · No Archive Warnings Apply · M/M · Complete · 10k–50k words · Not Major Character Death · By kudos");
  assert.doesNotMatch(tokens, /more|\.\.\./);
  assert.equal(row.getAttribute("aria-label"), `A long saved filter. ${tokens}.`);
});

test("AO3 saved filters falls back to the stored summary only for values the page can't label", async () => {
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto",
    storage: {
      [STORAGE_KEY]: [makePreset({
        id: "elsewhere",
        name: "Saved on another fandom",
        scope: "global",
        params: [["include_work_search[freeform_ids][]", "999999999"], ["work_search[complete]", "T"]],
        summary: ["Include Bakugou Katsuki/Midoriya Izuku", "Complete only"],
      })],
    },
  });
  assert.deepEqual(rowTokens(window), ["Include Bakugou Katsuki/Midoriya Izuku · Complete"]);
});

test("AO3 saved filters names a saved language whatever the page's language dropdown shows", async () => {
  const { window } = await renderSavedFilters({
    storage: {
      [STORAGE_KEY]: [makePreset({
        params: [["work_search[complete]", "T"], ["work_search[language_id]", "afr"]],
        summary: ["Complete only", "In afr"],
      })],
    },
  });
  assert.notEqual(window.document.getElementById("work_search_language_id").value, "afr");
  assert.deepEqual(rowTokens(window), ["Complete · Afrikaans"]);
});

test("AO3 saved filters uses the stored summary only for the parts the page can't name", async () => {
  const unknownTag = ["include_work_search[freeform_ids][]", "999999999"];
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto",
    storage: {
      [STORAGE_KEY]: [
        makePreset({
          id: "partial",
          name: "Partly named",
          scope: "global",
          params: [unknownTag, ["work_search[complete]", "T"], ["work_search[words_from]", "50000"], ["work_search[language_id]", "afr"], ["work_search[sort_column]", "kudos_count"]],
          summary: ["Include Bakugou Katsuki/Midoriya Izuku", "stale", "stale", "stale", "stale"],
        }),
        makePreset({
          id: "capped",
          name: "Past the stored cap",
          scope: "global",
          params: [unknownTag, ["include_work_search[rating_ids][]", "11"], ["work_search[complete]", "T"], ["work_search[crossover]", "F"], ["work_search[words_from]", "50000"], ["work_search[language_id]", "zzz"], ["work_search[sort_column]", "kudos_count"]],
          summary: ["Include Bakugou Katsuki/Midoriya Izuku", "stale", "stale", "stale", "stale"],
        }),
      ],
    },
  });
  assert.deepEqual(rowTokens(window), [
    "Include Bakugou Katsuki/Midoriya Izuku · Complete · 50k+ words · Afrikaans · By kudos",
    "Include Bakugou Katsuki/Midoriya Izuku · Teen And Up Audiences · Complete · 50k+ words · No crossovers · By kudos +1",
  ]);
});

test("AO3 saved filters save sheet lists everything it keeps, grouped", async () => {
  const query = [
    ["work_search[sort_column]", "kudos_count"],
    ["include_work_search[freeform_ids][]", "2379"],
    ["include_work_search[rating_ids][]", "11"],
    ["exclude_work_search[archive_warning_ids][]", "18"],
    ["exclude_work_search[freeform_ids][]", "110"],
    ["work_search[other_tag_names]", "Found Family,Emotional Hurt/Comfort with a Very Long Happy Ending"],
    ["work_search[crossover]", "F"],
    ["work_search[complete]", "T"],
    ["work_search[words_from]", "10000"],
    ["work_search[query]", "slow burn"],
  ].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  const { window, storageState } = await renderSavedFilters({
    url: `https://archiveofourown.org/works?${query}&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling`,
  });
  root(window).querySelector("[data-trace-sf-action='sheet-save']").click();
  await sleep(10);
  const host = sheet(window);
  const keeps = host.querySelector("dl.trace-sf-sheet-keeps");
  assert.equal(host.querySelector("#" + keeps.getAttribute("aria-labelledby")).textContent, "What it keeps");
  const rows = Array.from(keeps.querySelectorAll("dt")).map((dt) => [dt.textContent, dt.nextElementSibling.textContent]);
  assert.deepEqual(rows, [
    ["Include", "Hurt/Comfort, Found Family, Emotional Hurt/Comfort with a Very Long Happy Ending"],
    ["Exclude", "Major Character Death, Fluff"],
    ["Rating", "Teen And Up Audiences"],
    ["Status", "Complete only"],
    ["Crossovers", "No crossovers"],
    ["Words", "At least 10,000 words"],
    ["Search", "slow burn"],
    ["Sort", "Kudos"],
  ]);

  const group = host.querySelector("[role='radiogroup'][aria-labelledby='trace-sf-scope-label']");
  assert.equal(host.querySelector("#trace-sf-scope-label").textContent, "Show it on");
  const radios = Array.from(group.querySelectorAll("[role='radio']"));
  assert.deepEqual(radios.map((radio) => radio.textContent), ["This tagHarry Potter - J. K. Rowling", "Any tagEvery AO3 search"]);
  assert.deepEqual(radios.map((radio) => radio.getAttribute("aria-checked")), ["true", "false"], "it names tags to include");
  radios[1].click();
  await sleep(10);
  const updated = Array.from(sheet(window).querySelectorAll("#trace-sf-scope-label + [role='radiogroup'] [role='radio']"));
  assert.deepEqual(updated.map((radio) => radio.getAttribute("aria-checked")), ["false", "true"]);
  assert.equal(window.document.activeElement, updated[1]);

  sheet(window).querySelector("[data-trace-sf-name]").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await sleep(80);
  const saved = storageState[STORAGE_KEY][0];
  assert.equal(saved.scope, "global");
  assert.ok(saved.summary.length <= 5, "the stored fallback stays within what sync accepts");
  assert.ok(saved.summary.every((part) => part.length <= 64));
});

test("AO3 saved filters says where a filter shows when the page has no tag", async () => {
  const { window } = await renderSavedFilters({ url: "https://archiveofourown.org/works?work_search%5Bcomplete%5D=T" });
  const opener = root(window).querySelector("[data-trace-sf-action='sheet-save']");
  opener.click();
  await sleep(10);
  assert.equal(sheet(window).querySelector("#trace-sf-scope-label"), null);
  assert.match(sheet(window).querySelector(".trace-sf-sheet-body").textContent, /Any tag\. This page has no tag\./);
  sheet(window).querySelector(".trace-sf-sheet-foot [data-trace-sf-action='sheet-close']").click();
  await sleep(10);
  assert.equal(sheet(window), null);
  assert.equal(window.document.activeElement, root(window).querySelector("[data-trace-sf-action='sheet-save']"), "focus returns to Save on Cancel");
});

test("AO3 saved filters blocks new saves at the active preset cap", async () => {
  const presets = Array.from({ length: 250 }, (_, index) => makePreset({ id: `preset-cap-${index}`, name: `Saved filter ${index + 1}`, scope: "context" }));
  const { window } = await renderSavedFilters({ storage: { [STORAGE_KEY]: presets } });
  assert.match(root(window).textContent, /You've saved 250 filters, the most Trace keeps\. Delete one to save another\./);
  assert.equal(root(window).querySelector("[data-trace-sf-action='sheet-save']"), null);
  assert.equal(line(window), null, "no Save on the line either");
});

test("AO3 saved filters warns before the active preset cap", async () => {
  const presets = Array.from({ length: 200 }, (_, index) => makePreset({ id: `preset-warning-${index}`, name: `Saved filter ${index + 1}`, scope: "context" }));
  const { window } = await renderSavedFilters({ storage: { [STORAGE_KEY]: presets } });
  root(window).querySelector("[data-trace-sf-action='sheet-save']").click();
  await sleep(10);
  assert.match(sheet(window).textContent, /200 of 250 saved filters used/);
  assert.ok(sheet(window).querySelector("[data-trace-sf-action='save-confirm']"));
});

test("AO3 saved filters marks the active row", async () => {
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto&work_search%5Bsort_column%5D=kudos_count",
    storage: {
      [STORAGE_KEY]: [
        makePreset({ id: "context-other", name: "Current tag unread", contextKey: "tagId:Naruto", contextLabel: "Naruto", params: [["work_search[complete]", "T"]] }),
        makePreset({ id: "global-active", name: "Global kudos", scope: "global", params: [["work_search[sort_column]", "kudos_count"]] }),
      ],
    },
  });
  const mount = root(window);
  const active = mount.querySelector(".trace-sf-col-row[data-id='global-active']");
  assert.equal(active.getAttribute("aria-current"), "true");
  assert.ok(active.querySelector(".trace-sf-col-check svg"), "the active row carries the ink check");
  assert.equal(mount.querySelector(".trace-sf-col-row[data-id='context-other']").getAttribute("aria-current"), null);
  assert.equal(line(window).querySelector(".trace-sf-line-text").textContent, "Showing Global kudos");
});

test("AO3 saved filters surfaces local storage failures in the sheet and keeps the draft", async () => {
  const harness = await renderSavedFilters({ setErrorMessage: "Local storage is full." });
  const { window, storageState } = harness;
  root(window).querySelector("[data-trace-sf-action='sheet-save']").click();
  await sleep(10);
  const nameInput = sheet(window).querySelector("[data-trace-sf-name]");
  nameInput.value = "My draft name";
  nameInput.dispatchEvent(new window.Event("input", { bubbles: true, cancelable: true }));
  sheet(window).querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);

  assert.equal(storageState[STORAGE_KEY], undefined);
  const error = sheet(window).querySelector(".trace-sf-sheet-error");
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(error.textContent, "Couldn't save. Nothing changed.Try again");
  assert.ok(error.querySelector("svg"));
  assert.equal(sheet(window).querySelector("[data-trace-sf-name]").value, "My draft name", "the sheet keeps its draft");

  harness.setStorageError("");
  sheet(window).querySelector("[data-trace-sf-action='retry']").click();
  await sleep(80);
  assert.equal(storageState[STORAGE_KEY].length, 1);
  assert.equal(storageState[STORAGE_KEY][0].name, "My draft name");
  assert.equal(sheet(window), null, "a saved filter closes the sheet");
});

test("AO3 saved filters explains applying a tag filter off a tag page", async () => {
  const { window, navigations } = await renderSavedFilters({
    url: "https://archiveofourown.org/works",
    html: loadFixture(),
    storage: { [STORAGE_KEY]: [makePreset({ contextKey: "" })] },
  });
  root(window).querySelector(".trace-sf-col-row").click();
  await sleep(80);
  assert.equal(navigations.length, 1);
  assert.match(root(window).textContent, /This page isn't a tag page, so the filter is applied across all of AO3\./);
});



test("AO3 saved filters does not mount on AO3 story pages", async () => {
  const { window } = await renderSavedFilters({
    html: loadStoryFixture(),
    url: "https://archiveofourown.org/works/28534965/chapters/69925506",
  });

  assert.equal(root(window), null);
  assert.equal(window.document.getElementById("trace-ao3-saved-filters-style"), null);
});

test("AO3 saved filters respects the local visibility preference", async () => {
  const preset = makePreset({
    id: "saved-hidden",
    name: "Hidden but preserved",
  });
  const { window, storageState, emitStorageChange } = await renderSavedFilters({
    storage: {
      [PREF_AO3_SAVED_FILTERS_KEY]: false,
      [STORAGE_KEY]: [preset],
    },
  });

  assert.equal(root(window), null);
  assert.equal(storageState[STORAGE_KEY].length, 1);

  emitStorageChange({
    [PREF_AO3_SAVED_FILTERS_KEY]: { oldValue: false, newValue: true },
  });
  await sleep(80);

  assert.ok(root(window), "re-enabling should mount the saved filters card");
  assert.match(root(window).textContent, /Hidden but preserved/);

  emitStorageChange({
    [PREF_AO3_SAVED_FILTERS_KEY]: { oldValue: true, newValue: false },
  });
  await sleep(80);

  assert.equal(root(window), null);
  assert.equal(storageState[STORAGE_KEY].length, 1);
});





test("AO3 saved filters asks for one pull on a filter page this device hasn't synced lately", async () => {
  const syncRequest = { type: "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST" };
  const listing = "https://archiveofourown.org/tags/Naruto/works";

  const missing = await renderSavedFilters({ url: listing });
  assert.deepEqual(plain(missing.runtimeMessages), [syncRequest], "no sync record");

  const stale = await renderSavedFilters({
    url: listing,
    storage: {
      [SYNC_META_KEY]: {
        syncVersion: "v1",
        lastSyncedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      },
    },
  });
  assert.deepEqual(plain(stale.runtimeMessages), [syncRequest], "last pull over 30 minutes ago");

  const fresh = await renderSavedFilters({
    url: listing,
    storage: {
      [SYNC_META_KEY]: {
        syncVersion: "v1",
        lastSyncedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    },
  });
  assert.deepEqual(plain(fresh.runtimeMessages), [], "a recent pull is enough");

  const story = await renderSavedFilters({
    html: loadStoryFixture(),
    url: "https://archiveofourown.org/works/123",
  });
  assert.deepEqual(plain(story.runtimeMessages), [], "only filter pages ask");

  const hidden = await renderSavedFilters({
    url: listing,
    storage: { [PREF_AO3_SAVED_FILTERS_KEY]: false },
  });
  assert.deepEqual(plain(hidden.runtimeMessages), [], "nor when saved filters are turned off");
});










test("AO3 saved filters resets AO3's button styles so nothing inside the panel clips", async () => {
  const { window } = await renderSavedFilters({ storage: { [STORAGE_KEY]: [makePreset()] } });
  const css = window.document.getElementById("trace-ao3-saved-filters-style").textContent;
  const reset = css.match(/\.data-trace-ao3-saved-filters\[data-trace-ao3-saved-filters\] button \{([^}]*)\}/);
  assert.ok(reset, "expected the panel's button reset");
  for (const declaration of [
    "height: auto",
    "max-height: none",
    "line-height: inherit",
    "white-space: normal",
    "overflow: visible",
    "float: none",
    "width: auto",
    "text-overflow: clip",
  ]) {
    assert.ok(reset[1].includes(declaration + ";"), `button reset is missing ${declaration}`);
  }
  assert.doesNotMatch(css, /overflow(?:-[xy])?:\s*(?:hidden|auto|scroll)/, "no clipped or scrolling boxes");
  assert.doesNotMatch(css, /max-height:\s*(?!\s|none)/, "no capped heights");
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis|line-clamp|nowrap/, "nothing is cut to one line");
  for (const [, selector, body] of css.matchAll(/([^{}\n]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|[;\s])height:\s*\d/.test(body)) continue;
    assert.match(
      selector,
      /check|edge|caret|svg|menu-btn|clear-name|radio-mark|error-glyph|::after/,
      `only icons and 44 px icon targets have a fixed height, not ${selector.trim()}`,
    );
  }
});














test("AO3 saved filters exits on credential or password pages", async () => {
  const html = [
    "<!doctype html><html><head></head><body>",
    "<form id='work-filters' action='/works' method='get'>",
    "<input type='password' name='password'>",
    "<input name='work_search[query]' value='demo'>",
    "</form>",
    "</body></html>",
  ].join("");

  const { window } = await renderSavedFilters({
    html,
    url: "https://archiveofourown.org/works?work_search%5Bquery%5D=demo",
  });

  assert.equal(root(window), null);
});

// ------------------------------------------------------------------ phone
// On AO3's narrow layout the filter form is a 16em grey column. Saved filters
// sit at its top as Trace's lines; a line above the works speaks only while
// filters are on; Trace's sheet holds saving and the Edit list; what a filter
// keeps is changed in AO3's own form.

const TAG_PAGE = "https://archiveofourown.org/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works";
const TAG_ID = "Harry+Potter+-+J*d*+K*d*+Rowling";
const FILTERED_PAGE = `https://archiveofourown.org/works?work_search%5Bsort_column%5D=kudos_count&work_search%5Bcomplete%5D=T&work_search%5Bwords_from%5D=50000&commit=Sort+and+Filter&tag_id=${TAG_ID}`;
const HP_KEY = "tagPath:/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works";

function phonePresets() {
  const ws = (field) => `work_search[${field}]`;
  const context = { scope: "context", contextKey: HP_KEY, contextLabel: "Harry Potter - J K Rowling", summary: [] };
  return [
    makePreset(Object.assign({}, context, { id: "p1", name: "Long complete works", params: [[ws("complete"), "T"], [ws("sort_column"), "kudos_count"], [ws("words_from"), "50000"]] })),
    makePreset(Object.assign({}, context, { id: "p2", name: "Slow burn, finished", params: [[ws("complete"), "T"], [ws("other_tag_names"), "Slow Burn"], [ws("sort_column"), "revised_at"]] })),
    makePreset(Object.assign({}, context, {
      id: "p5",
      name: "Marauders, no MCD",
      params: [[ws("complete"), "T"], [ws("crossover"), "F"], [ws("excluded_tag_names"), "Major Character Death,Unhappy Ending,Infidelity"], [ws("language_id"), "en"], [ws("other_tag_names"), "Remus Lupin/Sirius Black,Marauders Era"], [ws("sort_column"), "kudos_count"], [ws("words_from"), "20000"], [ws("words_to"), "150000"]],
    })),
    makePreset({ id: "p3", name: "Comfort reads", scope: "global", summary: [], params: [[ws("excluded_tag_names"), "Major Character Death"], [ws("other_tag_names"), "Fluff,Hurt/Comfort"], [ws("words_to"), "40000"]] }),
    makePreset({ id: "p4", name: "New this week", scope: "global", summary: [], params: [[ws("date_from"), "2026-10-13"], [ws("sort_column"), "revised_at"]] }),
  ];
}

function sheet(window) {
  return window.document.querySelector("[data-trace-ao3-saved-filters-sheet]");
}

function line(window) {
  return window.document.querySelector("[data-trace-ao3-saved-filters-line]");
}

function columnRows(window) {
  return Array.from(root(window).querySelectorAll(".trace-sf-col-row"));
}

function columnIds(window) {
  return columnRows(window).map((row) => row.getAttribute("data-id"));
}

const EDITING_SESSION_KEY = "traceAo3SavedFilterEditing";

test("on a phone the column shows every saved filter as Trace's lines on AO3's grey, up to four", async () => {
  const three = phonePresets().filter((preset) => ["p1", "p5", "p3"].includes(preset.id));
  const { window } = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: { [STORAGE_KEY]: three } });
  const mount = root(window);
  assert.equal(mount.parentElement.tagName, "FIELDSET", "the column keeps its place at the top of AO3's form");
  assert.equal(mount.querySelector(".trace-sf-col-title").textContent, "Saved filters");
  assert.ok(mount.querySelector(".trace-sf-col-title svg"), "the lock from Your record");
  const edit = mount.querySelector("[data-trace-sf-action='sheet-open']");
  assert.equal(edit.textContent, "Edit");
  assert.equal(edit.getAttribute("aria-label"), "Edit saved filters");
  assert.deepEqual(columnIds(window), ["p1", "p5", "p3"], "every filter shows; this tag's first");
  const marauders = mount.querySelector(".trace-sf-col-row[data-id='p5']");
  assert.equal(marauders.querySelector(".trace-sf-col-name").textContent, "Marauders, no MCD");
  assert.match(marauders.querySelector(".trace-sf-col-tokens").textContent, /^Remus Lupin\/Sirius Black · Marauders Era/);
  assert.equal(mount.querySelector(".trace-sf-col-row[data-id='p3'] .trace-sf-col-tokens").textContent.split(" · ")[0], "Any tag", "an any-tag filter says so");
  assert.equal(mount.querySelector("[aria-current]"), null);
  assert.equal(mount.querySelector("[data-trace-sf-action='sheet-save']"), null, "nothing to save without filters");
  assert.equal(line(window), null, "an unfiltered listing shows no line");
  assert.match(mount.getAttribute("style"), /--trace-col-teal:\s*#125E62/i, "teal is darkened on AO3's light grey");
  assert.match(mount.getAttribute("style"), /--trace-col-secondary:\s*#4A545E/i);

  const css = window.document.getElementById("trace-ao3-saved-filters-phone-style").textContent;
  assert.match(css, /\.trace-sf-col-name \{[^}]*-webkit-line-clamp: 2;/, "names wrap to two lines instead of cutting off");
  assert.doesNotMatch(css, /\.trace-sf-col \{[^}]*(?:border-radius|background)/, "no box or tint in the column");
  assert.match(css, /\.trace-sf-col-row \{[^}]*min-height: 46px;/);
  assert.match(css, /\.trace-sf-col-link \{[^}]*min-height: 44px;/);
});

test("focus rings show for the keyboard only, so AO3 focusing Edit as Filters opens draws nothing", async () => {
  const { window } = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  const html = window.document.documentElement;
  const css = Array.from(window.document.querySelectorAll("style")).map((style) => style.textContent).join("\n");
  const rings = css.split("\n").filter((rule) => /:focus-visible \{[^}]*outline: 3px/.test(rule));
  assert.ok(rings.length >= 3, "the column, the line and the sheet each have a ring");
  for (const rule of rings) assert.match(rule, /^html\[data-trace-sf-keyboard\] /, "rings need keyboard use");

  // AO3's filters.js focuses the form's first control when Filters opens.
  window.document.dispatchEvent(new window.Event("touchstart", { bubbles: true }));
  root(window).querySelector("[data-trace-sf-action='sheet-open']").focus();
  assert.equal(html.hasAttribute("data-trace-sf-keyboard"), false);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assert.equal(html.hasAttribute("data-trace-sf-keyboard"), true);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  assert.equal(html.hasAttribute("data-trace-sf-keyboard"), true, "typing doesn't change it");
  window.document.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.equal(html.hasAttribute("data-trace-sf-keyboard"), false);
});

test("on a phone five or more saved filters show three, then Show all", async () => {
  const { window } = await renderSavedFilters({
    narrow: true,
    url: TAG_PAGE,
    storage: {
      [STORAGE_KEY]: phonePresets(),
      [LAST_USED_KEY]: {
        byId: { p2: "2026-10-19T10:00:00.000Z", p3: "2026-10-20T09:00:00.000Z", p5: "2026-10-18T10:00:00.000Z", p4: "2026-10-20T10:00:00.000Z" },
        byContext: { "tag:harry potter - j. k. rowling": { id: "p2", at: "2026-10-19T10:00:00.000Z" } },
      },
    },
  });
  // Last used on this tag, then this tag's others (recent first).
  assert.deepEqual(columnIds(window), ["p2", "p5", "p1"]);
  const all = root(window).querySelector("[data-trace-sf-action='col-show-all']");
  assert.equal(all.textContent, "Show all 5");
  all.click();
  await sleep(10);
  assert.deepEqual(columnIds(window), ["p2", "p5", "p1", "p4", "p3"]);
  assert.equal(root(window).querySelector("[data-trace-sf-action='col-show-all']"), null);
  assert.equal(sheet(window), null, "showing all stays in the column");
});

test("on a phone a saved filter that is on gets a check, and the line says Showing with Clear", async () => {
  const { window, navigations } = await renderSavedFilters({ narrow: true, url: FILTERED_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  const current = root(window).querySelector(".trace-sf-col-row[aria-current='true']");
  assert.equal(current.getAttribute("data-id"), "p1");
  assert.ok(current.querySelector(".trace-sf-col-check svg"), "the ink check");
  assert.equal(current.getAttribute("aria-label"), "Long complete works. Complete · 50k+ words · By kudos. Showing now.");
  assert.equal(root(window).querySelector("[data-trace-sf-action='sheet-save']"), null, "these filters are already saved");

  const showing = line(window);
  const navigation = window.document.getElementById("go_to_filters").closest("div.navigation");
  assert.equal(showing.previousElementSibling, navigation, "the line sits right after AO3's button row");
  assert.equal(showing.closest(".actions"), null);
  assert.equal(showing.querySelector(".trace-sf-line-text").textContent, "Showing Long complete works");
  const main = showing.querySelector("[data-trace-sf-action='open-filters']");
  assert.equal(main.getAttribute("aria-label"), "Showing Long complete works. Open Filters");

  let opened = 0;
  window.document.getElementById("go_to_filters").addEventListener("click", (event) => {
    event.preventDefault();
    opened += 1;
  });
  main.click();
  await sleep(10);
  assert.equal(opened, 1, "the line opens AO3's own Filters");
  assert.equal(sheet(window), null);

  showing.querySelector("[data-trace-sf-action='clear-filters']").click();
  await sleep(10);
  assert.deepEqual(navigations, ["https://archiveofourown.org/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works"], "Clear follows AO3's own Clear Filters");
});

test("on a phone unsaved filters get a Filtered line with Save, and AO3's default sort alone gets none", async () => {
  const presets = phonePresets().filter((preset) => preset.id !== "p1");
  const { window } = await renderSavedFilters({ narrow: true, url: FILTERED_PAGE, storage: { [STORAGE_KEY]: presets } });
  assert.equal(root(window).querySelector("[data-trace-sf-action='sheet-save']").textContent, "Save these filters");
  const filtered = line(window);
  assert.equal(filtered.querySelector(".trace-sf-line-text").textContent, "Filtered: Complete · 50k+ words · By kudos");
  const save = filtered.querySelector("[data-trace-sf-action='sheet-save']");
  assert.equal(save.textContent, "Save");
  assert.equal(save.getAttribute("data-kind"), "primary");

  const plainSort = await renderSavedFilters({ narrow: true, url: `${TAG_PAGE}?work_search%5Bsort_column%5D=revised_at&commit=Sort+and+Filter`, storage: { [STORAGE_KEY]: presets } });
  assert.equal(line(plainSort.window), null);
  assert.equal(root(plainSort.window).querySelector("[data-trace-sf-action='sheet-save']"), null);
});

test("on a phone saving takes two taps: the name is optional and where it shows starts from what it keeps", async () => {
  const presets = phonePresets().filter((preset) => preset.id !== "p1");
  const { window, storageState, runtimeMessages } = await renderSavedFilters({ narrow: true, url: FILTERED_PAGE, storage: { [STORAGE_KEY]: presets } });
  window.document.getElementById("outer").classList.add("filtering");
  let left = 0;
  window.document.getElementById("leave_filters").addEventListener("click", (event) => {
    event.preventDefault();
    left += 1;
    window.document.getElementById("outer").classList.remove("filtering");
  });
  root(window).querySelector("[data-trace-sf-action='sheet-save']").click();
  await sleep(10);
  assert.equal(left, 1, "AO3's column closes before the sheet opens");
  const host = sheet(window);
  assert.equal(host.parentElement, window.document.documentElement, "the sheet sits outside AO3's body");
  assert.equal(host.querySelector("[role='dialog']").getAttribute("aria-modal"), "true");
  assert.ok(window.document.body.hasAttribute("inert"));
  assert.equal(host.querySelector(".trace-sf-sheet-title").textContent, "Save these filters");
  assert.equal(host.querySelector(".trace-sf-sheet-sub").textContent, "Only you see saved filters");
  assert.equal(host.querySelector(".trace-sf-sheet-close").getAttribute("aria-label"), "Close saved filters");
  const input = host.querySelector("[data-trace-sf-name]");
  assert.equal(input.value, "", "no name is filled in");
  assert.equal(input.getAttribute("placeholder"), "Complete · 50k+ words · By kudos");
  assert.equal(host.querySelector("label[for='trace-sf-name-input']").textContent, "NameOptional");
  assert.notEqual(window.document.activeElement, input, "the keyboard stays down");
  const cells = Array.from(host.querySelectorAll(".trace-sf-sheet-cell"));
  assert.deepEqual(cells.map((cell) => cell.textContent), ["This tagHarry Potter - J. K. Rowling", "Any tagEvery AO3 search"]);
  assert.deepEqual(cells.map((cell) => cell.getAttribute("aria-checked")), ["false", "true"], "nothing in it is about this tag");
  assert.equal(host.querySelector(".trace-sf-sheet-why").textContent, "Nothing in it is about this tag, so it starts on any tag.");
  assert.deepEqual(
    Array.from(host.querySelectorAll(".trace-sf-sheet-keep")).map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]),
    [["Status", "Complete only"], ["Words", "At least 50,000 words"], ["Sort", "Kudos"]],
  );
  assert.deepEqual(Array.from(host.querySelectorAll(".trace-sf-sheet-foot button")).map((button) => button.textContent), ["Save filter", "Cancel"]);
  const css = window.document.getElementById("trace-ao3-saved-filters-phone-style").textContent;
  assert.match(css, /\.trace-sf-sheet-input \{[^}]*font: 16px/, "16 px fields so Safari doesn't zoom");
  for (const [, size] of css.matchAll(/font-size:\s*([\d.]+)px/g)) {
    assert.ok(Number(size) >= 13, `font-size ${size}px is below the floor`);
  }

  host.querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);
  const saved = storageState[STORAGE_KEY].at(-1);
  assert.equal(saved.name, "Complete · 50k+ words · By kudos", "a blank name keeps what it keeps");
  assert.equal(saved.scope, "global");
  assert.equal(saved.contextKey, "");
  assert.equal(saved.dirty, true);
  assert.equal(storageState[ACTIVE_KEY].id, saved.id);
  assert.ok(storageState[LAST_USED_KEY].byId[saved.id]);
  assert.deepEqual(plain(runtimeMessages.at(-1)), { type: "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST" });
  assert.equal(sheet(window), null, "saving closes the sheet");
  assert.equal(line(window).querySelector(".trace-sf-line-text").textContent, "Showing Complete · 50k+ words");
  const savedRow = root(window).querySelector(`.trace-sf-col-row[data-id='${saved.id}']`);
  assert.equal(savedRow.querySelector(".trace-sf-col-name").textContent, "Complete · 50k+ words · By kudos", "an unnamed filter shows what it keeps once");
  assert.equal(savedRow.querySelector(".trace-sf-col-tokens").textContent, "Any tag");
  assert.equal(window.document.activeElement, line(window).querySelector(".trace-sf-line-main"), "focus lands on the line");
});

test("on a phone a filter that names tags starts on this tag, and a typed name and scope are kept", async () => {
  const url = `https://archiveofourown.org/works?work_search%5Bother_tag_names%5D=Slow+Burn&work_search%5Bcomplete%5D=T&tag_id=${TAG_ID}`;
  const { window, storageState } = await renderSavedFilters({ narrow: true, url, storage: { [STORAGE_KEY]: [] } });
  assert.equal(root(window).querySelector(".trace-sf-col-note"), null, "a page with filters offers Save, not the first-run note");
  line(window).querySelector("[data-trace-sf-action='sheet-save']").click();
  await sleep(10);
  const host = sheet(window);
  assert.equal(host.querySelector("[data-trace-sf-action='scope-context']").getAttribute("aria-checked"), "true");
  assert.equal(host.querySelector(".trace-sf-sheet-why").textContent, "It names tags to include, so it starts on this tag.");
  const field = host.querySelector("[data-trace-sf-name]");
  field.value = "Slow ones";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  host.querySelector("[data-trace-sf-action='scope-global']").click();
  await sleep(10);
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-why"), null, "the reason goes once the reader chooses");
  sheet(window).querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);
  const saved = storageState[STORAGE_KEY].at(-1);
  assert.equal(saved.name, "Slow ones");
  assert.equal(saved.scope, "global");
  assert.equal(line(window).querySelector(".trace-sf-line-text").textContent, "Showing Slow ones");
});

test("on a phone a changed saved filter gets one Save that asks New filter or Update, starting on New", async () => {
  const url = `https://archiveofourown.org/works?work_search%5Bsort_column%5D=bookmarks_count&work_search%5Bcomplete%5D=T&work_search%5Bwords_from%5D=50000&tag_id=${TAG_ID}`;
  const storage = {
    [STORAGE_KEY]: phonePresets(),
    [ACTIVE_KEY]: { id: "p1", signature: "applied", contextKey: HP_KEY, appliedAt: "2026-10-20T10:00:00.000Z" },
  };
  const { window, storageState } = await renderSavedFilters({ narrow: true, url, storage });
  assert.equal(line(window).querySelector(".trace-sf-line-text").textContent, "Changed from Long complete works");
  assert.equal(root(window).querySelector(".trace-sf-col-changed").textContent, "Changed on this page");
  line(window).querySelector("[data-trace-sf-action='sheet-save']").click();
  await sleep(10);
  let host = sheet(window);
  const asCells = Array.from(host.querySelectorAll("[data-trace-sf-action^='save-as-']"));
  assert.deepEqual(asCells.map((cell) => cell.textContent), ["New filterKeeps the original", "UpdateChanges “Long complete works”"]);
  assert.deepEqual(asCells.map((cell) => cell.getAttribute("aria-checked")), ["true", "false"], "nothing is overwritten by default");
  assert.ok(host.querySelector("[data-trace-sf-name]"));

  asCells[1].click();
  await sleep(10);
  host = sheet(window);
  assert.equal(host.querySelector(".trace-sf-sheet-title").textContent, "Update “Long complete works”");
  assert.equal(host.querySelector("[data-trace-sf-name]"), null, "an update keeps the name and where it shows");
  assert.equal(host.querySelector("[data-trace-sf-action='save-confirm']").textContent, "Update filter");
  host.querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);
  const updated = storageState[STORAGE_KEY].find((preset) => preset.id === "p1");
  assert.deepEqual(plain(updated.params), [["work_search[complete]", "T"], ["work_search[sort_column]", "bookmarks_count"], ["work_search[words_from]", "50000"]]);
  assert.equal(updated.name, "Long complete works");
  assert.equal(storageState[STORAGE_KEY].length, 5, "no new filter");
  assert.equal(sheet(window), null);
  assert.equal(line(window).querySelector(".trace-sf-line-text").textContent, "Showing Long complete works");
});

test("on a phone Edit lists every filter; one filter's page renames, moves and deletes after a confirm", async () => {
  const { window, storageState } = await renderSavedFilters({ narrow: true, url: FILTERED_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  root(window).querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  let host = sheet(window);
  assert.equal(host.querySelector(".trace-sf-sheet-title").textContent, "Saved filters");
  await until(() => window.document.activeElement === host.querySelector(".trace-sf-sheet-title"));
  assert.equal(window.document.activeElement, host.querySelector(".trace-sf-sheet-title"), "focus moves into the sheet");
  assert.match(host.getAttribute("style"), /--trace-page-teal:\s*#176E72/i, "light AO3 pages get light tokens");
  assert.deepEqual(Array.from(host.querySelectorAll(".trace-sf-sheet-group-label")).map((el) => el.textContent), ["This tag · Harry Potter - J. K. Rowling", "Any tag"]);
  assert.equal(host.querySelector(".trace-sf-sheet-sub").textContent, "All 5. Only you see these, on every device.");
  assert.deepEqual(Array.from(host.querySelectorAll(".trace-sf-sheet-row")).map((row) => row.getAttribute("data-id")), ["p1", "p2", "p5", "p3", "p4"]);
  assert.equal(host.querySelector(".trace-sf-sheet-row[data-id='p1'] .trace-sf-tokens").textContent, "Complete · 50k+ words · By kudos");
  const open = (id) => sheet(window).querySelector(`[data-trace-sf-action='sheet-edit'][data-id='${id}']`).click();

  open("p5");
  await sleep(10);
  host = sheet(window);
  assert.equal(host.querySelector(".trace-sf-sheet-title").textContent, "Marauders, no MCD");
  assert.equal(host.querySelector(".trace-sf-sheet-back").textContent, "Saved filters");
  assert.deepEqual(
    Array.from(host.querySelectorAll(".trace-sf-sheet-keep")).map((row) => row.querySelector("dt").textContent),
    ["Include", "Exclude", "Status", "Crossovers", "Words", "Language", "Sort"],
  );
  assert.equal(host.querySelector("[data-trace-sf-action='edit-in-ao3']").textContent, "Change what it keeps in AO3's Filters");
  assert.equal(host.querySelector("[data-trace-sf-action='update-current']"), null);
  assert.deepEqual(Array.from(host.querySelectorAll(".trace-sf-sheet-foot button")).map((button) => button.textContent), ["Save changes", "Cancel"]);
  const name = host.querySelector("[data-trace-sf-edit-name]");
  assert.equal(name.value, "Marauders, no MCD");
  name.value = "Marauders era";
  name.dispatchEvent(new window.Event("input", { bubbles: true }));
  host.querySelector("[data-trace-sf-action='edit-scope-global']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='edit-done']").click();
  await until(() => storageState[STORAGE_KEY].find((preset) => preset.id === "p5")?.name === "Marauders era");
  const renamed = storageState[STORAGE_KEY].find((preset) => preset.id === "p5");
  assert.equal(renamed.name, "Marauders era");
  assert.equal(renamed.scope, "global");
  assert.equal(renamed.contextKey, "");
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-title").textContent, "Saved filters");
  await until(() => window.document.activeElement === sheet(window).querySelector("[data-trace-sf-action='sheet-edit'][data-id='p5']"));
  assert.equal(window.document.activeElement, sheet(window).querySelector("[data-trace-sf-action='sheet-edit'][data-id='p5']"));

  open("p1");
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='sheet-back']").click();
  await sleep(10);
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-title").textContent, "Saved filters", "Cancel goes back to the list");
  await until(() => window.document.activeElement === sheet(window).querySelector("[data-trace-sf-action='sheet-edit'][data-id='p1']"));
  assert.equal(window.document.activeElement, sheet(window).querySelector("[data-trace-sf-action='sheet-edit'][data-id='p1']"));

  open("p3");
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='edit-scope-context']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='edit-done']").click();
  await until(() => storageState[STORAGE_KEY].find((preset) => preset.id === "p3")?.scope === "context");
  const scoped = storageState[STORAGE_KEY].find((preset) => preset.id === "p3");
  assert.equal(scoped.scope, "context");
  assert.equal(scoped.contextKey, `tagId:${TAG_ID.replace(/\+/g, " ")}`, "a filter moved to this tag takes this tag");

  open("p4");
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='delete-confirm']").click();
  await sleep(10);
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-confirm-title").textContent, "Delete “New this week”?");
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-confirm-detail").textContent, "It's deleted on every device. Nothing on AO3 changes.");
  await until(() => window.document.activeElement === sheet(window).querySelector(".trace-sf-sheet-confirm"));
  assert.equal(window.document.activeElement, sheet(window).querySelector(".trace-sf-sheet-confirm"), "focus moves to the question");
  sheet(window).querySelector("[data-trace-sf-action='delete-cancel']").click();
  await sleep(10);
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-confirm"), null);
  await until(() => window.document.activeElement === sheet(window).querySelector("[data-trace-sf-action='delete-confirm']"));
  assert.equal(window.document.activeElement, sheet(window).querySelector("[data-trace-sf-action='delete-confirm']"));
  sheet(window).querySelector("[data-trace-sf-action='delete-confirm']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='delete']").click();
  await until(() => !storageState[STORAGE_KEY].some((preset) => preset.id === "p4"));
  assert.equal(storageState[STORAGE_KEY].some((preset) => preset.id === "p4"), false);
  assert.equal(storageState[DELETED_KEY].at(-1).clientId, "p4");
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-title").textContent, "Saved filters");
});

const MARVEL_KEY = "tagPath:/tags/Marvel%20Cinematic%20Universe/works";

function otherTagPresets() {
  const ws = (field) => `work_search[${field}]`;
  const marvel = { scope: "context", contextKey: MARVEL_KEY, contextLabel: "Marvel Cinematic Universe", summary: [] };
  return [
    phonePresets().find((preset) => preset.id === "p1"),
    makePreset(Object.assign({}, marvel, { id: "m1", name: "Stucky, finished", params: [[ws("complete"), "T"], [ws("other_tag_names"), "Steve Rogers/Bucky Barnes"], [ws("sort_column"), "kudos_count"]] })),
    makePreset(Object.assign({}, marvel, { id: "m2", name: "Complete · English · 20k+ words", params: [[ws("complete"), "T"], [ws("language_id"), "en"], [ws("words_from"), "20000"]] })),
  ];
}

test("on a phone filters saved for other tags are never hidden without saying so", async () => {
  const { window, storageState, navigations } = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: { [STORAGE_KEY]: otherTagPresets() } });
  assert.deepEqual(columnIds(window), ["p1"], "the column stays about this tag");
  const others = root(window).querySelector("[data-trace-sf-action='sheet-open-others']");
  assert.equal(others.textContent, "2 more on other tags");
  others.click();
  await sleep(20);
  const host = sheet(window);
  assert.equal(host.querySelector(".trace-sf-sheet-sub").textContent, "All 3. Only you see these, on every device.");
  assert.deepEqual(Array.from(host.querySelectorAll(".trace-sf-sheet-group-label")).map((el) => el.textContent), ["This tag · Harry Potter - J. K. Rowling", "Marvel Cinematic Universe"]);
  assert.equal(host.querySelector("[data-trace-sf-action='open-other'][data-id='p1']"), null, "this tag's filters have no Open");
  const open = host.querySelector("[data-trace-sf-action='open-other'][data-id='m1']");
  assert.equal(open.textContent, "Open");
  assert.equal(open.getAttribute("aria-label"), "Open Stucky, finished on Marvel Cinematic Universe");
  assert.equal(host.querySelector(".trace-sf-sheet-row[data-id='m2'] .trace-sf-sheet-name").textContent, "Complete · English · 20k+ words", "a suggested name shows once");
  open.click();
  await sleep(40);
  const target = new URL(navigations.at(-1));
  assert.equal(target.pathname, "/tags/Marvel%20Cinematic%20Universe/works", "Open goes to the filter's own tag");
  assert.equal(target.searchParams.get("work_search[other_tag_names]"), "Steve Rogers/Bucky Barnes");
  assert.equal(storageState[ACTIVE_KEY].id, "m1");
  assert.equal(storageState[ACTIVE_KEY].contextKey, MARVEL_KEY);
  assert.equal(sheet(window), null);
});

test("on a phone another tag's filter can open there, run here once, or move to any tag", async () => {
  const { window, storageState, navigations } = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: { [STORAGE_KEY]: otherTagPresets() } });
  root(window).querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='sheet-edit'][data-id='m2']").click();
  await sleep(10);
  let host = sheet(window);
  assert.equal(host.querySelector(".trace-sf-sheet-sub").textContent, "Marvel Cinematic Universe");
  assert.deepEqual(Array.from(host.querySelectorAll(".trace-sf-sheet-link")).map((el) => el.textContent), [
    "Open on Marvel Cinematic Universe",
    "Use these filters on Harry Potter - J. K. Rowling",
    "Change what it keeps in AO3's Filters on Marvel Cinematic Universe",
    "Delete filter",
  ]);
  assert.deepEqual(Array.from(host.querySelectorAll(".trace-sf-sheet-cell")).map((cell) => cell.textContent), ["Its tagMarvel Cinematic Universe", "Any tagEvery AO3 search"]);
  assert.equal(host.querySelector("[data-trace-sf-action='edit-scope-context']").getAttribute("aria-checked"), "true");

  host.querySelector("[data-trace-sf-action='use-here']").click();
  await sleep(20);
  const here = new URL(navigations.at(-1));
  assert.equal(here.pathname, "/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works", "Use runs it on this tag");
  assert.equal(here.searchParams.get("work_search[words_from]"), "20000");
  assert.equal(storageState[STORAGE_KEY].find((preset) => preset.id === "m2").contextKey, MARVEL_KEY, "the filter stays on its tag");
  assert.equal(storageState[ACTIVE_KEY], undefined);

  root(window).querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='sheet-edit'][data-id='m2']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='edit-scope-global']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='edit-done']").click();
  await sleep(80);
  const moved = storageState[STORAGE_KEY].find((preset) => preset.id === "m2");
  assert.equal(moved.scope, "global");
  assert.equal(moved.contextKey, "");
  sheet(window).querySelector(".trace-sf-sheet-close").click();
  await sleep(10);
  assert.deepEqual(columnIds(window), ["p1", "m2"], "an any-tag filter shows here");
  assert.equal(root(window).querySelector("[data-trace-sf-action='sheet-open-others']").textContent, "1 more on other tags");

  root(window).querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='sheet-edit'][data-id='m1']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='edit-in-ao3']").click();
  await sleep(40);
  assert.equal(new URL(navigations.at(-1)).pathname, "/tags/Marvel%20Cinematic%20Universe/works", "it's changed on its own tag's Filters");
  assert.equal(JSON.parse(window.sessionStorage.getItem("traceAo3SavedFilterEditing")).contextKey, MARVEL_KEY);
});

test("on a phone a tag with none of its own still points to the others", async () => {
  const marvelOnly = otherTagPresets().filter((preset) => preset.id !== "p1");
  const { window } = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: { [STORAGE_KEY]: marvelOnly } });
  const mount = root(window);
  assert.equal(mount.querySelector(".trace-sf-col-row"), null);
  assert.equal(mount.querySelector(".trace-sf-col-note").textContent, "None for this tag yet.");
  assert.equal(mount.querySelector("[data-trace-sf-action='sheet-open-others']").textContent, "2 on other tags");
  assert.ok(mount.querySelector("[data-trace-sf-action='sheet-open']"), "Edit reaches every filter");
});

test("on a phone the sheet closes on Escape and returns focus to what opened it", async () => {
  const { window } = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  root(window).querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  sheet(window).querySelector(".trace-sf-sheet-title").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(10);
  assert.equal(sheet(window), null);
  assert.equal(window.document.body.hasAttribute("inert"), false);
  assert.equal(window.document.activeElement, root(window).querySelector("[data-trace-sf-action='sheet-open']"));
});

test("on a phone what a filter keeps is changed in AO3's own Filters, then Save changes", async () => {
  const first = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  root(first.window).querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  sheet(first.window).querySelector("[data-trace-sf-action='sheet-edit'][data-id='p2']").click();
  await sleep(10);
  sheet(first.window).querySelector("[data-trace-sf-action='edit-in-ao3']").click();
  await sleep(40);
  assert.equal(sheet(first.window), null);
  assert.equal(first.navigations.length, 1, "the filter loads into AO3's form");
  const marker = first.window.sessionStorage.getItem(EDITING_SESSION_KEY);
  assert.equal(JSON.parse(marker).id, "p2");
  assert.equal(JSON.parse(marker).opened, false, "Filters opens on the loaded page, not this one");

  // The loaded page: the column says what's being edited, and Filters opens.
  const { window, storageState, navigations } = await renderSavedFilters({
    narrow: true,
    url: first.navigations[0],
    storage: first.storageState,
    session: { [EDITING_SESSION_KEY]: marker },
  });
  let opened = 0;
  window.document.getElementById("go_to_filters").addEventListener("click", (event) => {
    event.preventDefault();
    opened += 1;
  });
  await sleep(300);
  assert.equal(opened, 1, "AO3's Filters opens by itself once");
  const mount = root(window);
  assert.equal(mount.querySelector(".trace-sf-col-note").textContent, "Editing Slow burn, finished. Change anything below, then save.");
  assert.equal(mount.querySelector("[data-trace-sf-action='sheet-open']"), null, "no Edit while editing");
  assert.equal(mount.querySelector(".trace-sf-col-row"), null);
  assert.deepEqual(Array.from(mount.querySelectorAll(".trace-sf-col-link")).map((button) => button.textContent), ["Save changes", "Cancel"]);

  window.document.getElementById("work_search_words_from").value = "10000";
  mount.querySelector("[data-trace-sf-action='editing-save']").click();
  await sleep(80);
  const edited = storageState[STORAGE_KEY].find((preset) => preset.id === "p2");
  assert.ok(edited.params.some((pair) => pair[0] === "work_search[words_from]" && pair[1] === "10000"), "what's in AO3's form is kept");
  assert.equal(edited.dirty, true);
  assert.equal(storageState[ACTIVE_KEY].id, "p2");
  assert.equal(window.sessionStorage.getItem(EDITING_SESSION_KEY), null);
  assert.equal(new URL(navigations.at(-1)).searchParams.get("work_search[words_from]"), "10000", "AO3 shows the edited filter");
});

test("on a phone Cancel leaves editing without changing the filter", async () => {
  const marker = JSON.stringify({ id: "p1", at: Date.now(), contextKey: HP_KEY, opened: true });
  const { window, storageState } = await renderSavedFilters({ narrow: true, url: FILTERED_PAGE, storage: { [STORAGE_KEY]: phonePresets() }, session: { [EDITING_SESSION_KEY]: marker } });
  const before = plain(storageState[STORAGE_KEY]);
  root(window).querySelector("[data-trace-sf-action='editing-cancel']").click();
  await sleep(20);
  assert.equal(window.sessionStorage.getItem(EDITING_SESSION_KEY), null);
  assert.deepEqual(plain(storageState[STORAGE_KEY]), before);
  assert.ok(root(window).querySelector(".trace-sf-col-row[data-id='p1'][aria-current='true']"), "the column is back");

  const stale = JSON.stringify({ id: "p1", at: Date.now() - 60 * 60 * 1000, contextKey: HP_KEY, opened: true });
  const old = await renderSavedFilters({ narrow: true, url: FILTERED_PAGE, storage: { [STORAGE_KEY]: phonePresets() }, session: { [EDITING_SESSION_KEY]: stale } });
  assert.equal(root(old.window).querySelector("[data-trace-sf-action='editing-save']"), null, "an old edit has lapsed");
});

test("on a phone the first run is one sentence", async () => {
  const { window } = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: {} });
  assert.equal(root(window).querySelector(".trace-sf-col-note").textContent, "Filter below, then save it here to use again in one tap.");
  assert.equal(root(window).querySelector("[data-trace-sf-action='sheet-open']"), null);
});

test("on a phone a long token line shows what fits, then +n", async () => {
  const { window } = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  // About 7 px a character in a 300 px line.
  Object.defineProperty(window.HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return this.textContent.length * 7; } });
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 300; } });
  root(window).querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  const row = sheet(window).querySelector(".trace-sf-sheet-row[data-id='p5']");
  assert.equal(row.querySelector(".trace-sf-tokens").textContent, "Remus Lupin/Sirius Black · Marauders Era +6");
  assert.match(row.getAttribute("aria-label"), /Excludes 3 tags · English · No crossovers · By kudos\.$/, "VoiceOver hears every token");
});

test("on a computer or iPad the same design shows in AO3's sidebar, and forms open in a centred card", async () => {
  const { window } = await renderSavedFilters({ url: FILTERED_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  const mount = root(window);
  assert.ok(mount.querySelector(".trace-sf-col"), "the same section as on a phone");
  assert.equal(mount.querySelector(".trace-sf-card"), null, "the 1.0 panel is gone");
  assert.equal(mount.querySelector(".trace-sf-col-row[aria-current='true']").getAttribute("data-id"), "p1");
  const css = window.document.getElementById("trace-ao3-saved-filters-phone-style").textContent;
  assert.match(css, /@media \(min-width: 42\.01em\) \{[\s\S]*\.trace-sf-sheet \{[^}]*top: 50%;[^}]*transform: translate\(-50%, -50%\);/, "the sheet is a centred card");
  assert.match(css, /\.trace-sf-grabber \{ display: none; \}/, "no grabber on a card");
  assert.match(css, /\.trace-sf-col-row:hover \.trace-sf-col-name[^{]*\{ text-decoration: underline;/, "names underline on hover like AO3's links");

  // The sidebar is always there: the line brings Trace's section into focus
  // instead of AO3's phone-only Filters button.
  let opened = 0;
  window.document.getElementById("go_to_filters").addEventListener("click", (event) => {
    event.preventDefault();
    opened += 1;
  });
  line(window).querySelector("[data-trace-sf-action='open-filters']").click();
  await sleep(10);
  assert.equal(opened, 0);
  assert.equal(window.document.activeElement, mount.querySelector("button"), "focus moves to the saved filters");

  mount.querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  assert.ok(sheet(window).querySelector("[role='dialog'][aria-modal='true']"), "Edit opens the same list");
});
