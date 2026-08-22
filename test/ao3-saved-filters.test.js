const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
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
const PREF_AO3_SAVED_FILTERS_KEY = "prefAo3SavedFiltersEnabled";

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
} = {}) {
  const script = fs.readFileSync(SCRIPT_PATH, "utf8");
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    contentType: "text/html",
  });
  const { window } = dom;
  const storageState = Object.assign({}, storage);
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
          if (setErrorMessage) {
            chrome.runtime.lastError = { message: setErrorMessage };
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

test("manifest loads AO3 saved filters with existing archive content scripts", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const archiveEntry = manifest.content_scripts.find((entry) =>
    (entry.js || []).includes("collector.js"),
  );
  const savedFiltersEntry = manifest.content_scripts.find((entry) =>
    (entry.js || []).includes("ao3-saved-filters.js"),
  );
  assert.ok(archiveEntry, "expected archive content script entry");
  assert.ok(savedFiltersEntry, "expected AO3 saved filters content script entry");
  assert.deepEqual(archiveEntry.js, [
    "content-config.js",
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

test("AO3 saved filters saves normalized current URL params locally", async () => {
  const { window, storageState, runtimeMessages } = await renderSavedFilters();
  const form = window.document.getElementById("work-filters");
  const fieldset = form.querySelector("fieldset");
  const mount = root(window);

  assert.ok(mount, "expected saved filters module");
  assert.equal(mount.parentElement, fieldset, "module should sit inside AO3's raised filter fieldset");
  assert.equal(mount.previousElementSibling.tagName, "LEGEND", "module should preserve the fieldset legend");
  assert.equal(mount.nextElementSibling.tagName, "DL", "module should stay above the AO3 filter controls");
  assert.match(mount.textContent, /These filters aren't saved/);
  assert.equal(
    mount.querySelectorAll("[data-trace-sf-action='save-open']").length,
    1,
    "unsaved filters should expose one save action",
  );
  assert.doesNotMatch(
    mount.textContent,
    /Save current filters/,
    "unsaved filters should not duplicate the primary save action in the footer",
  );

  mount.querySelector("[data-trace-sf-action='save-open']").click();
  await sleep(0);
  const nameInput = mount.querySelector("[data-trace-sf-name]");
  assert.ok(nameInput, "expected inline save form");
  assert.equal(nameInput.value, "", "save name should start empty for direct typing");
  assert.match(
    nameInput.getAttribute("placeholder") || "",
    /Complete works only/,
    "generated name should be a placeholder suggestion",
  );
  assert.equal(
    mount.querySelectorAll("[data-trace-sf-action='save-open']").length,
    0,
    "save mode should not keep duplicate save-open buttons",
  );
  assert.doesNotMatch(
    mount.textContent,
    /Save a filter to reuse it/,
    "save mode should not render the empty state below the form",
  );
  nameInput.value = "Temporary custom name";
  nameInput.dispatchEvent(new window.Event("input", { bubbles: true, cancelable: true }));
  mount.querySelector("[data-trace-sf-action='name-clear']").click();
  await sleep(0);
  assert.equal(
    mount.querySelector("[data-trace-sf-name]").value,
    "",
    "clear control should reset back to the placeholder fallback",
  );
  const refreshedNameInput = mount.querySelector("[data-trace-sf-name]");
  refreshedNameInput.value = "Long complete Bakudeku";
  mount.querySelector("[data-trace-sf-action='save-confirm']").click();
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
  assert.deepEqual(plain(runtimeMessages.at(-1)), {
    type: "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST",
  });
  assert.match(mount.textContent, /Showing\s+Long complete Bakudeku/);
  assert.equal(
    mount.querySelectorAll(".trace-sf-badge").length,
    0,
    "row status should not render title-squeezing badge pills",
  );
  assert.doesNotMatch(
    mount.textContent,
    /Save current filters/,
    "active filters should not show the lower save-current affordance",
  );
});

test("AO3 saved filters uses the suggested placeholder when saving without a custom name", async () => {
  const { window, storageState } = await renderSavedFilters();
  const mount = root(window);

  mount.querySelector("[data-trace-sf-action='save-open']").click();
  await sleep(0);
  const nameInput = mount.querySelector("[data-trace-sf-name]");
  const suggestedName = nameInput.getAttribute("placeholder");
  assert.ok(suggestedName, "expected generated placeholder name");
  assert.equal(nameInput.value, "");

  mount.querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);

  assert.equal(storageState[STORAGE_KEY].length, 1);
  assert.equal(storageState[STORAGE_KEY][0].name, suggestedName);
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

test("AO3 saved filters applies context presets to the current tag context", async () => {
  const preset = makePreset();
  const { window, storageState, navigations } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto",
    storage: {
      [STORAGE_KEY]: [preset],
    },
  });

  root(window).querySelector(".trace-sf-main").click();
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
    storage: {
      [STORAGE_KEY]: [preset],
    },
  });

  root(window).querySelector(".trace-sf-main").click();
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

test("AO3 saved filters shows global presets plus matching current-tag presets", async () => {
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto&work_search%5Bsort_column%5D=kudos_count",
    storage: {
      [STORAGE_KEY]: [
        makePreset({
          id: "context-naruto",
          name: "Naruto context filter",
          scope: "context",
          contextKey: "tagId:Naruto",
          contextLabel: "Naruto",
        }),
        makePreset({
          id: "context-avatar",
          name: "Avatar context filter",
          scope: "context",
          contextKey: "tagId:Avatar: The Last Airbender",
          contextLabel: "Avatar: The Last Airbender",
        }),
        makePreset({
          id: "global-a",
          name: "Reusable anywhere filter",
          scope: "global",
        }),
      ],
    },
  });
  const mount = root(window);

  assert.match(mount.textContent, /Naruto context filter/);
  assert.match(mount.textContent, /Current tag/);
  assert.match(mount.textContent, /Global/);
  assert.doesNotMatch(mount.textContent, /Avatar context filter/);
  assert.doesNotMatch(mount.textContent, /Reusable anywhere filter/);
  assert.equal(mount.querySelector(".trace-sf-group[data-group='context']").getAttribute("data-collapsed"), "false");
  assert.equal(mount.querySelector(".trace-sf-group[data-group='global']").getAttribute("data-collapsed"), "true");
  assert.equal(mount.querySelectorAll(".trace-sf-row").length, 1);

  mount.querySelector(".trace-sf-group[data-group='global'] [data-trace-sf-action='toggle-group']").click();
  await sleep(0);

  assert.match(mount.textContent, /Reusable anywhere filter/);
  assert.equal(mount.querySelectorAll(".trace-sf-row").length, 2);
});

test("AO3 saved filters keeps Trace control events away from AO3 filter handlers", async () => {
  const { window, emitStorageChange } = await renderSavedFilters();
  const mount = root(window);
  const form = window.document.getElementById("work-filters");
  const saveButton = mount.querySelector("[data-trace-sf-action='save-open']");
  let formClicks = 0;
  let documentClicks = 0;
  let documentMouseDowns = 0;
  let documentMouseUps = 0;
  let documentPointerDowns = 0;
  let documentPointerUps = 0;
  let documentTouchEnds = 0;
  let documentKeydowns = 0;

  form.addEventListener("click", () => {
    formClicks += 1;
  });
  window.document.addEventListener("click", () => {
    documentClicks += 1;
  });
  window.document.addEventListener("pointerdown", () => {
    documentPointerDowns += 1;
  });
  window.document.addEventListener("pointerup", () => {
    documentPointerUps += 1;
  });
  window.document.addEventListener("mousedown", () => {
    documentMouseDowns += 1;
  });
  window.document.addEventListener("mouseup", () => {
    documentMouseUps += 1;
  });
  window.document.addEventListener("touchend", () => {
    documentTouchEnds += 1;
  });
  window.document.addEventListener("keydown", () => {
    documentKeydowns += 1;
  });

  saveButton.dispatchEvent(new window.Event("pointerdown", {
    bubbles: true,
    cancelable: true,
  }));
  saveButton.dispatchEvent(new window.Event("pointerup", {
    bubbles: true,
    cancelable: true,
  }));
  saveButton.dispatchEvent(new window.Event("mousedown", {
    bubbles: true,
    cancelable: true,
  }));
  saveButton.dispatchEvent(new window.Event("mouseup", {
    bubbles: true,
    cancelable: true,
  }));
  saveButton.dispatchEvent(new window.Event("touchstart", {
    bubbles: true,
    cancelable: true,
  }));
  saveButton.dispatchEvent(new window.Event("touchend", {
    bubbles: true,
    cancelable: true,
  }));
  saveButton.click();
  await sleep(0);

  assert.equal(formClicks, 0);
  assert.equal(documentClicks, 0);
  assert.equal(documentMouseDowns, 0);
  assert.equal(documentMouseUps, 0);
  assert.equal(documentPointerDowns, 0);
  assert.equal(documentPointerUps, 0);
  assert.equal(documentTouchEnds, 0);
  assert.ok(mount.querySelector("[data-trace-sf-name]"), "Trace action should still run");

  const nameInput = mount.querySelector("[data-trace-sf-name]");
  nameInput.value = "Mobile drawer should stay open";
  nameInput.dispatchEvent(new window.Event("input", { bubbles: true, cancelable: true }));
  nameInput.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
  nameInput.dispatchEvent(new window.Event("pointerup", { bubbles: true, cancelable: true }));
  nameInput.dispatchEvent(new window.Event("mousedown", { bubbles: true, cancelable: true }));
  nameInput.dispatchEvent(new window.Event("mouseup", { bubbles: true, cancelable: true }));
  nameInput.dispatchEvent(new window.Event("touchstart", { bubbles: true, cancelable: true }));
  nameInput.dispatchEvent(new window.Event("touchend", { bubbles: true, cancelable: true }));
  nameInput.click();
  nameInput.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "M",
    bubbles: true,
    cancelable: true,
  }));
  await sleep(0);

  assert.equal(formClicks, 0);
  assert.equal(documentClicks, 0);
  assert.equal(documentMouseDowns, 0);
  assert.equal(documentMouseUps, 0);
  assert.equal(documentPointerDowns, 0);
  assert.equal(documentPointerUps, 0);
  assert.equal(documentTouchEnds, 0);
  assert.equal(documentKeydowns, 0);

  emitStorageChange({
    [ACTIVE_KEY]: {
      oldValue: null,
      newValue: null,
    },
  });
  await sleep(80);
  assert.equal(
    mount.querySelector("[data-trace-sf-name]").value,
    "Mobile drawer should stay open",
    "draft name should survive storage-triggered rerenders while editing",
  );
});

