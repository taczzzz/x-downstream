function tweet(id, text = `推文 ${id}`, overrides = {}) {
  return {
    __typename: "Tweet", rest_id: String(id),
    core: { user_results: { result: {
      __typename: "User", rest_id: "100", is_blue_verified: true,
      core: { name: "林间", screen_name: "forest_notes" },
      avatar: { image_url: "https://pbs.twimg.com/profile_images/test/avatar.png" },
      legacy: { name: "林间", screen_name: "forest_notes" }
    } } },
    legacy: {
      id_str: String(id), full_text: text, created_at: "Wed Sep 30 03:00:00 +0000 2026",
      reply_count: 4, retweet_count: 12, favorite_count: 86, entities: { urls: [] }
    }, ...overrides
  };
}
function timeline(tweets, cursor = "cursor-next") {
  return { data: { home: { home_timeline_urt: { instructions: [{
    type: "TimelineAddEntries",
    entries: [
      ...tweets.map((t, index) => ({ entryId: `tweet-${t.rest_id}`, sortIndex: String(1900000000000000000n - BigInt(index * 100)), content: { entryType: "TimelineTimelineItem", itemContent: { itemType: "TimelineTweet", tweet_results: { result: t } } } })),
      ...(cursor ? [{ entryId: "cursor-bottom", sortIndex: String(1900000000000000000n - BigInt(tweets.length * 100 + 1)), content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: cursor } }] : [])
    ]
  }] } } } };
}
module.exports = { tweet, timeline };
