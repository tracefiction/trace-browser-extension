import assert from "node:assert/strict";
import test from "node:test";

import {
  READING_ACTIVITY_CLOCK_AHEAD,
  ReadingActivityCommands,
  readingActivityClockAheadServerTime,
  readingActivityContext,
} from "../../.trace-build/extension-runtime/reading-activity.mjs";
import { LibraryCommandApi } from "../../.trace-build/extension-runtime/library-command.mjs";
import { StoryCommandApi } from "../../.trace-build/extension-runtime/story-command.mjs";

const operationId = "00000000-0000-4000-8000-0000000000aa";
const entryId = "00000000-0000-4000-8000-000000000123";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** An instant whose device offset is fixed, independent of the test host. */
function at(iso, offsetMinutes) {
  const date = new Date(iso);
  date.getTimezoneOffset = () => -offsetMinutes;
  return date;
}

function withZone(t, zone) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function clockAhead(serverTime) {
  return json({
    error: "Reading occurrence time is ahead of the server clock",
    code: READING_ACTIVITY_CLOCK_AHEAD,
    server_time: serverTime,
    error_id: "e",
  }, 400);
}

function entryPatch(patch) {
  return { kind: "entry_patch", hostKind: "ffn", workKey: "ffn:7038840", entryId, patch };
}

