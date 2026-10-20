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
  await sleep(10);
  const nameInput = mount.querySelector("[data-trace-sf-name]");
  assert.ok(nameInput, "expected inline save form");
  assert.equal(
    nameInput.value,
    "Complete only · At least 50,000 words · Sorted by kudos",
    "the name starts filled with a suggestion",
  );
  assert.equal(window.document.activeElement, nameInput, "focus moves to the name field");
  assert.equal(nameInput.selectionStart, 0, "the suggestion is fully selected so typing replaces it");
  assert.equal(nameInput.selectionEnd, nameInput.value.length);
  assert.equal(
    mount.querySelector("label[for='trace-sf-name-input']").textContent,
    "Name",
  );
  assert.equal(
    mount.querySelectorAll("[data-trace-sf-action='save-open']").length,
    0,
    "save mode should not keep duplicate save-open buttons",
  );
  assert.equal(
    mount.querySelector(".trace-sf-status"),
    null,
    "the save form replaces the status line in place",
  );
  assert.equal(
    mount.querySelector(".trace-sf-empty"),
    null,
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

test("AO3 saved filters falls back to the suggested name when the name is cleared", async () => {
  const { window, storageState } = await renderSavedFilters();
  const mount = root(window);

  mount.querySelector("[data-trace-sf-action='save-open']").click();
  await sleep(0);
  const suggestedName = mount.querySelector("[data-trace-sf-name]").value;
  assert.ok(suggestedName, "expected a suggested name");
  assert.equal(mount.querySelector("[data-trace-sf-name]").getAttribute("placeholder"), suggestedName);
  mount.querySelector("[data-trace-sf-action='name-clear']").click();
  await sleep(0);
  assert.equal(mount.querySelector("[data-trace-sf-name]").value, "");

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

  // One list: this tag's filters first, then every-search filters, each
  // under a plain label because both kinds are present. No collapsing.
  assert.deepEqual(
    Array.from(mount.querySelectorAll(".trace-sf-row .trace-sf-name")).map((el) => el.textContent),
    ["Naruto context filter", "Reusable anywhere filter"],
  );
  assert.deepEqual(
    Array.from(mount.querySelectorAll(".trace-sf-section-label")).map((el) => el.textContent),
    ["Naruto", "Every search"],
  );
  assert.doesNotMatch(mount.textContent, /Avatar context filter/);
  assert.equal(mount.querySelector("[data-trace-sf-action='toggle-group']"), null);
  assert.equal(mount.querySelector(".trace-sf-group"), null);
  assert.doesNotMatch(mount.textContent, /This tag|All tags|Global|preset/);
});

test("AO3 saved filters shows a filter saved on a tag's filtered results back on that tag's listing", async () => {
  // AO3's filter form submits to /works?tag_id=..., so a filter is saved on
  // that URL; the tag's own listing is /tags/<tag>/works.
  const saved = await renderSavedFilters();
  const mount = root(saved.window);
  mount.querySelector("[data-trace-sf-action='save-open']").click();
  await sleep(10);
  assert.equal(
    mount.querySelector("[role='radio'][aria-checked='true']").textContent,
    "Harry Potter - J. K. Rowling only",
    "the default choice is this tag only",
  );
  mount.querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);
  assert.equal(saved.storageState[STORAGE_KEY].length, 1);

  const listing = await renderSavedFilters({
    url: "https://archiveofourown.org/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works",
    storage: plain(saved.storageState),
  });
  assert.deepEqual(
    Array.from(root(listing.window).querySelectorAll(".trace-sf-row .trace-sf-name")).map((el) => el.textContent),
    ["Complete only · At least 50,000 words · Sorted by kudos"],
  );

  const otherTag = await renderSavedFilters({
    url: "https://archiveofourown.org/tags/Naruto/works",
    storage: plain(saved.storageState),
  });
  assert.equal(otherTag.window.document.querySelectorAll(".trace-sf-row").length, 0);
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

test("AO3 saved filters shows filters a pull brings in without a reload", async () => {
  const harness = await renderSavedFilters({
    url: "https://archiveofourown.org/tags/Naruto/works",
  });
  assert.equal(root(harness.window).querySelectorAll(".trace-sf-row").length, 0);
  harness.emitStorageChange({
    [STORAGE_KEY]: {
      newValue: [makePreset({ id: "pulled", name: "From the account", scope: "global" })],
    },
    [SYNC_META_KEY]: {
      newValue: { syncVersion: "v2", lastSyncedAt: new Date().toISOString() },
    },
  });
  await sleep(80);
  assert.deepEqual(
    Array.from(root(harness.window).querySelectorAll(".trace-sf-row .trace-sf-name")).map((el) => el.textContent),
    ["From the account"],
  );
});

test("AO3 saved filters labels the list only when both kinds are present", async () => {
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto",
    storage: {
      [STORAGE_KEY]: [makePreset({ id: "only-context", contextKey: "tagId:Naruto", contextLabel: "Naruto" })],
    },
  });
  assert.equal(root(window).querySelectorAll(".trace-sf-section-label").length, 0);
  assert.equal(root(window).querySelectorAll(".trace-sf-row").length, 1);
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
  const head = mount.querySelector(".trace-sf-head");
  assert.equal(head.tagName, "BUTTON", "the whole header row is one button");
  assert.equal(head.getAttribute("data-trace-sf-action"), "toggle-panel");
  assert.equal(
    mount.querySelector(".trace-sf-card").getAttribute("data-panel-collapsed"),
    "false",
    "the panel starts expanded when filters are saved, so reuse is one tap",
  );
  assert.equal(head.getAttribute("aria-expanded"), "true");
  // Trace's page register, not AO3 mimicry.
  assert.doesNotMatch(style.textContent, /Georgia|Lucida|(?<!sans-)serif\b/i);
  assert.doesNotMatch(style.textContent, /#900\b|#990000|#700\b|#9a3412/i, "no AO3-red or rust fills");
  assert.doesNotMatch(style.textContent, /#1f5c45|#2f7d5b|#b07d2a|#8a6e2a|#e9f2ec|#f8efe8|#fffdf8/i, "no forest, honey or paper literals");
  assert.doesNotMatch(style.textContent, /linear-gradient/i, "no AO3 gradient buttons");
  assert.doesNotMatch(style.textContent, /text-transform:\s*uppercase/i);
  assert.doesNotMatch(style.textContent, /border-left:/i, "no coloured bars");
  assert.doesNotMatch(style.textContent, /\boutline:\s*0\b/, "focus is never suppressed");
  assert.match(style.textContent, /:focus-visible \{[^}]*outline:\s*3px solid var\(--trace-page-teal\)/);
  assert.match(style.textContent, /\.trace-sf-rows \{[^}]*border-radius:\s*14px;[^}]*box-shadow:\s*inset 0 0 0 1px var\(--trace-page-rule\)/);
  assert.match(style.textContent, /\.trace-sf-btn \{[^}]*color:\s*var\(--trace-page-teal\);[^}]*min-height:\s*44px;/);
  assert.match(style.textContent, /\.trace-sf-head \{[^}]*min-height:\s*44px;/);
  assert.match(style.textContent, /\.trace-sf-title \{[^}]*font-size:\s*15px;[^}]*font-weight:\s*600;/);
  for (const [, size] of style.textContent.matchAll(/font-size:\s*([\d.]+)px/g)) {
    assert.ok(Number(size) >= 12, `font-size ${size}px is below the 12 px page floor`);
  }
  assert.match(mount.getAttribute("style") || "", /--trace-page-teal:\s*#176E72/i, "light AO3 hosts get the light page tokens");
  assert.equal(mount.querySelector(".trace-sf-title").textContent, "Saved filters");
  assert.equal(mount.querySelector(".trace-sf-count").textContent, "1", "the count is a bare number");
  assert.equal(mount.querySelectorAll(".trace-sf-caret svg path").length, 1, "one caret");
  assert.equal(mount.querySelector(".trace-sf-head-meta"), null, "no second line while expanded");
  assert.match(mount.querySelector(".trace-sf-status").textContent, /Showing\s+Long complete/);
  assert.equal(mount.querySelector(".trace-sf-mark"), null);
  assert.equal(mount.querySelector(".trace-sf-by"), null, "no Trace eyebrow in page UI");

  head.click();
  await sleep(10);
  assert.equal(mount.querySelector(".trace-sf-card").getAttribute("data-panel-collapsed"), "true");
  assert.equal(mount.querySelector(".trace-sf-panel"), null, "a collapsed panel renders nothing below the header");
  assert.equal(mount.querySelector(".trace-sf-caret").getAttribute("data-collapsed"), "true");
  assert.equal(
    mount.querySelector(".trace-sf-head-meta").textContent,
    "Showing Long complete",
    "the collapsed header gives the state on a second line",
  );
  assert.equal(mount.querySelector(".trace-sf-head").getAttribute("aria-expanded"), "false");
  assert.equal(window.document.activeElement, mount.querySelector(".trace-sf-head"), "focus stays on the header");
  assert.equal(storageState[PANEL_COLLAPSED_KEY], true);

  const nextRender = await renderSavedFilters({
    url: "https://archiveofourown.org/works?work_search%5Bsort_column%5D=kudos_count&work_search%5Bcomplete%5D=T&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling",
    storage: storageState,
  });
  assert.equal(
    root(nextRender.window).querySelector(".trace-sf-card").getAttribute("data-panel-collapsed"),
    "true",
    "the reader's choice is remembered across pages",
  );
});

