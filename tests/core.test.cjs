const { test } = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../extension/core.js");
const { tweet, timeline } = require("./fixtures.cjs");

test("only read operations on the current X origin are replayable", () => {
  const url = "https://x.com/i/api/graphql/current-query/HomeTimeline";
  assert.equal(Core.classifyRequest(url).source, "for-you");
  assert.equal(Core.classifyRequest(url.replace("HomeTimeline", "HomeLatestTimeline"), "POST").source, "following");
  for (const input of [url.replace("x.com", "attacker.test"), url.replace("HomeTimeline", "CreateTweet"), "javascript:alert(1)", url + "/extra"]) assert.equal(Core.classifyRequest(input), null);
  assert.equal(Core.classifyRequest(url, "DELETE"), null);
});
test("fresh head requests cannot accidentally keep an old pagination cursor", () => {
  const url = new URL("https://x.com/i/api/graphql/current-query/HomeTimeline");
  url.searchParams.set("variables", JSON.stringify({ cursor: "old", seenTweetIds: ["1"], count: 200, includePromotedContent: true }));
  url.searchParams.set("features", '{"unchanged":true}');
  const template = { url: url.href, method: "GET", operation: "HomeTimeline" };
  const fresh = new URL(Core.freshRequest(template).url);
  const variables = JSON.parse(fresh.searchParams.get("variables"));
  assert.equal(variables.cursor, undefined);
  assert.equal(variables.requestContext, "launch");
  assert.deepEqual(variables.seenTweetIds, []);
  assert.equal(variables.count, 40);
  assert.equal(fresh.searchParams.get("features"), '{"unchanged":true}');
  assert.equal(JSON.parse(new URL(Core.freshRequest(template, "new-cursor").url).searchParams.get("variables")).cursor, "new-cursor");
  assert.equal(JSON.parse(url.searchParams.get("variables")).cursor, "old", "original X request is immutable");
});
test("POST bodies and encoded POST variables keep their features", () => {
  for (const variables of [{ cursor: "old", count: 20 }, '{"cursor":"old","count":20}']) {
    const template = { url: "https://x.com/i/api/graphql/hash/HomeLatestTimeline", method: "POST", body: JSON.stringify({ variables, features: { a: true } }), operation: "HomeLatestTimeline" };
    const body = JSON.parse(Core.freshRequest(template).body);
    const parsed = typeof body.variables === "string" ? JSON.parse(body.variables) : body.variables;
    assert.equal(parsed.cursor, undefined);
    assert.deepEqual(body.features, { a: true });
  }
});
test("modern users, legacy users, long posts, quotes and videos are normalized", () => {
  const t = tweet(1, "short");
  t.note_tweet = { note_tweet_results: { result: { text: "长推文 &amp; 内容", entity_set: { urls: [] } } } };
  t.quoted_status_result = { result: { __typename: "TweetWithVisibilityResults", tweet: tweet(2, "引用") } };
  t.legacy.extended_entities = { media: [{ type: "video", media_url_https: "https://pbs.twimg.com/media/post.png", original_info: { width: 1920, height: 1080 }, video_info: { variants: [
    { content_type: "application/x-mpegURL", url: "https://video.twimg.com/a.m3u8" },
    { content_type: "video/mp4", url: "https://video.twimg.com/small.mp4", bitrate: 256000 },
    { content_type: "video/mp4", url: "https://video.twimg.com/medium.mp4", bitrate: 832000 }
  ] } }] };
  const parsed = Core.normalizeTweet(t);
  assert.equal(parsed.text, "长推文 & 内容");
  assert.equal(parsed.name, "林间");
  assert.equal(parsed.quote.id, "2");
  assert.equal(parsed.media[0].url, "https://video.twimg.com/medium.mp4");
  delete t.core.user_results.result.core;
  assert.equal(Core.normalizeTweet(t).handle, "forest_notes");
});
test("retweets use the original tweet ID so the same content is not read twice", () => {
  const t = tweet(10, "RT");
  t.legacy.retweeted_status_result = { result: tweet(1, "original") };
  const posts = Core.parseTimeline(timeline([t, tweet(1, "original")])).posts;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, "1");
  assert.equal(posts[0].repostedBy, "林间");
});
test("timeline parsing excludes promoted content, unavailable posts, and nested quotes", () => {
  const response = timeline([tweet(1), tweet(2), tweet(1)]);
  const entries = response.data.home.home_timeline_urt.instructions[0].entries;
  entries[1].content.itemContent.promotedMetadata = { advertiser: true };
  entries.unshift({ entryId: "unavailable", content: { itemContent: { tweet_results: { result: { __typename: "TweetUnavailable" } } } } });
  const parsed = Core.parseTimeline(response);
  assert.deepEqual(parsed.posts.map(p => p.id), ["1"]);
  assert.equal(parsed.cursor, "cursor-next");
  assert.equal(parsed.recognized, true);
  assert.equal(Core.parseTimeline({ data: { errors: [] } }).recognized, false);
});
test("conversation modules and replacement entries are supported", () => {
  const payload = { data: { home: { instructions: [
    { type: "TimelineAddEntries", entries: [{ content: { items: [{ item: { itemContent: { tweet_results: { result: tweet(5) } } } }] } }] },
    { type: "TimelineReplaceEntry", entry: { content: { itemContent: { tweet_results: { result: tweet(6) } } } } }
  ] } } };
  assert.deepEqual(Core.parseTimeline(payload).posts.map(p => p.id), ["5", "6"]);
});
test("the append-only queue preserves reading order through overlapping refreshes", () => {
  const queue = new Core.FeedQueue();
  const posts = ids => ids.map(id => Core.normalizeTweet(tweet(id)));
  queue.append(posts([3, 2, 1]));
  queue.markRead("3");
  assert.deepEqual(queue.append(posts([4, 3, 2])).map(p => p.id), ["4"]);
  assert.deepEqual(queue.append(posts([2, 1, 0])).map(p => p.id), ["0"]);
  assert.deepEqual(queue.items.map(p => p.id), ["3", "2", "1", "4", "0"]);
  assert.equal(queue.read.size, 1);
  assert.equal(new Core.FeedQueue().append(posts([3])).length, 1, "feed/account queues are independent");
});
test("media URLs and hyperlinks cannot become script execution or credential URLs", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "https://user:secret@x.com", "https://pbs.twimg.com.attacker.test/a.png", "http://pbs.twimg.com/a.png"]) assert.equal(Core.safeUrl(url, true), "");
  assert.equal(Core.safeUrl("https://pbs.twimg.com/a.png", true), "https://pbs.twimg.com/a.png");
  assert.equal(Core.safeUrl("https://example.com/article"), "https://example.com/article");
});