function assertContext(context) {
  assert.deepEqual(Object.keys(context).sort(), [
    "calendarDate", "occurredAt", "operationId", "timeZone",
  ]);
  assert.match(context.operationId, UUID);
  assert.equal(new Date(context.occurredAt).toISOString(), context.occurredAt);
  assert.equal(context.timeZone.kind, "OFFSET");
  assert.match(context.timeZone.value, /^(?:[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/);
  const [, sign, hours, minutes] = /^([+-])(\d{2}):(\d{2})$/.exec(context.timeZone.value);
  const offset = (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
  assert.equal(
    new Date(Date.parse(context.occurredAt) + offset * 60_000).toISOString().slice(0, 10),
    context.calendarDate,
  );
}

test("local calendar date follows the instant's own offset across midnight and ±14:00", () => {
  for (const [iso, offset, calendarDate, value] of [
    ["2026-09-27T23:59:59.999Z", 0, "2026-09-27", "+00:00"],
    ["2026-09-28T00:00:00.000Z", 0, "2026-09-28", "+00:00"],
    ["2026-09-27T23:30:00.000Z", 60, "2026-09-28", "+01:00"],
    ["2026-09-28T00:30:00.000Z", -60, "2026-09-27", "-01:00"],
    ["2026-09-27T09:59:59.999Z", 840, "2026-09-27", "+14:00"],
    ["2026-09-27T10:00:00.000Z", 840, "2026-09-28", "+14:00"],
    ["2026-09-27T13:59:59.999Z", -840, "2026-09-26", "-14:00"],
    ["2026-09-27T14:00:00.000Z", -840, "2026-09-27", "-14:00"],
    ["2026-09-27T11:59:59.999Z", -720, "2026-09-26", "-12:00"],
    ["2026-09-27T18:15:00.000Z", 345, "2026-09-28", "+05:45"],
    ["2026-09-28T02:29:59.999Z", -150, "2026-09-27", "-02:30"],
  ]) {
    const context = readingActivityContext(at(iso, offset), operationId);
    assert.deepEqual(context, {
      operationId,
      occurredAt: iso,
      calendarDate,
      timeZone: { kind: "OFFSET", value },
    }, `${iso} at ${value}`);
    assertContext(context);
  }
});

test("real device zones produce the numeric offset and local date of that instant", (t) => {
  withZone(t, "UTC");
  for (const [zone, iso, calendarDate, value] of [
    ["Pacific/Kiritimati", "2026-09-27T09:59:59.000Z", "2026-09-27", "+14:00"],
    ["Pacific/Kiritimati", "2026-09-27T10:00:00.000Z", "2026-09-28", "+14:00"],
    ["Pacific/Pago_Pago", "2026-09-27T10:59:59.000Z", "2026-09-26", "-11:00"],
    ["Asia/Kathmandu", "2026-09-27T18:15:00.000Z", "2026-09-28", "+05:45"],
    ["America/New_York", "2026-03-08T06:59:59.000Z", "2026-03-08", "-05:00"],
    ["America/New_York", "2026-03-08T07:00:00.000Z", "2026-03-08", "-04:00"],
    ["UTC", "2026-09-27T23:59:59.000Z", "2026-09-27", "+00:00"],
  ]) {
    process.env.TZ = zone;
    const context = readingActivityContext(new Date(iso), operationId);
    assert.equal(context.calendarDate, calendarDate, `${zone} ${iso}`);
    assert.deepEqual(context.timeZone, { kind: "OFFSET", value }, `${zone} ${iso}`);
    assert.equal(context.occurredAt, iso);
  }
});

test("clock-ahead recovery reads only the documented rejection", () => {
  const serverTime = "2026-09-27T12:00:00.000Z";
  assert.equal(
    readingActivityClockAheadServerTime({ code: READING_ACTIVITY_CLOCK_AHEAD, server_time: serverTime })
      ?.toISOString(),
    serverTime,
  );
  for (const body of [
    null,
    [],
    { code: "READING_ACTIVITY_CALENDAR_INVALID", server_time: serverTime },
    { code: READING_ACTIVITY_CLOCK_AHEAD },
    { code: READING_ACTIVITY_CLOCK_AHEAD, server_time: "not a time" },
  ]) {
    assert.equal(readingActivityClockAheadServerTime(body), null);
  }
});

test("a command keeps one context; separate intents get separate operation ids", () => {
  const commands = new ReadingActivityCommands();
  const first = {};
  const context = commands.context(first);
  assertContext(context);
  assert.equal(commands.context(first), context);
  assert.notEqual(commands.context({}).operationId, context.operationId);
});

test("a clock-ahead command is re-anchored once to the server instant in the device zone", (t) => {
  withZone(t, "Europe/London");
  const commands = new ReadingActivityCommands(() => new Date("2026-09-27T23:45:00.000Z"));
  const command = {};
  const original = commands.context(command);
  assert.equal(original.calendarDate, "2026-09-28");

  // Within the accepted lead: nothing to repair.
  assert.equal(commands.reanchor(command, new Date("2026-09-27T23:40:00.000Z")), false);
  assert.equal(commands.context(command), original);

  assert.equal(commands.reanchor(command, new Date("2026-09-27T22:55:00.000Z")), true);
  assert.deepEqual(commands.context(command), {
    operationId: original.operationId,
    occurredAt: "2026-09-27T22:55:00.000Z",
    calendarDate: "2026-09-27",
    timeZone: { kind: "OFFSET", value: "+01:00" },
  });
  // Never a second time, even if a later response reports an earlier clock.
  assert.equal(commands.reanchor(command, new Date("2026-09-27T20:00:00.000Z")), false);
  assert.equal(commands.context(command).occurredAt, "2026-09-27T22:55:00.000Z");
});

test("kernel progress and status patches carry the context; other writes are unchanged", async () => {
  const bodies = [];
  const api = new LibraryCommandApi(async (url, options) => {
    bodies.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
    const path = new URL(url).pathname;
    return path.endsWith("/work-preferences")
      ? json({ data: { key: "ffn:7038840", browsePreference: { hidden: true } } })
      : json({ data: { entry_id: entryId } });
  }, "https://api.tracefiction.com");
  const progress = { unit: "CHAPTER", value: 3, total: 12 };
  for (const patch of [
    { status: "PAUSED" },
    { status: "FINISHED" },
    { progress },
    { status: "READING", progress },
    { rating: 4 },
    { story_snapshot: { work_status_override: "abandoned" } },
  ]) {
    assert.deepEqual(
      await api.mutate("credential", entryPatch(patch)),
      { kind: "success", value: { kind: "accepted" } },
    );
  }
  assert.deepEqual(
    await api.mutate("credential", {
      kind: "work_preference", hostKind: "ffn", workKey: "ffn:7038840", hidden: true,
    }),
    { kind: "success", value: { kind: "accepted" } },
  );

  const reading = bodies.slice(0, 4);
  for (const { body } of reading) assertContext(body.readingActivity);
  assert.equal(new Set(reading.map(({ body }) => body.readingActivity.operationId)).size, 4);
  assert.deepEqual(bodies.slice(4).map(({ body }) => body), [
    { rating: 4 },
    { story_snapshot: { work_status_override: "abandoned" } },
    { key: "ffn:7038840", hidden: true },
  ]);
});

test("kernel entry patch keeps its context through the authentication retry", async () => {
  const bodies = [];
  const responses = [new Response("", { status: 401 }), json({ data: { entry_id: entryId } })];
  const api = new LibraryCommandApi(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return responses.shift();
  }, "https://api.tracefiction.com");
  const command = entryPatch({ status: "DROPPED" });
  assert.deepEqual(await api.mutate("old", command), { kind: "auth_rejected" });
  assert.deepEqual(await api.mutate("new", command), {
    kind: "success", value: { kind: "accepted" },
  });
  assert.deepEqual(bodies[1], bodies[0]);
  assertContext(bodies[0].readingActivity);
});

test("kernel entry patch re-anchors a clock-ahead rejection once with the same operation id", async () => {
  const serverTime = new Date(Date.now() - 10 * 60_000).toISOString();
  const earlier = new Date(Date.now() - 30 * 60_000).toISOString();
  const bodies = [];
  const responses = [
    clockAhead(serverTime),
    new Response("", { status: 401 }),
    clockAhead(earlier),
  ];
  const api = new LibraryCommandApi(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return responses.shift();
  }, "https://api.tracefiction.com");
  const command = entryPatch({ status: "READING" });

  assert.deepEqual(await api.mutate("credential", command), { kind: "auth_rejected" });
  assert.equal(bodies.length, 2);
  const [first, second] = bodies.map((body) => body.readingActivity);
  assertContext(second);
  assert.equal(second.operationId, first.operationId);
  assert.equal(second.occurredAt, serverTime);
  assert.deepEqual(
    second,
    readingActivityContext(new Date(serverTime), first.operationId),
  );
  assert.equal(bodies[1].status, "READING");

  // The authentication retry resends the re-anchored command and never
  // re-anchors it again.
  assert.deepEqual(await api.mutate("credential", command), {
    kind: "success", value: { kind: "rejected", reason: "invalid_request" },
  });
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[2], bodies[1]);
});

