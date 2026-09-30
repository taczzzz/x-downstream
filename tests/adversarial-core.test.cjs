const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../extension/core.js");
const { tweet, timeline } = require("./fixtures.cjs");

test("persisted read IDs filter seed, retweets and individual conversation children without losing unseen payloads", () => {
  const engine = new Core.NativeTimeline("for-you", "test", ["10"]);
  const repost = tweet(99, "转帖", { legacy: { retweeted_status_result: { result: tweet(10) } } });
  const payload = timeline([tweet(10), tweet(11), repost]);
  payload.data.home.home_timeline_urt.instructions[0].entries.unshift({ entryId: "conversation-1", sortIndex: "1900000000000000010", content: {
    entryType: "TimelineTimelineModule", displayType: "VerticalConversation", items: [10, 12].map(id => ({ entryId: `child-${id}`, item: { itemContent: { tweet_results: { result: tweet(id) } } } }))
  } });
  const seeded = engine.seed(payload), entries = Core.nativeEntries(seeded);
  assert.equal(entries.some(entry => Core.tweetIdentity(entry.content) === "10"), false);
  assert.equal(entries.some(entry => Core.tweetIdentity(entry.content) === "11"), true);
  assert.deepEqual(entries.find(entry => entry.entryId === "conversation-1").content.items.map(child => Core.tweetIdentity(child.item)), ["12"]);
  assert.equal(payload.data.home.home_timeline_urt.instructions[0].entries.length, 5, "input must stay immutable");
});

test("read history validates IDs and timestamps, expires old records, deduplicates and bounds accounts and size", () => {
  const now = 2000000000000;
  const raw = { accounts: { own: [
    { id: "10", at: now - 5 }, { id: "10", at: now }, { id: "11", at: now - Core.READ_TTL - 1 },
    { id: "script", at: now }, { id: "12", at: now + 120000 }, { id: "13", at: "today" }, null
  ] } };
  assert.deepEqual(Core.readHistory(raw, now), { accounts: { own: [{ id: "10", at: now }] } });
  let history = Core.markRead(raw, "own", ["20", "10", "bad"], now);
  assert.deepEqual(new Set(history.accounts.own.map(record => record.id)), new Set(["10", "20"]));
  assert.equal(Core.markRead(history, "__proto__", ["30"], now).accounts["30"], undefined);
  history = Core.markRead(history, "many", Array.from({ length: Core.READ_LIMIT + 100 }, (_, i) => String(i + 100)), now);
  assert.equal(history.accounts.many.length, Core.READ_LIMIT);
  for (let i = 0; i < 8; i++) history = Core.markRead(history, `account-${i}`, [String(i)], now + i);
  assert.equal(Object.keys(history.accounts).length, Core.ACCOUNT_LIMIT);
  assert.equal(Core.readHistory(history, now + Core.READ_TTL + 10).accounts.own, undefined);
});

test("400 deterministic overlapping batches cannot reintroduce read IDs, duplicate cards, mutate input or reverse sort order", () => {
  let state = 12345;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const read = Array.from({ length: 30 }, (_, i) => String(100 + i));
  const engine = new Core.NativeTimeline("for-you", "fuzz", read);
  engine.seed(timeline([tweet(999)]));
  const displayed = new Set(["999"]);
  let floor = engine.floor;
  for (let batch = 0; batch < 400; batch++) {
    const payload = timeline(Array.from({ length: 20 }, () => tweet(100 + random() % 300)));
    const original = JSON.stringify(payload);
    const appended = engine.append(payload);
    for (const entry of Core.nativeEntries(appended)) {
      assert.ok(BigInt(entry.sortIndex) < floor); floor = BigInt(entry.sortIndex);
      const id = Core.tweetIdentity(entry.content);
      if (!id) continue;
      assert.ok(!read.includes(id), `read ID ${id} returned`);
      assert.ok(!displayed.has(id), `duplicate ${id}`); displayed.add(id);
    }
    assert.equal(JSON.stringify(payload), original);
  }
});

test("malformed nested native payloads do not throw or commit a partial dedup state", () => {
  const instructions = [null, "bad", { entries: {} }, { entries: [null] }, { entries: [{ content: { items: [null] } }] }, { entries: [{ entryId: "bad", content: { items: {} } }] }];
  for (const instruction of instructions) {
    const engine = new Core.NativeTimeline("for-you", "bad", ["10"]);
    const payload = { data: { home: { instructions: [instruction] } } };
    assert.doesNotThrow(() => engine.seed(payload));
    assert.deepEqual([...engine.seen], ["10"]);
  }
});

test("native module delta keeps unread children and complete conversation metadata at the tail", () => {
  const engine = new Core.NativeTimeline("for-you", "module", ["10"]);
  const module = { entryId: "conversation-1", sortIndex: "1900000000000000100", content: { entryType: "TimelineTimelineModule", __typename: "TimelineTimelineModule", displayType: "VerticalConversation", clientEventInfo: { component: "conversation" }, items: [
    { entryId: "child-11", item: { itemContent: { tweet_results: { result: tweet(11) } } } }
  ] } };
  const seed = timeline([]); seed.data.home.home_timeline_urt.instructions[0].entries.unshift(module); engine.seed(seed);
  const payload = { data: { home: { instructions: [{ type: "TimelineAddToModule", moduleEntryId: "conversation-1", moduleItems: [10, 11, 12].map(id => ({ entryId: `child-${id}`, item: { itemContent: { tweet_results: { result: tweet(id) } } } })) }] } } };
  const entries = Core.nativeEntries(engine.append(payload));
  const newModule = entries.find(entry => entry.content?.items);
  assert.ok(newModule, "module delta was silently dropped");
  assert.deepEqual(newModule.content.items.map(child => Core.tweetIdentity(child.item)), ["12"]);
  assert.equal(newModule.content.displayType, "VerticalConversation");
  assert.deepEqual(newModule.content.clientEventInfo, { component: "conversation" });
});

test("reseeded native timelines never reuse a cursor cache key or leak an old local token to X", () => {
  const old = new Core.NativeTimeline("for-you", "page");
  const current = new Core.NativeTimeline("for-you", "page", ["10"]);
  const oldToken = Core.nativeEntries(old.seed(timeline([tweet(10)], "old-backend"))).find(entry => entry.content.cursorType === "Bottom").content.value;
  const newToken = Core.nativeEntries(current.seed(timeline([tweet(11)], "new-backend"))).find(entry => entry.content.cursorType === "Bottom").content.value;
  assert.notEqual(oldToken, newToken, "native request caches can replay the old batch if the local cursor is reused");
  assert.equal(current.isToken(oldToken), true);
  assert.equal(current.decode(oldToken), "new-backend");
});
