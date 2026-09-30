/* Shared pure logic. No credentials, storage, or DOM access. */
(function (root) {
  "use strict";
  const OPERATIONS = Object.freeze({ HomeTimeline: "for-you", HomeLatestTimeline: "following" });
  const CHANNEL = "x-downstream/v1";
  let nativeSequence = 0;
  const READ_TTL = 30 * 86400000, READ_LIMIT = 5000, ACCOUNT_LIMIT = 5;
  function readHistory(raw, now = Date.now()) {
    const accounts = {};
    if (!raw || typeof raw !== "object") return { accounts };
    const candidates = Object.entries(raw.accounts || {}).filter(([key, value]) => key.length <= 200 && key !== "__proto__" && key !== "constructor" && Array.isArray(value));
    const sorted = candidates.map(([key, records]) => {
      const ids = new Map();
      for (const record of records) {
        if (!record || !/^\d{1,30}$/.test(String(record.id)) || !Number.isFinite(record.at) || record.at < now - READ_TTL || record.at > now + 60000) continue;
        ids.set(String(record.id), Math.max(ids.get(String(record.id)) || 0, record.at));
      }
      return [key, [...ids].map(([id, at]) => ({ id, at })).sort((a, b) => b.at - a.at).slice(0, READ_LIMIT)];
    }).filter(([, records]) => records.length).sort((a, b) => b[1][0].at - a[1][0].at).slice(0, ACCOUNT_LIMIT);
    for (const [key, records] of sorted) accounts[key] = records;
    return { accounts };
  }
  function markRead(raw, account, ids, now = Date.now()) {
    const history = readHistory(raw, now);
    if (!account || account === "tab" || account.length > 200 || ["__proto__", "constructor"].includes(account)) return history;
    history.accounts[account] = [...(history.accounts[account] || []), ...ids.filter(id => /^\d{1,30}$/.test(String(id))).map(id => ({ id: String(id), at: now }))];
    return readHistory(history, now);
  }

  function classifyRequest(raw, method = "GET", origin = "https://x.com") {
    try {
      const url = new URL(raw, origin);
      if (url.origin !== origin || !["GET", "POST"].includes(method.toUpperCase())) return null;
      const match = url.pathname.match(/^\/i\/api\/graphql\/[^/]+\/(HomeTimeline|HomeLatestTimeline)$/);
      if (!match) return null;
      return { url: url.href, operation: match[1], source: OPERATIONS[match[1]], method: method.toUpperCase() };
    } catch { return null; }
  }

  function freshRequest(template, cursor) {
    const url = new URL(template.url);
    let body;
    if (template.method === "POST") body = JSON.parse(template.body || "{}");
    const raw = body ? body.variables : url.searchParams.get("variables");
    const variables = typeof raw === "string" ? JSON.parse(raw) : { ...(raw || {}) };
    delete variables.cursor;
    delete variables.seenTweetIds;
    variables.count = Math.min(40, Math.max(20, Number(variables.count) || 20));
    // Ask for a new launch batch instead of replaying a captured scroll cursor.
    // Filtering is local: X's ranking must not reinsert an item already queued.
    variables.requestContext = "launch";
    variables.seenTweetIds = [];
    if (cursor) variables.cursor = cursor;
    if (body) {
      body.variables = typeof raw === "string" ? JSON.stringify(variables) : variables;
      return { url: url.href, body: JSON.stringify(body) };
    }
    url.searchParams.set("variables", JSON.stringify(variables));
    return { url: url.href };
  }

  function safeUrl(value, media = false) {
    try {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
      if (media && (url.protocol !== "https:" || !["pbs.twimg.com", "video.twimg.com"].includes(url.hostname))) return "";
      return url.href;
    } catch { return ""; }
  }

  function unwrap(result) {
    for (let i = 0; i < 3 && result?.tweet; i++) result = result.tweet;
    return result;
  }

  function normalizeTweet(raw, depth = 0) {
    let tweet = unwrap(raw);
    if (!tweet?.legacy || !/^\d{1,30}$/.test(String(tweet.rest_id || tweet.legacy.id_str || ""))) return null;
    let repostedBy = "";
    const original = unwrap(tweet.legacy.retweeted_status_result?.result);
    if (original?.legacy) {
      const repostUser = tweet.core?.user_results?.result;
      repostedBy = repostUser?.core?.name || repostUser?.legacy?.name || "有人";
      tweet = original;
    }
    const user = tweet.core?.user_results?.result;
    if (!user || user.__typename === "UserUnavailable") return null;
    const legacy = tweet.legacy;
    const handle = user.core?.screen_name || user.legacy?.screen_name || "";
    if (!/^\w{1,30}$/.test(handle)) return null;
    const id = String(tweet.rest_id || legacy.id_str || "");
    if (!/^\d{1,30}$/.test(id)) return null;
    const note = tweet.note_tweet?.note_tweet_results?.result;
    const entities = note?.entity_set || legacy.entities || {};
    const media = (legacy.extended_entities?.media || legacy.entities?.media || []).slice(0, 4).map(item => {
      const image = safeUrl(item.media_url_https, true);
      if (!image) return null;
      const variants = (item.video_info?.variants || [])
        .filter(v => v.content_type === "video/mp4" && safeUrl(v.url, true))
        .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
      const variant = variants.find(v => (v.bitrate || 0) >= 832000) || variants.at(-1);
      const size = item.sizes?.large || item.original_info || {};
      return {
        type: item.type === "photo" ? "photo" : "video",
        url: variant ? safeUrl(variant.url, true) : "",
        poster: image,
        width: size.w || size.width || 16,
        height: size.h || size.height || 9,
        alt: String(item.ext_alt_text || "推文图片"),
        animated: item.type === "animated_gif"
      };
    }).filter(Boolean);
    let text = String(note?.text || legacy.full_text || "");
    // Media and quote links are rendered as media/quote cards, not dangling t.co URLs.
    for (const item of legacy.entities?.media || []) if (item.url) text = text.replace(item.url, "");
    if (legacy.quoted_status_permalink?.url) text = text.replace(legacy.quoted_status_permalink.url, "");
    text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    const links = (entities.urls || []).map(e => ({
      short: String(e.url || ""), href: safeUrl(e.expanded_url), label: String(e.display_url || e.expanded_url || "")
    })).filter(e => e.short && e.href);
    const createdAt = Date.parse(legacy.created_at || "");
    return {
      id, handle, name: String(user.core?.name || user.legacy?.name || handle),
      avatar: safeUrl(user.avatar?.image_url || user.legacy?.profile_image_url_https, true),
      verified: Boolean(user.is_blue_verified || user.legacy?.verified),
      text, links, media, repostedBy,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      url: `https://x.com/${handle}/status/${id}`,
      counts: { replies: Number(legacy.reply_count) || 0, reposts: Number(legacy.retweet_count) || 0, likes: Number(legacy.favorite_count) || 0 },
      quote: depth < 1 ? normalizeTweet(tweet.quoted_status_result?.result, depth + 1) : null
    };
  }

  function parseTimeline(payload) {
    const instructions = [];
    const visited = new Set();
    function discover(node, depth = 0) {
      if (!node || typeof node !== "object" || depth > 12 || visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node.instructions)) { instructions.push(...node.instructions); return; }
      for (const value of Object.values(node)) discover(value, depth + 1);
    }
    discover(payload?.data);
    const posts = [];
    const ids = new Set();
    let cursor = null;
    function addItem(content) {
      if (!content || content.promotedMetadata || content.promoted_metadata || content.adMetadata) return;
      const tweet = normalizeTweet(content.tweet_results?.result || content.tweetResult?.result);
      if (tweet && !ids.has(tweet.id)) { ids.add(tweet.id); posts.push(tweet); }
    }
    function entry(item) {
      if (!item || /^promoted-/.test(item.entryId || "")) return;
      const content = item.content || item.item || item;
      if (content.promotedMetadata || content.promoted_metadata) return;
      if (content.cursorType === "Bottom" && typeof content.value === "string") cursor = content.value;
      addItem(content.itemContent || content);
      for (const child of content.items || []) {
        const inner = child.item || child;
        addItem(inner.itemContent || inner);
      }
    }
    for (const instruction of instructions) {
      for (const item of instruction.entries || []) entry(item);
      if (instruction.entry) entry(instruction.entry);
      for (const item of instruction.moduleItems || []) entry(item);
    }
    return { posts, cursor, recognized: instructions.length > 0 };
  }

  class FeedQueue {
    constructor() { this.seen = new Set(); this.items = []; this.read = new Set(); }
    append(posts) {
      const added = [];
      for (const post of posts) {
        if (!post || !/^\d{1,30}$/.test(String(post.id)) || this.seen.has(post.id)) continue;
        this.seen.add(post.id);
        this.items.push(post);
        added.push(post);
      }
      return added;
    }
    markRead(id) { if (this.seen.has(id)) this.read.add(id); }
  }

  function instructionContainer(payload) {
    const visited = new Set();
    function walk(node, depth = 0) {
      if (!node || typeof node !== "object" || depth > 12 || visited.has(node)) return null;
      visited.add(node);
      if (Array.isArray(node.instructions)) return node;
      for (const value of Object.values(node)) { const result = walk(value, depth + 1); if (result) return result; }
      return null;
    }
    return walk(payload?.data);
  }
  function nativeEntries(payload) {
    const container = instructionContainer(payload);
    if (!container) return null;
    const entries = [];
    for (const instruction of container.instructions) {
      if (!instruction || typeof instruction !== "object" || (instruction.entries !== undefined && !Array.isArray(instruction.entries)) || (instruction.moduleItems !== undefined && !Array.isArray(instruction.moduleItems))) return null;
      if (instruction.moduleItems?.some(child => !child || typeof child !== "object")) return null;
      for (const entry of instruction.entries || (instruction.entry ? [instruction.entry] : [])) {
        if (!entry || typeof entry !== "object" || !entry.entryId || !entry.content || typeof entry.content !== "object") return null;
        if (entry.content.items !== undefined && (!Array.isArray(entry.content.items) || entry.content.items.some(child => !child || typeof child !== "object"))) return null;
        entries.push(entry);
      }
    }
    return entries;
  }
  function tweetIdentity(content) {
    const item = content?.itemContent || content;
    let result = unwrap(item?.tweet_results?.result || item?.tweetResult?.result);
    const repost = unwrap(result?.legacy?.retweeted_status_result?.result);
    if (repost) result = repost;
    const id = result?.rest_id || result?.legacy?.id_str;
    return /^\d{1,30}$/.test(String(id || "")) ? String(id) : null;
  }
  function variablesOf(template) {
    const body = template.method === "POST" ? JSON.parse(template.body || "{}") : null;
    const raw = body ? body.variables : new URL(template.url).searchParams.get("variables");
    return typeof raw === "string" ? JSON.parse(raw) : { ...(raw || {}) };
  }
  function withCursor(template, cursor) {
    const url = new URL(template.url);
    const body = template.method === "POST" ? JSON.parse(template.body || "{}") : null;
    const raw = body ? body.variables : url.searchParams.get("variables");
    const variables = variablesOf(template);
    if (cursor) variables.cursor = cursor; else delete variables.cursor;
    if (body) { body.variables = typeof raw === "string" ? JSON.stringify(variables) : variables; return { url: url.href, body: JSON.stringify(body) }; }
    url.searchParams.set("variables", JSON.stringify(variables));
    return { url: url.href };
  }

  // The original payload stays in X's own format. No cards are rebuilt or cloned.
  class NativeTimeline {
    constructor(source, nonce = "session", readIds = []) {
      this.source = source; this.nonce = nonce; this.sequence = ++nativeSequence;
      this.seen = new Set(readIds); this.entryIds = new Set(); this.tokens = new Map();
      this.modules = new Map();
      this.floor = 9000000000000000000n; this.backlog = null; this.bottom = null;
    }
    isToken(value) { return typeof value === "string" && value.startsWith(`downstream:${this.nonce}:${this.source}:`); }
    decode(value) { return this.tokens.has(value) ? this.tokens.get(value) : this.isToken(value) ? this.backlog : value; }
    record(entry) {
      const content = entry.content;
      const id = tweetIdentity(content);
      if (id) this.seen.add(id);
      for (const child of content?.items || []) { const childId = tweetIdentity(child.item || child); if (childId) this.seen.add(childId); }
      if (entry.entryId) this.entryIds.add(entry.entryId);
      if (/^\d+$/.test(entry.sortIndex || "")) this.floor = this.floor < BigInt(entry.sortIndex) ? this.floor : BigInt(entry.sortIndex);
    }
    select(payload, commit = false) {
      const entries = nativeEntries(payload);
      if (!entries) return null;
      for (const instruction of instructionContainer(payload).instructions) {
        if (!instruction.moduleItems) continue;
        const original = this.modules.get(instruction.moduleEntryId);
        if (!original) return null;
        const module = structuredClone(original);
        module.content.items = structuredClone(instruction.moduleItems);
        entries.push(module);
      }
      const seen = new Set(this.seen), keys = new Set(this.entryIds), result = [];
      for (const raw of entries) {
        if (raw.content?.cursorType) continue;
        const entry = structuredClone(raw);
        const id = tweetIdentity(entry.content);
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        } else if (Array.isArray(entry.content?.items)) {
          let containsTweets = false;
          entry.content.items = entry.content.items.filter(child => {
            const childId = tweetIdentity(child.item || child);
            if (!childId) return true;
            containsTweets = true;
            if (seen.has(childId)) return false;
            seen.add(childId); return true;
          });
          if (containsTweets && !entry.content.items.length) continue;
          if (keys.has(entry.entryId)) {
            if (!containsTweets) continue;
            entry.entryId = `${entry.entryId}-downstream-${this.sequence + 1}`;
          }
        } else if (keys.has(entry.entryId)) continue;
        keys.add(entry.entryId); result.push(entry);
      }
      if (commit) {
        this.seen = seen; this.entryIds = keys;
        for (const entry of entries) if (Array.isArray(entry.content?.items)) this.modules.set(entry.entryId, structuredClone(entry));
      }
      return result;
    }
    cursorEntry(payload) {
      return nativeEntries(payload)?.find(entry => entry.content?.cursorType === "Bottom") || null;
    }
    wrapBottom(payload, entries) {
      const cursor = this.cursorEntry(payload);
      const native = cursor || this.bottom || { entryId: "cursor-bottom", content: { entryType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", cursorType: "Bottom" } };
      this.bottom = structuredClone(native);
      this.sequence = ++nativeSequence;
      const token = `downstream:${this.nonce}:${this.source}:${this.sequence}`;
      this.tokens.set(token, this.backlog);
      if (this.tokens.size > 256) this.tokens.delete(this.tokens.keys().next().value);
      const bottom = structuredClone(native);
      bottom.entryId = `cursor-bottom-downstream-${this.sequence}`;
      bottom.sortIndex = String(--this.floor);
      bottom.content.value = token;
      entries.push(bottom);
      return entries;
    }
    seed(payload) {
      const copy = structuredClone(payload), container = instructionContainer(copy);
      if (!container) return null;
      const entries = nativeEntries(copy);
      if (!entries) return null;
      // Without a parent module in the same native store, an initial delta
      // cannot be reconstructed safely. Let X handle that payload unchanged.
      if (container.instructions.some(instruction => instruction.moduleItems)) return null;
      for (const entry of entries) if (Array.isArray(entry.content?.items)) this.modules.set(entry.entryId, structuredClone(entry));
      const selected = this.select(copy);
      const selectedById = new Map(selected.map(entry => [entry.entryId, entry]));
      this.backlog = this.cursorEntry(copy)?.content.value || null;
      for (const entry of selected) this.record(entry);
      // Initial cards, modules, ads and native clear instructions are unchanged.
      // Only the bottom continuation is replaced with a locally decoded token.
      for (const instruction of container.instructions) {
        if (instruction.entries) instruction.entries = instruction.entries.filter(e => e.content?.cursorType === "Top" || selectedById.has(e.entryId)).map(e => selectedById.get(e.entryId) || e);
        if (instruction.entry && (instruction.entry.content?.cursorType === "Bottom" || !selectedById.has(instruction.entry.entryId))) instruction.entry = null;
      }
      container.instructions = container.instructions.filter(i => i.entry !== null && !(i.type === "TimelineTerminateTimeline" && i.direction !== "Top"));
      const continuation = this.wrapBottom(payload, []);
      container.instructions.push({ type: "TimelineAddEntries", entries: continuation });
      return copy;
    }
    append(payload) {
      const copy = structuredClone(payload), container = instructionContainer(copy);
      if (!container) return null;
      const entries = this.select(copy, true);
      if (!entries) return null;
      for (const entry of entries) entry.sortIndex = String(--this.floor);
      this.wrapBottom(payload, entries);
      // Fresh home batches often carry ClearCache/Terminate instructions. They
      // must never erase the native cards the user is currently reading.
      container.instructions = [{ type: "TimelineAddEntries", entries }];
      return copy;
    }
  }

  const api = Object.freeze({ CHANNEL, OPERATIONS, readHistory, markRead, READ_TTL, READ_LIMIT, ACCOUNT_LIMIT, classifyRequest, freshRequest, safeUrl, normalizeTweet, parseTimeline, FeedQueue,
    instructionContainer, nativeEntries, tweetIdentity, variablesOf, withCursor, NativeTimeline });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.defineProperty(root, "DownstreamCore", { value: api, configurable: true });
})(globalThis);