test("AO3 saved filters uses a compact AO3-native drawer section", async () => {
  const { window, storageState } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?work_search%5Bsort_column%5D=kudos_count&work_search%5Bcomplete%5D=T&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling",
    storage: {
      [STORAGE_KEY]: [makePreset()],
    },
  });
  const mount = root(window);
  const style = window.document.getElementById("trace-ao3-saved-filters-style");
  assert.ok(style);
  assert.equal(
    mount.querySelector(".trace-sf-card").getAttribute("data-panel-collapsed"),
    "true",
    "matched saved-filter state should start collapsed in narrow AO3 drawers",
  );
  assert.equal(
    mount.querySelector("[data-trace-sf-action='toggle-panel']").getAttribute("aria-expanded"),
    "false",
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-card \{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*border-bottom:\s*1px solid #cfcec9;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-card\[data-panel-collapsed='true'\] \.trace-sf-panel \{[^}]*display:\s*none;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-list \{[^}]*background:\s*transparent;[^}]*border-top:\s*1px solid #dcdbd6;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-summary \{[^}]*font-size:\s*0\.66rem;[^}]*-webkit-line-clamp:\s*2;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-head \{[^}]*grid-template-columns:\s*0\.62rem 1\.18rem max-content minmax\(0, 1fr\);[^}]*grid-template-rows:\s*auto auto;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-panel-caret \{[^}]*display:\s*inline-flex;[^}]*grid-column:\s*1;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-head-text \{[^}]*display:\s*contents;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-title-line \{[^}]*grid-column:\s*3;[^}]*min-width:\s*max-content;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-head-actions \{[^}]*display:\s*none;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-head-meta \{[^}]*display:\s*block;[^}]*grid-column:\s*3 \/ 5;[^}]*grid-row:\s*2;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-title \{[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip;[^}]*white-space:\s*nowrap;/,
  );
  assert.match(
    style.textContent,
    /@media \(max-width: 720px\) \{[\s\S]*?\.trace-sf-status-main \{[^}]*white-space:\s*normal;/,
  );
  assert.match(
    style.textContent,
    /\.trace-sf-btn \{[^}]*background-image:\s*linear-gradient\(#fbfbfb, #e0e0dd\);[^}]*min-height:\s*2\.05rem;/,
  );
  assert.match(
    style.textContent,
    /button\.trace-sf-head:focus,[\s\S]*?\.trace-sf-group-head:focus,[\s\S]*?\.trace-sf-main:focus \{[^}]*outline:\s*0;/,
    "Trace controls should suppress AO3/browser default dotted focus outlines",
  );
  assert.match(
    style.textContent,
    /button\.trace-sf-head:focus-visible,[\s\S]*?\.trace-sf-group-head:focus-visible,[\s\S]*?\.trace-sf-main:focus-visible \{[^}]*box-shadow:\s*inset 0 0 0 2px rgba\(31,92,69,0\.32\);[^}]*outline:\s*0;/,
    "keyboard focus should use a controlled inset focus treatment instead of the dotted outline",
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-status-actions \{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(7\.25rem, 1fr\)\);/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-status-actions \.trace-sf-btn \{[^}]*min-height:\s*2\.55rem;/,
  );
  assert.match(
    style.textContent,
    /@container \(max-width: 480px\) \{[\s\S]*?\.trace-sf-name \{[^}]*font-size:\s*0\.82rem;[^}]*white-space:\s*normal;[^}]*-webkit-line-clamp:\s*2;/,
  );
  assert.match(
    style.textContent,
    /\.trace-sf-row:hover \{[^}]*background: #e7e6e1;/,
    "desktop hover should apply to the full row, not just the inner text button",
  );
  assert.match(
    style.textContent,
    /\.trace-sf-row\[data-active='true'\] \{[^}]*background: #e9f2ec;/,
    "desktop active row should use the same pale tint as the Claude native section",
  );
  const desktopActiveRowRule = style.textContent.match(/\.trace-sf-row\[data-active='true'\] \{([^}]*)\}/);
  assert.ok(desktopActiveRowRule);
  assert.doesNotMatch(
    desktopActiveRowRule[1],
    /box-shadow/,
    "desktop active row should not bleed into AO3's framed filter-section edge",
  );
  const desktopActiveStatusRule = style.textContent.match(/\.trace-sf-status\[data-kind='active'\] \{([^}]*)\}/);
  assert.ok(desktopActiveStatusRule);
  assert.doesNotMatch(
    desktopActiveStatusRule[1],
    /box-shadow/,
    "desktop active status strip should respect AO3's framed filter-section edge",
  );
  assert.match(
    style.textContent,
    /@media \(max-width: 720px\) \{[\s\S]*?\.trace-sf-row\[data-active='true'\] \{[^}]*box-shadow: -0\.86rem 0 0 #e9f2ec, 0\.86rem 0 0 #e9f2ec;/,
    "mobile active row tint should keep the wider strip treatment",
  );
  assert.match(
    style.textContent,
    /@media \(max-width: 720px\) \{[\s\S]*?\.trace-sf-status\[data-kind='active'\] \{[^}]*box-shadow: -0\.86rem 0 0 #e9f2ec, 0\.86rem 0 0 #e9f2ec;/,
    "mobile active status tint should keep the wider strip treatment",
  );
  assert.equal(
    mount.querySelector(".trace-sf-head-actions > .trace-sf-count").textContent,
    "1",
    "desktop saved-filter count should stay in the reserved header action cluster",
  );
  assert.match(
    mount.querySelector(".trace-sf-head-meta").textContent,
    /Showing\s+Long complete/,
    "collapsed narrow header should move status to the second line instead of a right-edge badge",
  );
  assert.equal(
    mount.querySelector(".trace-sf-head-actions > .trace-sf-panel-caret"),
    null,
    "collapse affordance should not share the right-side count cluster",
  );
  assert.equal(
    mount.querySelector(".trace-sf-title-line > .trace-sf-count"),
    null,
    "saved-filter count should not share the flexible title line with the collapse affordance",
  );
  assert.equal(
    mount.querySelector(".trace-sf-head").getAttribute("data-collapsible"),
    "true",
  );
  assert.deepEqual(
    Array.from(mount.querySelector(".trace-sf-head").children).map((child) => child.className),
    [
      "trace-sf-panel-caret",
      "trace-sf-mark",
      "trace-sf-head-text",
      "trace-sf-spacer",
      "trace-sf-head-actions",
      "trace-sf-head-meta",
    ],
    "narrow header should order the collapse affordance before the mark/title and second-line meta",
  );
  assert.equal(
    mount.querySelector(".trace-sf-panel-caret").getAttribute("data-collapsed"),
    "true",
    "collapsed saved-filter panel should expose the left-side chevron affordance",
  );
  assert.ok(
    mount.querySelector(".trace-sf-panel-caret svg path"),
    "collapsed saved-filter panel should use an AO3-like chevron instead of a text plus",
  );
  assert.ok(
    mount.querySelector(".trace-sf-group-caret svg path"),
    "saved-filter groups should use the same SVG affordance style as the panel header",
  );
  assert.equal(
    mount.querySelector(".trace-sf-title").textContent,
    "Saved filters",
    "saved-filter title should remain intact in narrow headers",
  );
  assert.equal(
    mount.querySelector(".trace-sf-mark").textContent,
    "",
    "saved-filter header should not render the old text placeholder mark",
  );
  assert.equal(
    mount.querySelector(".trace-sf-mark svg rect").getAttribute("fill"),
    "#16342D",
    "saved-filter header should render the real Trace mark colors",
  );
  mount.querySelector("[data-trace-sf-action='toggle-panel']").click();
  await sleep(0);
  assert.equal(mount.querySelector(".trace-sf-card").getAttribute("data-panel-collapsed"), "false");
  assert.equal(
    mount.querySelector(".trace-sf-panel-caret").getAttribute("data-collapsed"),
    "false",
    "expanded saved-filter panel should rotate the left-side chevron affordance",
  );
  assert.equal(
    mount.querySelector(".trace-sf-head-meta").textContent,
    "1 saved filter",
    "expanded narrow header should show count metadata instead of duplicating the Showing state",
  );
  assert.match(mount.querySelector(".trace-sf-status").textContent, /Showing\s+Long complete/);
  assert.equal(storageState[PANEL_COLLAPSED_KEY], false);
  assert.equal(
    mount.querySelector("[data-trace-sf-action='toggle-panel']").getAttribute("aria-expanded"),
    "true",
  );

  const nextRender = await renderSavedFilters({
    url: "https://archiveofourown.org/works?work_search%5Bsort_column%5D=kudos_count&work_search%5Bcomplete%5D=T&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling",
    storage: storageState,
  });
  assert.equal(
    root(nextRender.window).querySelector(".trace-sf-card").getAttribute("data-panel-collapsed"),
    "false",
    "expanded saved-filter panel should remain expanded after a page reload",
  );
});