test("other 400 responses and accepted-lead rejections are not retried", async () => {
  for (const response of [
    json({ code: "READING_ACTIVITY_CALENDAR_INVALID" }, 400),
    json({ error: "Invalid request" }, 400),
    clockAhead(new Date(Date.now() + 60_000).toISOString()),
  ]) {
    let calls = 0;
    const api = new LibraryCommandApi(async () => {
      calls += 1;
      return response;
    }, "https://api.tracefiction.com");
    assert.deepEqual(await api.mutate("credential", entryPatch({ status: "PAUSED" })), {
      kind: "success", value: { kind: "rejected", reason: "invalid_request" },
    });
    assert.equal(calls, 1);
  }
});

test("resolved finish re-anchors with its top-level operation id; open finish has no context", async () => {
  const serverTime = new Date(Date.now() - 10 * 60_000).toISOString();
  const bodies = [];
  const acknowledged = (state) => json({
    data: {
      state,
      eventId: null,
      operationId: state === "resolved" ? operationId : null,
      workKey: "ffn:7038840",
      entry: { entryId, status: "READING", chapters: { current: 12, total: 12 } },
      syncVersion: "2026-09-27T09:00:00.000Z",
    },
  });
  const responses = [clockAhead(serverTime), acknowledged("resolved"), acknowledged("open")];
  const api = new LibraryCommandApi(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return responses.shift();
  }, "https://api.tracefiction.com");
  const base = {
    kind: "finish_qualification", hostKind: "ffn", workKey: "ffn:7038840", entryId,
    source: "ffn", chapter: 12, total: 12,
  };
  const resolved = await api.qualifyFinish("credential", {
    ...base, state: "resolved", workStatus: "wip", resolutionSource: "source", operationId,
  });
  assert.equal(resolved.kind, "success");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].operationId, operationId);
  assert.equal(bodies[1].operationId, operationId);
  const { operationId: _, ...calendar } = readingActivityContext(new Date(serverTime), operationId);
  assert.deepEqual(bodies[1].readingActivity, calendar);

  const open = await api.qualifyFinish("credential", { ...base, state: "open" });
  assert.equal(open.kind, "success");
  assert.equal(bodies[2].readingActivity, undefined);
  assert.equal(bodies[2].operationId, undefined);
});

test("story track re-anchors a clock-ahead rejection once with the same operation id", async () => {
  const serverTime = new Date(Date.now() - 10 * 60_000).toISOString();
  const bodies = [];
  const api = new StoryCommandApi(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return clockAhead(bodies.length === 1 ? serverTime : new Date(0).toISOString());
  }, "https://api.tracefiction.com");
  const result = await api.track("credential", {
    kind: "track", workKey: "ffn:7038840", payload: { s: "ffn", at: "x", item: {} },
  });
  assert.deepEqual(result, {
    kind: "success", value: { kind: "rejected", reason: "invalid_request" },
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].readingActivity.operationId, bodies[0].readingActivity.operationId);
  assert.equal(bodies[1].readingActivity.occurredAt, serverTime);
});