test("AO3 saved filters says where unsaved filters stand when collapsed", async () => {
  const { window } = await renderSavedFilters({
    storage: {
      [STORAGE_KEY]: [makePreset()],
      [PANEL_COLLAPSED_KEY]: true,
    },
  });
  assert.equal(
    root(window).querySelector(".trace-sf-head-meta").textContent,
    "Current filters aren't saved",
  );
});

test("AO3 saved filters shows a single empty line when nothing is saved or selected", async () => {
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto",
  });
  const mount = root(window);
  assert.equal(
    mount.querySelector(".trace-sf-empty").textContent,
    "Choose filters below, then save them here to reuse in one tap.",
  );
  assert.equal(mount.querySelector(".trace-sf-status"), null, "no status line without selected filters");
  assert.equal(mount.querySelector(".trace-sf-count"), null);
  assert.doesNotMatch(mount.textContent, /Global|preset|No active AO3 filters/);
});

test("AO3 saved filters has no collapsible groups", async () => {
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?work_search%5Bsort_column%5D=kudos_count&work_search%5Bcomplete%5D=T&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling",
    storage: {
      [STORAGE_KEY]: [makePreset(), makePreset({ id: "global-b", name: "Anywhere", scope: "global" })],
    },
  });
  const mount = root(window);
  assert.equal(mount.querySelectorAll("[aria-expanded]").length, 3, "only the header and the two ⋯ buttons expand");
  assert.equal(mount.querySelectorAll(".trace-sf-row").length, 2);
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

  assert.match(mount.querySelector(".trace-sf-status").textContent, /^Long complete, changed/);
  assert.equal(mount.querySelector(".trace-sf-status [data-trace-sf-action='update-current']").textContent, "Update Long complete");
  assert.equal(mount.querySelector(".trace-sf-status [data-trace-sf-action='save-open']").textContent, "Save as new");
  assert.equal(mount.querySelector(".trace-sf-row .trace-sf-edge svg"), null, "the check is removed from a changed filter");
  mount.querySelector("[data-trace-sf-action='update-current']").click();
  await sleep(80);

  assert.deepEqual(plain(storageState[STORAGE_KEY][0].params), [
    ["work_search[complete]", "T"],
    ["work_search[words_to]", "5000"],
  ]);
  assert.deepEqual(plain(storageState[STORAGE_KEY][0].summary), ["Complete only", "Up to 5,000 words"]);
  assert.equal(storageState[ACTIVE_KEY].id, "preset-a");
  assert.match(mount.textContent, /Showing\s+Long complete/);
});