test("AO3 saved filters lets users collapse the active Current tag group", async () => {
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?work_search%5Bsort_column%5D=kudos_count&work_search%5Bcomplete%5D=T&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling",
    storage: {
      [STORAGE_KEY]: [makePreset()],
    },
  });
  const mount = root(window);
  const contextGroup = mount.querySelector(".trace-sf-group[data-group='context']");

  assert.equal(contextGroup.getAttribute("data-collapsed"), "false");
  assert.ok(contextGroup.querySelector(".trace-sf-group-body"));

  contextGroup.querySelector("[data-trace-sf-action='toggle-group']").click();
  await sleep(0);

  const updatedContextGroup = mount.querySelector(".trace-sf-group[data-group='context']");
  assert.equal(updatedContextGroup.getAttribute("data-collapsed"), "true");
  assert.equal(updatedContextGroup.querySelector(".trace-sf-group-body"), null);
});

test("AO3 saved filters shows edited state and can update the applied preset", async () => {
  const preset = makePreset({
    params: [["work_search[complete]", "T"]],
    summary: ["Status: Complete works only"],
  });
  const activeMeta = {
    id: preset.id,
    signature: JSON.stringify(preset.params),
    contextKey: "tagId:Naruto",
    appliedAt: "2026-06-18T00:00:00.000Z",
  };
  const { window, storageState } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto&work_search%5Bcomplete%5D=T&work_search%5Bwords_to%5D=5000",
    storage: {
      [STORAGE_KEY]: [preset],
      [ACTIVE_KEY]: activeMeta,
    },
  });
  const mount = root(window);

  assert.match(mount.textContent, /Long complete edited/);
  mount.querySelector("[data-trace-sf-action='update-current']").click();
  await sleep(80);

  assert.deepEqual(plain(storageState[STORAGE_KEY][0].params), [
    ["work_search[complete]", "T"],
    ["work_search[words_to]", "5000"],
  ]);
  assert.equal(storageState[ACTIVE_KEY].id, "preset-a");
  assert.match(mount.textContent, /Showing\s+Long complete/);
});