test("native seed keeps all original card data, instructions and precision", () => {
  const original = timeline([tweet(1), tweet(2)]);
  original.data.home.home_timeline_urt.instructions.unshift({ type: "TimelineClearCache" });
  const engine = new Core.NativeTimeline("for-you", "test");
  const result = engine.seed(original);
  const originalPosts = Core.nativeEntries(original).filter(e => !e.content.cursorType);
  const seededPosts = Core.nativeEntries(result).filter(e => !e.content.cursorType);
  assert.deepEqual(seededPosts, originalPosts);
  assert.equal(result.data.home.home_timeline_urt.instructions[0].type, "TimelineClearCache");
  const token = Core.nativeEntries(result).find(e => e.content.cursorType === "Bottom").content.value;
  assert.equal(engine.decode(token), "cursor-next");
  assert.equal(Core.nativeEntries(original).at(-1).content.value, "cursor-next", "input remains untouched");
});
test("native append retains X card payload and puts genuinely new entries below existing cards", () => {
  const engine = new Core.NativeTimeline("for-you", "test");
  const initial = engine.seed(timeline([tweet(3), tweet(2), tweet(1)]));
  const refreshed = timeline([tweet(4), tweet(3), tweet(2)]);
  refreshed.data.home.home_timeline_urt.instructions.unshift({ type: "TimelineClearCache" });
  refreshed.data.home.home_timeline_urt.instructions.push({ type: "TimelineTerminateTimeline", direction: "Bottom" });
  const result = engine.append(refreshed);
  assert.equal(result.data.home.home_timeline_urt.instructions.length, 1);
  assert.equal(result.data.home.home_timeline_urt.instructions[0].type, "TimelineAddEntries");
  const added = Core.nativeEntries(result).filter(e => !e.content.cursorType);
  assert.deepEqual(added.map(e => e.entryId), ["tweet-4"]);
  assert.deepEqual(added[0].content, Core.nativeEntries(refreshed)[0].content, "no custom renderer or altered interaction data");
  assert.ok(BigInt(added[0].sortIndex) < BigInt(Core.nativeEntries(initial).at(-1).sortIndex));
  const again = engine.append(timeline([tweet(4), tweet(1)]));
  assert.equal(Core.nativeEntries(again).filter(e => !e.content.cursorType).length, 0);
});
test("native retweets and mixed conversation modules deduplicate by canonical original ID", () => {
  const engine = new Core.NativeTimeline("following", "test");
  engine.seed(timeline([tweet(1)]));
  const retweet = tweet(10); retweet.legacy.retweeted_status_result = { result: tweet(1) };
  const payload = timeline([retweet]);
  payload.data.home.home_timeline_urt.instructions[0].entries.unshift({ entryId: "home-conversation-5", sortIndex: "1900000000000000020", content: { entryType: "TimelineTimelineModule", items: [
    { entryId: "child-1", item: { itemContent: { tweet_results: { result: tweet(1) } } } },
    { entryId: "child-5", item: { itemContent: { tweet_results: { result: tweet(5) } } } }
  ] } });
  const selected = engine.select(payload);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].content.items.length, 1);
  assert.equal(Core.tweetIdentity(selected[0].content.items[0].item), "5");
  assert.equal(engine.seen.has("5"), false, "preview does not commit a rejected/incomplete response");
});
test("native modules and bottom cursor decoding never use floating-point sort indices", () => {
  const engine = new Core.NativeTimeline("for-you", "test");
  engine.seed(timeline([tweet(1)]));
  const result = engine.append(timeline([tweet(2), tweet(3), tweet(4)]));
  const indices = Core.nativeEntries(result).map(e => BigInt(e.sortIndex));
  assert.equal(indices[0] - indices[1], 1n);
  assert.equal(indices[1] - indices[2], 1n);
  assert.equal(indices[2] - indices[3], 1n);
  assert.equal(engine.isToken(Core.nativeEntries(result).at(-1).content.value), true);
  const request = { url: "https://x.com/i/api/graphql/hash/HomeLatestTimeline", method: "POST", body: JSON.stringify({ variables: { cursor: "internal", extra: true }, features: { a: true } }) };
  const rewired = JSON.parse(Core.withCursor(request, "real-backend").body);
  assert.equal(rewired.variables.cursor, "real-backend");
  assert.equal(rewired.variables.extra, true);
  assert.deepEqual(rewired.features, { a: true });
});