test("AO3 saved filters shows eight rows, then Show all, with no inner scroll box", async () => {
  const presets = Array.from({ length: 14 }, (_, index) => makePreset({
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
  assert.equal(list.querySelectorAll(".trace-sf-row").length, 8);
  assert.equal(list.querySelectorAll(".trace-sf-row[data-scope='context']").length, 7, "this tag's filters come first");
  const more = list.querySelector("[data-trace-sf-action='show-all']");
  assert.equal(more.textContent, "Show all 14");
  assert.equal(mount.querySelectorAll(".trace-sf-badge").length, 0);
  assert.doesNotMatch(style.textContent, /\.trace-sf-list \{[^}]*max-height/s);
  assert.doesNotMatch(style.textContent, /\.trace-sf-list \{[^}]*overflow-y/s);
  // The active filter is marked with an ink check, not a coloured edge.
  assert.doesNotMatch(style.textContent, /\.trace-sf-edge \{[^}]*background/s);

  more.click();
  await sleep(10);
  const rows = mount.querySelectorAll(".trace-sf-row");
  assert.equal(rows.length, 14);
  assert.equal(mount.querySelector("[data-trace-sf-action='show-all']"), null);
  assert.equal(
    window.document.activeElement,
    rows[8].querySelector(".trace-sf-main"),
    "focus moves to the first row that was revealed",
  );
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

test("AO3 saved filters shows every saved filter's contents in full", async () => {
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
  const row = root(window).querySelector(".trace-sf-row");
  const contents = row.querySelector(".trace-sf-summary");
  assert.equal(
    contents.textContent,
    "Include Alternate Universe - Canon Divergence, Hurt/Comfort, Sirius Black/Remus Lupin, Found Family, " +
      "Emotional Hurt/Comfort with a Very Long Happy Ending That Keeps Going · Exclude Major Character Death · " +
      "Teen And Up Audiences · No Archive Warnings Apply · M/M · Complete only · 10,000–50,000 words · Sorted by kudos",
  );
  assert.doesNotMatch(contents.textContent, /more|…/);
  assert.equal(contents.getAttribute("title"), null, "nothing is hidden behind a tooltip");
  const apply = row.querySelector(".trace-sf-main");
  assert.equal(apply.getAttribute("aria-label"), `A long saved filter. ${contents.textContent}. Apply.`);
  assert.equal(apply.getAttribute("aria-current"), null);
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
  assert.equal(
    root(window).querySelector(".trace-sf-summary").textContent,
    "Include Bakugou Katsuki/Midoriya Izuku · Complete only",
  );
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
  assert.equal(root(window).querySelector(".trace-sf-summary").textContent, "Complete only · In Afrikaans");
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
  const rows = Array.from(root(window).querySelectorAll(".trace-sf-summary")).map((el) => el.textContent);
  assert.deepEqual(rows, [
    "Include Bakugou Katsuki/Midoriya Izuku · Complete only · At least 50,000 words · In Afrikaans · Sorted by kudos",
    "Include Bakugou Katsuki/Midoriya Izuku · Teen And Up Audiences · Complete only · No crossovers · At least 50,000 words · Sorted by kudos · +1 more",
  ]);
});

test("AO3 saved filters returns focus from Escape and Cancel", async () => {
  const { window } = await renderSavedFilters({ storage: { [STORAGE_KEY]: [makePreset()] } });
  const mount = root(window);
  const menuButton = () => mount.querySelector("[data-trace-sf-action='menu']");

  mount.querySelector("[data-trace-sf-action='save-open']").click();
  await sleep(0);
  mount.querySelector("[data-trace-sf-name]").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(0);
  assert.equal(mount.querySelector("[data-trace-sf-name]"), null, "Escape closes the save form");
  assert.equal(window.document.activeElement, mount.querySelector("[data-trace-sf-action='save-open']"));

  menuButton().click();
  mount.querySelector("[data-trace-sf-action='rename-open']").click();
  await sleep(0);
  mount.querySelector("[data-trace-sf-action='rename-cancel']").click();
  await sleep(0);
  assert.equal(mount.querySelector("[data-trace-sf-rename-input]"), null);
  assert.equal(window.document.activeElement, menuButton(), "Cancel in Rename returns to the menu button");

  menuButton().click();
  mount.querySelector("[data-trace-sf-action='delete-confirm']").click();
  await sleep(0);
  mount.querySelector("[data-trace-sf-action='delete-cancel']").click();
  await sleep(0);
  assert.equal(mount.querySelector(".trace-sf-confirm-title"), null);
  assert.equal(window.document.activeElement, menuButton(), "Cancel in Delete returns to the menu button");
});

test("AO3 saved filters save form lists everything it keeps, grouped", async () => {
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
  const mount = root(window);
  assert.equal(mount.querySelector(".trace-sf-status").textContent, "These filters aren't savedSave");
  mount.querySelector("[data-trace-sf-action='save-open']").click();
  await sleep(10);

  const keeps = mount.querySelector("dl.trace-sf-keeps");
  assert.ok(keeps, "expected a definition list of what the filter keeps");
  assert.equal(
    mount.querySelector("#" + keeps.getAttribute("aria-labelledby")).textContent,
    "What it keeps",
  );
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
  assert.doesNotMatch(keeps.textContent, /\|/);
  assert.equal(mount.querySelector(".trace-sf-chip"), null);

  const group = mount.querySelector("[role='radiogroup']");
  assert.ok(group, "Show it on is a radio group on a tag page");
  assert.equal(mount.querySelector("#" + group.getAttribute("aria-labelledby")).textContent, "Show it on");
  const radios = Array.from(group.querySelectorAll("[role='radio']"));
  assert.deepEqual(radios.map((radio) => radio.textContent), ["Harry Potter - J. K. Rowling only", "Every AO3 search"]);
  assert.deepEqual(radios.map((radio) => radio.getAttribute("aria-checked")), ["true", "false"]);
  radios[1].click();
  await sleep(10);
  const updated = Array.from(mount.querySelectorAll("[role='radio']"));
  assert.deepEqual(updated.map((radio) => radio.getAttribute("aria-checked")), ["false", "true"]);
  assert.equal(window.document.activeElement, updated[1]);
  assert.deepEqual(
    Array.from(mount.querySelectorAll(".trace-sf-actions .trace-sf-btn")).map((button) => button.textContent),
    ["Save filter", "Cancel"],
  );

  mount.querySelector("[data-trace-sf-name]").dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  }));
  await sleep(80);
  const saved = storageState[STORAGE_KEY][0];
  assert.equal(saved.scope, "global");
  assert.ok(saved.summary.length <= 5, "the stored fallback stays within what sync accepts");
  assert.ok(saved.summary.every((part) => part.length <= 64));
});

test("AO3 saved filters says where a filter shows when the page has no tag", async () => {
  const { window } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?work_search%5Bcomplete%5D=T",
  });
  const mount = root(window);
  mount.querySelector("[data-trace-sf-action='save-open']").click();
  await sleep(10);
  assert.equal(mount.querySelector("[role='radiogroup']"), null);
  assert.equal(mount.querySelector(".trace-sf-scope-note").textContent, "Shows on every AO3 search.");

  mount.querySelector("[data-trace-sf-action='save-cancel']").click();
  await sleep(10);
  assert.equal(
    window.document.activeElement,
    mount.querySelector("[data-trace-sf-action='save-open']"),
    "focus returns to Save on Cancel",
  );
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

  assert.match(mount.textContent, /These filters aren't saved/);
  assert.match(mount.textContent, /You've saved 250 filters, the most Trace keeps\. Delete one to save another\./);
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
  const active = mount.querySelector(".trace-sf-row[data-id='global-active'] .trace-sf-main");
  assert.equal(active.getAttribute("aria-current"), "true");
  assert.ok(active.querySelector(".trace-sf-edge svg"), "the active row carries the ink check");
  assert.equal(mount.querySelector(".trace-sf-row[data-id='context-other'] .trace-sf-main").getAttribute("aria-current"), null);
  assert.match(mount.querySelector(".trace-sf-status").textContent, /Showing\s+Global kudos/);
});

test("AO3 saved filters supports inline rename and delete", async () => {
  const { window, storageState } = await renderSavedFilters({
    url: "https://archiveofourown.org/works?tag_id=Naruto",
    storage: {
      [STORAGE_KEY]: [makePreset()],
    },
  });
  const mount = root(window);
  const revealed = [];
  window.Element.prototype.scrollIntoView = function (options) {
    revealed.push({ element: this, options });
  };

  mount.querySelector("[data-trace-sf-action='menu']").click();
  await sleep(0);
  assert.equal(mount.querySelector(".trace-sf-row").getAttribute("data-menu-open"), "true");
  assert.equal(mount.querySelector(".trace-sf-menu-btn").getAttribute("aria-expanded"), "true");
  assert.match(window.document.getElementById("trace-ao3-saved-filters-style").textContent, /\.trace-sf-manage \{[^}]*display: flex/s);
  assert.doesNotMatch(window.document.getElementById("trace-ao3-saved-filters-style").textContent, /\.trace-sf-manage \{[^}]*position: absolute/s);
  // The kebab keeps the page's visible teal focus ring.
  assert.doesNotMatch(window.document.getElementById("trace-ao3-saved-filters-style").textContent, /\.trace-sf-menu-btn:focus[^}]*outline: 0/s);
  assert.equal(mount.querySelector(".trace-sf-menu-btn").textContent, "");
  assert.equal(mount.querySelectorAll(".trace-sf-menu-btn svg circle").length, 3);
  assert.equal(mount.querySelector(".trace-sf-manage").getAttribute("role"), "group");
  assert.match(mount.querySelector(".trace-sf-manage").getAttribute("aria-label"), /^Manage /);
  assert.deepEqual(
    Array.from(mount.querySelectorAll(".trace-sf-manage button")).map((button) => button.textContent),
    ["Rename", "Update with current filters", "Delete"],
  );
  const update = mount.querySelector(".trace-sf-manage [data-trace-sf-action='update-current']");
  assert.equal(update.disabled, true, "nothing to update with when no filters are chosen");
  assert.ok(update.getAttribute("title"));
  assert.equal(mount.querySelector(".trace-sf-row > .trace-sf-manage") !== null, true);
  assert.equal(revealed.at(-1).element.classList.contains("trace-sf-row"), true);
  assert.equal(revealed.at(-1).options.block, "nearest");
  window.document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  await sleep(0);
  assert.equal(mount.querySelector(".trace-sf-manage"), null);
  assert.equal(mount.querySelector(".trace-sf-menu-btn").getAttribute("aria-expanded"), "false");

  mount.querySelector("[data-trace-sf-action='menu']").click();
  await sleep(0);
  mount.querySelector(".trace-sf-menu-btn").dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  await sleep(0);
  assert.equal(mount.querySelector(".trace-sf-manage"), null);
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
  assert.equal(mount.querySelector(".trace-sf-confirm-title").textContent, "Delete “Comfort reads”?");
  assert.equal(
    mount.querySelector(".trace-sf-confirm-detail").textContent,
    "It's deleted on every device. Nothing on AO3 changes.",
  );
  mount.querySelector("[data-trace-sf-action='delete']").click();
  await sleep(80);
  assert.deepEqual(plain(storageState[STORAGE_KEY]), []);
  assert.equal(storageState[DELETED_KEY].length, 1);
  assert.equal(storageState[DELETED_KEY][0].clientId, "preset-a");
  assert.match(storageState[DELETED_KEY][0].clientUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("AO3 saved filters surfaces local storage failures inline and keeps the draft", async () => {
  const harness = await renderSavedFilters({
    setErrorMessage: "Local storage is full.",
  });
  const { window, storageState } = harness;
  const mount = root(window);

  mount.querySelector("[data-trace-sf-action='save-open']").click();
  await sleep(0);
  const nameInput = mount.querySelector("[data-trace-sf-name]");
  nameInput.value = "My draft name";
  nameInput.dispatchEvent(new window.Event("input", { bubbles: true, cancelable: true }));
  mount.querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);

  assert.equal(storageState[STORAGE_KEY], undefined);
  assert.equal(mount.querySelector(".trace-sf-error").getAttribute("role"), "alert");
  assert.match(mount.querySelector(".trace-sf-error").textContent, /^Couldn't save\. Nothing changed\.Try again$/);
  assert.ok(mount.querySelector(".trace-sf-error .trace-sf-error-glyph svg"));
  assert.equal(mount.querySelector("[data-trace-sf-name]").value, "My draft name", "the form keeps its draft");

  harness.setStorageError("");
  mount.querySelector("[data-trace-sf-action='retry']").click();
  await sleep(80);
  assert.equal(storageState[STORAGE_KEY].length, 1);
  assert.equal(storageState[STORAGE_KEY][0].name, "My draft name");
  assert.equal(mount.querySelector(".trace-sf-error"), null);
});

test("AO3 saved filters explains applying a tag filter off a tag page", async () => {
  const { window, navigations } = await renderSavedFilters({
    url: "https://archiveofourown.org/works",
    html: loadFixture(),
    storage: { [STORAGE_KEY]: [makePreset({ contextKey: "" })] },
  });
  root(window).querySelector(".trace-sf-main").click();
  await sleep(80);
  assert.equal(navigations.length, 1);
  assert.match(root(window).textContent, /This page isn't a tag page, so the filter is applied across all of AO3\./);
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
// On AO3's narrow layout the filter form is a 16em column. It keeps quick
// access only; the list, saving and editing live in Trace's sheet, and a
// line above the works says which saved filter is showing.

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

function columnNames(window) {
  return Array.from(root(window).querySelectorAll(".trace-sf-col-row")).map((row) => row.textContent);
}

test("on a phone the Filters column offers three names, most relevant first, and nothing else", async () => {
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
  const mount = root(window);
  assert.equal(mount.parentElement.tagName, "FIELDSET", "the column keeps today's place at the top of AO3's form");
  assert.equal(mount.querySelector(".trace-sf-col-title").textContent, "Saved filters");
  // Last used on this tag, then this tag's others (recent first), never past three.
  assert.deepEqual(columnNames(window), ["Slow burn, finished", "Marauders, no MCD", "Long complete works"]);
  assert.equal(mount.querySelector(".trace-sf-summary"), null, "no summaries in the column");
  assert.equal(mount.querySelector("[data-trace-sf-tokens]"), null);
  assert.equal(mount.querySelector("[data-trace-sf-action='sheet-save']"), null, "nothing to save without filters");
  assert.equal(mount.querySelector("[aria-current]"), null);
  const all = mount.querySelector("[data-trace-sf-action='sheet-open']");
  assert.equal(all.textContent, "All saved filters (5)");
  assert.equal(all.getAttribute("aria-haspopup"), "dialog");
  assert.equal(line(window), null, "no Showing line while no saved filter is applied");

  const css = window.document.getElementById("trace-ao3-saved-filters-phone-style").textContent;
  assert.match(css, /\.trace-sf-col-name \{[^}]*white-space: nowrap;/, "names stay on one line");
  assert.match(css, /\.trace-sf-col-name \{[^}]*text-overflow: ellipsis;/);
  assert.match(css, /\.trace-sf-col-row \{[^}]*min-height: 44px;/);
  assert.match(css, /\.trace-sf-col-link \{[^}]*min-height: 44px;/);
});

test("on a phone the filter showing now leads the column with a check, and the Showing line appears", async () => {
  const { window } = await renderSavedFilters({
    narrow: true,
    url: FILTERED_PAGE,
    storage: { [STORAGE_KEY]: phonePresets() },
  });
  const mount = root(window);
  assert.deepEqual(columnNames(window), ["Long complete works", "Slow burn, finished", "Marauders, no MCD"]);
  const current = mount.querySelector(".trace-sf-col-row[aria-current='true']");
  assert.equal(current.getAttribute("data-id"), "p1");
  assert.ok(current.querySelector(".trace-sf-edge svg"), "the current filter carries the check");
  assert.equal(current.getAttribute("aria-label"), "Long complete works. Showing now.");
  assert.equal(mount.querySelector("[data-trace-sf-action='sheet-save']"), null, "these filters are already saved");

  const showing = line(window);
  assert.ok(showing, "a saved filter is applied, so the line shows");
  const navigation = window.document.getElementById("go_to_filters").closest("div.navigation");
  assert.equal(showing.previousElementSibling, navigation, "the line sits right after AO3's button row");
  assert.equal(showing.closest(".actions"), null, "outside AO3's .actions wrapper");
  assert.equal(showing.textContent, "Showing Long complete works");
  const button = showing.querySelector("button");
  assert.equal(button.getAttribute("aria-label"), "Showing Long complete works. Saved filters");
  button.click();
  await sleep(10);
  assert.ok(sheet(window), "tapping the line opens the sheet");
});

test("on a phone Save these filters shows only while the page's filters aren't saved", async () => {
  const presets = phonePresets().filter((preset) => preset.id !== "p1");
  const { window } = await renderSavedFilters({ narrow: true, url: FILTERED_PAGE, storage: { [STORAGE_KEY]: presets } });
  const save = root(window).querySelector("[data-trace-sf-action='sheet-save']");
  assert.equal(save.textContent, "Save these filters");
  assert.equal(root(window).querySelector("[aria-current]"), null);
  assert.equal(line(window), null, "the line is hidden while nothing saved is showing");
});

test("on a phone All saved filters opens the sheet; a row applies its filter", async () => {
  const { window, storageState, navigations } = await renderSavedFilters({
    narrow: true,
    url: TAG_PAGE,
    storage: { [STORAGE_KEY]: phonePresets() },
  });
  const all = root(window).querySelector("[data-trace-sf-action='sheet-open']");
  all.click();
  await sleep(10);
  const host = sheet(window);
  assert.equal(host.parentElement, window.document.documentElement, "the sheet sits outside AO3's body");
  const dialog = host.querySelector("[role='dialog']");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(window.document.getElementById(dialog.getAttribute("aria-labelledby")).textContent, "Saved filters");
  assert.equal(window.document.activeElement, host.querySelector(".trace-sf-sheet-title"), "focus moves into the sheet");
  assert.ok(window.document.body.hasAttribute("inert"), "the page behind is inert");
  assert.equal(host.querySelector(".trace-sf-sheet-close").getAttribute("aria-label"), "Close saved filters");
  assert.ok(host.querySelector(".trace-sf-grabber"), "the listing sheet's grabber");
  assert.match(host.getAttribute("style"), /--trace-page-teal:\s*#176E72/i, "light AO3 pages get light tokens");

  assert.deepEqual(Array.from(host.querySelectorAll(".trace-sf-sheet-label")).map((el) => el.textContent), ["This tag", "Every AO3 search"]);
  const rows = Array.from(host.querySelectorAll(".trace-sf-sheet-row")).map((row) => [
    row.querySelector(".trace-sf-sheet-name").textContent,
    row.querySelector(".trace-sf-tokens").textContent,
  ]);
  assert.deepEqual(rows, [
    ["Long complete works", "Complete · 50k+ words · By kudos"],
    ["Slow burn, finished", "Slow Burn · Complete · By date updated"],
    ["Marauders, no MCD", "Remus Lupin/Sirius Black · Marauders Era · Complete · 20k–150k words · Excludes 3 tags · English · No crossovers · By kudos"],
    ["Comfort reads", "Fluff · Hurt/Comfort · Under 40k words · Not Major Character Death"],
    ["New this week", `Updated since 13 Oct${new Date().getFullYear() === 2026 ? "" : " 2026"} · By date updated`],
  ]);
  assert.equal(host.querySelector(".trace-sf-sheet-more[data-id='p5']").getAttribute("aria-label"), "Edit Marauders, no MCD");

  host.querySelector(".trace-sf-sheet-main[data-id='p2']").click();
  await sleep(40);
  assert.equal(navigations.length, 1);
  const target = new URL(navigations[0]);
  assert.equal(target.pathname, "/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works");
  assert.equal(target.searchParams.get("work_search[other_tag_names]"), "Slow Burn");
  assert.equal(storageState[ACTIVE_KEY].id, "p2");
  assert.equal(storageState[LAST_USED_KEY].byContext["tag:harry potter - j. k. rowling"].id, "p2", "last used on this tag, kept on this device");
  assert.ok(storageState[LAST_USED_KEY].byId.p2);
  assert.equal(sheet(window), null, "the sheet closes as the filter loads");
  assert.equal(window.document.body.hasAttribute("inert"), false);
});

test("on a phone the sheet closes on Escape and returns focus to what opened it", async () => {
  const { window } = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  root(window).querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  sheet(window).querySelector(".trace-sf-sheet-title").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(10);
  assert.equal(sheet(window), null);
  assert.equal(window.document.activeElement, root(window).querySelector("[data-trace-sf-action='sheet-open']"));
});

test("on a phone saving opens the sheet with a short suggested name, a scope choice and Save in the header", async () => {
  const presets = phonePresets().filter((preset) => preset.id !== "p1");
  const { window, storageState, runtimeMessages } = await renderSavedFilters({ narrow: true, url: FILTERED_PAGE, storage: { [STORAGE_KEY]: presets } });
  root(window).querySelector("[data-trace-sf-action='sheet-save']").click();
  await sleep(10);
  const host = sheet(window);
  assert.equal(host.querySelector(".trace-sf-sheet-title").textContent, "Save filters");
  assert.deepEqual(Array.from(host.querySelectorAll(".trace-sf-sheet-head button")).map((button) => button.textContent), ["Cancel", "Save"]);
  const input = host.querySelector("[data-trace-sf-name]");
  assert.equal(input.value, "Complete · 50k+ words", "suggested from the first two tokens");
  assert.notEqual(window.document.activeElement, input, "the field isn't focused, so the keyboard stays down");
  const css = window.document.getElementById("trace-ao3-saved-filters-phone-style").textContent;
  assert.match(css, /\.trace-sf-sheet-input \{[^}]*font: 16px/, "16 px fields so Safari doesn't zoom");
  for (const [, size] of css.matchAll(/font-size:\s*([\d.]+)px/g)) {
    assert.ok(Number(size) >= 13, `font-size ${size}px is below the sheet's floor`);
  }

  const options = Array.from(host.querySelectorAll("[role='radio']"));
  assert.deepEqual(options.map((option) => option.textContent), ["Harry Potter - J. K. RowlingOnly this tag", "Every AO3 searchAny tag or search"]);
  assert.deepEqual(options.map((option) => option.getAttribute("aria-checked")), ["true", "false"]);
  assert.deepEqual(
    Array.from(host.querySelectorAll(".trace-sf-sheet-keep")).map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]),
    [["Status", "Complete only"], ["Words", "At least 50,000 words"], ["Sort", "Kudos"]],
  );
  options[1].click();
  await sleep(10);
  assert.equal(sheet(window).querySelector("[data-trace-sf-action='scope-global']").getAttribute("aria-checked"), "true");

  const field = sheet(window).querySelector("[data-trace-sf-name]");
  field.value = "Long ones";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  sheet(window).querySelector("[data-trace-sf-action='save-confirm']").click();
  await sleep(80);

  const saved = storageState[STORAGE_KEY].at(-1);
  assert.equal(saved.name, "Long ones");
  assert.equal(saved.scope, "global");
  assert.equal(saved.contextKey, "");
  assert.equal(saved.dirty, true);
  assert.equal(storageState[ACTIVE_KEY].id, saved.id);
  assert.ok(storageState[LAST_USED_KEY].byId[saved.id], "the new filter counts as used here");
  assert.deepEqual(plain(runtimeMessages.at(-1)), { type: "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST" });
  assert.equal(sheet(window), null, "saving closes the sheet");
  assert.equal(line(window).textContent, "Showing Long ones");
  assert.equal(root(window).querySelector("[data-trace-sf-action='sheet-save']"), null);
  assert.equal(window.document.activeElement, line(window).querySelector("button"), "focus lands on the Showing line");
});

test("on a phone Edit filter renames, changes scope, offers Update only when it would change something, and deletes after a confirm", async () => {
  const { window, storageState } = await renderSavedFilters({ narrow: true, url: FILTERED_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  root(window).querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  const edit = (id) => sheet(window).querySelector(`[data-trace-sf-action='sheet-edit'][data-id='${id}']`).click();

  edit("p1");
  await sleep(10);
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-title").textContent, "Edit filter");
  assert.equal(sheet(window).querySelector("[data-trace-sf-edit-name]").value, "Long complete works");
  assert.equal(sheet(window).querySelector("[data-trace-sf-action='update-current']"), null, "the page already shows this filter");
  sheet(window).querySelector("[data-trace-sf-action='sheet-back']").click();
  await sleep(10);
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-title").textContent, "Saved filters", "Cancel goes back to the list");
  assert.equal(window.document.activeElement, sheet(window).querySelector("[data-trace-sf-action='sheet-edit'][data-id='p1']"));

  edit("p5");
  await sleep(10);
  const host = sheet(window);
  assert.equal(host.querySelector("[data-trace-sf-action='update-current']").textContent, "Update with this page's filters");
  assert.deepEqual(
    Array.from(host.querySelectorAll(".trace-sf-sheet-keep")).map((row) => row.querySelector("dt").textContent),
    ["Include", "Exclude", "Status", "Crossovers", "Words", "Language", "Sort"],
    "What it keeps lists everything",
  );
  const name = host.querySelector("[data-trace-sf-edit-name]");
  name.value = "Marauders era";
  name.dispatchEvent(new window.Event("input", { bubbles: true }));
  host.querySelector("[data-trace-sf-action='edit-scope-global']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='edit-done']").click();
  await sleep(80);
  const renamed = storageState[STORAGE_KEY].find((preset) => preset.id === "p5");
  assert.equal(renamed.name, "Marauders era");
  assert.equal(renamed.scope, "global");
  assert.equal(renamed.contextKey, "");
  assert.equal(renamed.dirty, true);
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-title").textContent, "Saved filters");
  assert.equal(window.document.activeElement, sheet(window).querySelector("[data-trace-sf-action='sheet-edit'][data-id='p5']"));

  edit("p3");
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='edit-scope-context']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='edit-done']").click();
  await sleep(80);
  const scoped = storageState[STORAGE_KEY].find((preset) => preset.id === "p3");
  assert.equal(scoped.scope, "context");
  assert.equal(scoped.contextKey, `tagId:${TAG_ID.replace(/\+/g, " ")}`, "a filter moved to this tag takes this tag");

  edit("p2");
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='update-current']").click();
  await sleep(80);
  assert.deepEqual(plain(storageState[STORAGE_KEY].find((preset) => preset.id === "p2").params), plain(storageState[STORAGE_KEY].find((preset) => preset.id === "p1").params));

  edit("p4");
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='delete-confirm']").click();
  await sleep(10);
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-confirm-title").textContent, "Delete “New this week”?");
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-confirm-detail").textContent, "It's deleted on every device. Nothing on AO3 changes.");
  assert.equal(window.document.activeElement, sheet(window).querySelector("[data-trace-sf-action='delete-cancel']"));
  sheet(window).querySelector("[data-trace-sf-action='delete-cancel']").click();
  await sleep(10);
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-confirm"), null);
  assert.equal(window.document.activeElement, sheet(window).querySelector("[data-trace-sf-action='delete-confirm']"));
  sheet(window).querySelector("[data-trace-sf-action='delete-confirm']").click();
  await sleep(10);
  sheet(window).querySelector("[data-trace-sf-action='delete']").click();
  await sleep(80);
  assert.equal(storageState[STORAGE_KEY].some((preset) => preset.id === "p4"), false);
  assert.equal(storageState[DELETED_KEY].at(-1).clientId, "p4");
  assert.equal(sheet(window).querySelector(".trace-sf-sheet-title").textContent, "Saved filters");
});

test("on a phone a long token line shows what fits, then +n", async () => {
  const { window } = await renderSavedFilters({ narrow: true, url: TAG_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  // About 7 px a character in a 300 px line.
  Object.defineProperty(window.HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return this.textContent.length * 7; } });
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 300; } });
  root(window).querySelector("[data-trace-sf-action='sheet-open']").click();
  await sleep(10);
  const tokens = sheet(window).querySelector(".trace-sf-sheet-row[data-id='p5'] .trace-sf-tokens");
  assert.equal(tokens.textContent, "Remus Lupin/Sirius Black · Marauders Era +6");
  assert.match(sheet(window).querySelector(".trace-sf-sheet-row[data-id='p5'] .trace-sf-sheet-main").getAttribute("aria-label"), /Excludes 3 tags · English · No crossovers · By kudos\. Apply\.$/, "VoiceOver hears every token");
});

test("a wide layout keeps today's panel, with no Showing line or sheet", async () => {
  const { window } = await renderSavedFilters({ url: FILTERED_PAGE, storage: { [STORAGE_KEY]: phonePresets() } });
  assert.ok(root(window).querySelector(".trace-sf-card"));
  assert.equal(root(window).querySelector(".trace-sf-col"), null);
  assert.equal(line(window), null);
  assert.equal(window.document.getElementById("trace-ao3-saved-filters-phone-style"), null);
});