test("AO3 saved filters keeps large preset lists in an internal scroll region", async () => {
  const presets = Array.from({ length: 12 }, (_, index) => makePreset({
    id: `preset-${index}`,
    name: `Saved filter ${index + 1}`,
    scope: index % 2 === 0 ? "context" : "global",
  }));
  const { window } = await renderSavedFilters({
    storage: {
      [STORAGE_KEY]: presets,
    },
  });
  const mount = root(window);
  const list = mount.querySelector(".trace-sf-list");
  const style = window.document.getElementById("trace-ao3-saved-filters-style");

  assert.ok(list, "expected saved preset list");
  assert.equal(list.querySelector(".trace-sf-group[data-group='context'] .trace-sf-group-count").textContent, "6");
  assert.equal(list.querySelector(".trace-sf-group[data-group='global'] .trace-sf-group-count").textContent, "6");
  assert.equal(list.querySelector(".trace-sf-group[data-group='context']").getAttribute("data-collapsed"), "false");
  assert.equal(list.querySelector(".trace-sf-group[data-group='global']").getAttribute("data-collapsed"), "true");
  assert.equal(list.querySelectorAll(".trace-sf-row").length, 6);
  assert.equal(list.querySelectorAll(".trace-sf-row[data-scope='context']").length, 6);
  assert.equal(list.querySelectorAll(".trace-sf-row[data-scope='global']").length, 0);
  assert.equal(mount.querySelectorAll(".trace-sf-badge").length, 0);
  assert.match(style.textContent, /\.trace-sf-list \{[^}]*max-height: 22rem/s);
  assert.match(style.textContent, /\.trace-sf-list \{[^}]*overflow-y: auto/s);
  assert.match(style.textContent, /\.trace-sf-row\[data-active='true'\] \.trace-sf-edge \{[^}]*background: #2f7d5b/s);
  assert.doesNotMatch(
    style.textContent,
    /\.trace-sf-row\[data-scope='context'\] \.trace-sf-edge/,
    "scope should not reuse the active row stripe",
  );
  assert.doesNotMatch(mount.textContent, /Global\s+Status: Complete works only/);

  list.querySelector(".trace-sf-group[data-group='global'] [data-trace-sf-action='toggle-group']").click();
  await sleep(0);
  const updatedList = mount.querySelector(".trace-sf-list");

  assert.equal(updatedList.querySelector(".trace-sf-group[data-group='global']").getAttribute("data-collapsed"), "false");
  assert.equal(updatedList.querySelectorAll(".trace-sf-row").length, 12);
  assert.equal(updatedList.querySelectorAll(".trace-sf-row[data-scope='global']").length, 6);
});

test("AO3 saved filters blocks new saves at the active preset cap", async () => {
  const presets = Array.from({ length: 250 }, (_, index) => makePreset({
    id: `preset-cap-${index}`,
    name: `Saved filter ${index + 1}`,
    scope: "context",
  }));
  const { window } = await renderSavedFilters({
    storage: {
      [STORAGE_KEY]: presets,
    },
  });
  const mount = root(window);

  assert.match(mount.textContent, /Saved filter limit reached/);
  assert.equal(
    mount.querySelector("[data-trace-sf-action='save-open']"),
    null,
  );
});

test("AO3 saved filters warns before the active preset cap", async () => {
  const presets = Array.from({ length: 200 }, (_, index) => makePreset({
    id: `preset-warning-${index}`,
    name: `Saved filter ${index + 1}`,
    scope: "context",
  }));
  const { window } = await renderSavedFilters({
    storage: {
      [STORAGE_KEY]: presets,
    },
  });
  const mount = root(window);

  mount.querySelector("[data-trace-sf-action='save-open']").click();
  await sleep(0);

  assert.match(mount.textContent, /200 of 250 saved filters used/);
  assert.ok(mount.querySelector("[data-trace-sf-action='save-confirm']"));
});

test("AO3 saved filters caps oversized summary text", async () => {
  const longSummary = Array.from({ length: 8 }, (_, index) =>
    `Include: Very Long Relationship Or Freeform Tag Name That Keeps Going ${index}`,
  );
  const { window } = await renderSavedFilters({
    storage: {
      [STORAGE_KEY]: [makePreset({
        id: "global-long-summary",
        name: "Long summary filter",
        scope: "global",
        summary: longSummary,
      })],
    },
  });
  const summary = root(window).querySelector(".trace-sf-summary");
  const summaryText = summary.textContent;
  const summaryTitle = summary.getAttribute("title");

  assert.ok(summaryText.length <= 240, "visible summary should stay bounded");
  assert.ok(summaryTitle.length <= 240, "summary tooltip should stay bounded");
  assert.match(summaryText, /\+4 more/);
  assert.doesNotMatch(summaryText, /Keeps Going 0/);
});

test("AO3 saved filters auto-expands a group containing the active preset", async () => {
  const contextPreset = makePreset({
    id: "context-other",
    name: "Current tag unread",
    scope: "context",
    contextKey: "tagId:Naruto",
    contextLabel: "Naruto",
    params: [["work_search[complete]", "T"]],
  });
  const globalPreset = makePreset({
    id: "global-active",
    name: "Global kudos",
    scope: "global",
    params: [["work_search[sort_column]", "kudos_count"]],
  });
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto&work_search%5Bsort_column%5D=kudos_count",
    storage: {
      [STORAGE_KEY]: [contextPreset, globalPreset],
    },
  });
  const mount = root(window);

  assert.equal(mount.querySelector(".trace-sf-group[data-group='context']").getAttribute("data-collapsed"), "false");
  assert.equal(mount.querySelector(".trace-sf-group[data-group='global']").getAttribute("data-collapsed"), "false");
  assert.match(mount.textContent, /Showing\s+Global kudos/);
  assert.match(mount.textContent, /Global kudos/);
});

test("AO3 saved filters supports inline rename and delete", async () => {
  const { window, storageState } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto",
    storage: {
      [STORAGE_KEY]: [makePreset()],
    },
  });
  const mount = root(window);

  mount.querySelector("[data-trace-sf-action='menu']").click();
  await sleep(0);
  assert.equal(mount.querySelector(".trace-sf-row").getAttribute("data-menu-open"), "true");
  assert.equal(mount.querySelector(".trace-sf-menu-btn").getAttribute("aria-expanded"), "true");
  assert.match(window.document.getElementById("trace-ao3-saved-filters-style").textContent, /\.trace-sf-menu \{[^}]*position: absolute/s);
  assert.match(window.document.getElementById("trace-ao3-saved-filters-style").textContent, /\.trace-sf-row\[data-menu-open='true'\] \{[^}]*z-index: 20/s);
  assert.match(window.document.getElementById("trace-ao3-saved-filters-style").textContent, /\.trace-sf-menu \{[^}]*border-radius: 0\.36rem;[^}]*box-shadow: 0 7px 16px/s);
  assert.match(window.document.getElementById("trace-ao3-saved-filters-style").textContent, /\.trace-sf-menu-btn:focus[^}]*outline: 0/s);
  assert.equal(mount.querySelector(".trace-sf-menu-btn").textContent, "");
  assert.equal(mount.querySelectorAll(".trace-sf-menu-btn svg circle").length, 3);
  assert.match(mount.querySelector(".trace-sf-menu").textContent, /Rename/);
  window.document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  await sleep(0);
  assert.equal(mount.querySelector(".trace-sf-menu"), null);
  assert.equal(mount.querySelector(".trace-sf-menu-btn").getAttribute("aria-expanded"), "false");

  mount.querySelector("[data-trace-sf-action='menu']").click();
  await sleep(0);
  mount.querySelector(".trace-sf-menu-btn").dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  await sleep(0);
  assert.equal(mount.querySelector(".trace-sf-menu"), null);
  assert.equal(mount.querySelector(".trace-sf-menu-btn").getAttribute("aria-expanded"), "false");

  mount.querySelector("[data-trace-sf-action='menu']").click();
  await sleep(0);
  mount.querySelector("[data-trace-sf-action='rename-open']").click();
  await sleep(0);
  mount.querySelector("[data-trace-sf-rename-input]").value = "Comfort reads";
  mount.querySelector("[data-trace-sf-action='rename-save']").click();
  await sleep(80);
  assert.equal(storageState[STORAGE_KEY][0].name, "Comfort reads");
  assert.equal(storageState[STORAGE_KEY][0].dirty, true);

  mount.querySelector("[data-trace-sf-action='menu']").click();
  mount.querySelector("[data-trace-sf-action='delete-confirm']").click();
  await sleep(0);
  assert.match(mount.textContent, /Delete\s+Comfort reads/);
  mount.querySelector("[data-trace-sf-action='delete']").click();
  await sleep(80);
  assert.deepEqual(plain(storageState[STORAGE_KEY]), []);
  assert.equal(storageState[DELETED_KEY].length, 1);
  assert.equal(storageState[DELETED_KEY][0].clientId, "preset-a");
  assert.match(storageState[DELETED_KEY][0].clientUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("AO3 saved filters surfaces local storage failures inline", async () => {
  const { window, storageState } = await renderSavedFilters({
    setErrorMessage: "Local storage is full.",
  });
  const mount = root(window);

  mount.querySelector("[data-trace-sf-action='save-open']").click();
  await sleep(0);
  mount.querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);

  assert.equal(storageState[STORAGE_KEY], undefined);
  assert.match(mount.textContent, /Couldn't save/);
  assert.match(mount.textContent, /Local storage is full/);
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
