/* Fixture's original renderer and original handlers. The extension NEVER loads
 * this file on X. Browser tests compare this renderer with/without the plugin. */
(() => {
  const feed = document.querySelector("#native-feed");
  const sourceStates = new Map();
  let active = "for-you", sequence = 0, automatic = true, busy = false;
  function state(source = active) {
    if (!sourceStates.has(source)) sourceStates.set(source, { entries: new Map(), nodes: new Map(), cursor: null });
    return sourceStates.get(source);
  }
  function node(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = text; return item; }
  function unwrap(tweet) { return tweet?.tweet || tweet; }
  function navigate(path) { history.pushState({}, "", path); }
  const icons = {
    reply: '<path d="M20 11a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 1 1 17-4Z"/>',
    retweet: '<path d="m4 8 4-4 4 4M8 4v12c0 2 1 3 3 3h3m6-3-4 4-4-4m4 4V8c0-2-1-3-3-3h-3"/>',
    like: '<path d="M12 21S2 15 2 8a5 5 0 0 1 10-1 5 5 0 0 1 10 1c0 7-10 13-10 13Z"/>',
    views: '<path d="M4 20V11m5 9V4m5 16v-8m5 8V8"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
    share: '<path d="M12 15V2m-5 5 5-5 5 5M4 13v7h16v-7"/>'
  };
  function card(entry) {
    const tweet = unwrap(entry.content?.itemContent?.tweet_results?.result);
    if (!tweet) return node("div", "native-module");
    const original = unwrap(tweet.legacy?.retweeted_status_result?.result) || tweet;
    const user = original.core.user_results.result, handle = user.core?.screen_name || user.legacy.screen_name;
    const article = node("article", "native-post"); article.dataset.testid = "tweet"; article.dataset.id = original.rest_id;
    article.addEventListener("click", () => navigate(`/${handle}/status/${original.rest_id}`));
    article.append(node("span", "avatar", (user.core?.name || user.legacy.name).slice(0, 1)));
    const body = node("div", "native-body"), identity = node("div", "identity");
    const permalink = node("a", "time"); permalink.href = `/${handle}/status/${original.rest_id}`; permalink.style.cssText = "color:inherit;text-decoration:none";
    permalink.append(node("time", "", "· 9月30日"));
    identity.append(node("span", "name", user.core?.name || user.legacy.name), node("span", "check", "✓"), node("span", "handle", `@${handle}`), permalink);
    const text = node("div", "text", original.note_tweet?.note_tweet_results?.result?.text || original.legacy.full_text);
    body.append(identity, text);
    const quote = unwrap(original.quoted_status_result?.result);
    if (quote) {
      const quoted = node("div", "native-quote", quote.legacy.full_text);
      quoted.addEventListener("click", event => { event.stopPropagation(); navigate(`/forest_notes/status/${quote.rest_id}`); }); body.append(quoted);
    }
    for (const media of original.legacy.extended_entities?.media || []) {
      const box = node("div", "native-media");
      const visual = node(media.type === "photo" ? "img" : "video");
      if (media.type === "photo") visual.src = media.media_url_https;
      else { visual.src = media.video_info?.variants?.find(v => v.content_type === "video/mp4")?.url || ""; visual.poster = media.media_url_https; visual.controls = true; visual.preload = "none"; }
      visual.addEventListener("click", event => event.stopPropagation()); box.append(visual); body.append(box);
    }
    const actions = node("div", "actions");
    for (const [kind, icon] of Object.entries(icons)) {
      const action = node("button"); action.type = "button"; action.dataset.testid = kind; action.setAttribute("aria-label", kind); action.setAttribute("aria-pressed", "false");
      action.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
      if (["reply", "retweet", "like", "views"].includes(kind)) action.append(node("span", "", kind === "like" ? String(original.legacy.favorite_count) : kind === "reply" ? String(original.legacy.reply_count) : kind === "retweet" ? String(original.legacy.retweet_count) : "1,208"));
      action.addEventListener("click", async event => {
        event.stopPropagation();
        if (kind === "reply") document.querySelector("#native-reply").showModal();
        else if (kind === "like" || kind === "bookmark" || kind === "retweet") {
          action.setAttribute("aria-pressed", String(action.getAttribute("aria-pressed") !== "true"));
          await fetch(`/i/api/graphql/native-action/${kind === "like" ? "FavoriteTweet" : kind === "bookmark" ? "CreateBookmark" : "CreateRetweet"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variables: { tweet_id: original.rest_id } }) });
        }
      }); actions.append(action);
    }
    body.append(actions); article.append(body); return article;
  }
  function apply(payload, source) {
    const st = state(source);
    const instructions = payload?.data?.home?.home_timeline_urt?.instructions || [];
    for (const instruction of instructions) {
      if (instruction.type === "TimelineClearCache") { st.entries.clear(); st.nodes.clear(); }
      for (const entry of instruction.entries || (instruction.entry ? [instruction.entry] : [])) {
        if (entry.content?.cursorType === "Bottom") st.cursor = entry.content.value;
        else if (!entry.content?.cursorType) {
          st.entries.set(entry.entryId, entry);
          if (!st.nodes.has(entry.entryId)) st.nodes.set(entry.entryId, card(entry));
        }
      }
      if (instruction.type === "TimelineTerminateTimeline" && instruction.direction === "Bottom") st.cursor = null;
    }
    if (active === source) {
      const sorted = Array.from(st.entries.values()).sort((a, b) => BigInt(a.sortIndex) > BigInt(b.sortIndex) ? -1 : 1);
      // Append/move existing native nodes. Their original listeners are retained.
      const orderedNodes = sorted.map(entry => st.nodes.get(entry.entryId));
      for (const old of Array.from(feed.children)) if (!orderedNodes.includes(old)) old.remove();
      for (let index = 0; index < orderedNodes.length; index++) {
        if (feed.children[index] !== orderedNodes[index]) feed.insertBefore(orderedNodes[index], feed.children[index] || null);
      }
    }
  }
  async function load(source = active, options = {}) {
    const operation = source === "following" ? "HomeLatestTimeline" : "HomeTimeline";
    const url = new URL(`/i/api/graphql/local-demo/${operation}`, location.origin);
    const variables = { count: 20, requestContext: "launch", seenTweetIds: [] };
    if (options.cursor) variables.cursor = options.cursor;
    const method = options.method || "GET";
    const headers = { "x-client-transaction-id": `fixture-transaction-${++sequence}`, "authorization": "Bearer fixture-only", "content-type": "application/json" };
    let body;
    if (method === "POST") body = JSON.stringify({ variables, features: { nativeFixture: true } });
    else { url.searchParams.set("variables", JSON.stringify(variables)); url.searchParams.set("features", '{"nativeFixture":true}'); }
    let payload;
    if (options.xhr) payload = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open(method, url.href); xhr.responseType = options.responseType || "";
      xhr.timeout = options.timeout || 0; window.lastNativeXHR = xhr; window.nativeXHREvents = [];
      for (const type of ["readystatechange", "loadstart", "load", "loadend", "abort", "timeout", "error"]) xhr.addEventListener(type, () => window.nativeXHREvents.push(type));
      Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
      xhr.onload = () => { try { resolve(xhr.responseType === "json" ? xhr.response : JSON.parse(xhr.responseText)); } catch (error) { reject(error); } };
      xhr.onerror = () => reject(Error("Network")); xhr.onabort = () => reject(Error("Aborted")); xhr.ontimeout = () => reject(Error("Timeout"));
      xhr.send(body);
    });
    else {
      const response = await fetch(url.href, { method, headers, body, signal: options.signal });
      window.lastNativeResponse = { url: response.url, type: response.type, status: response.status };
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      payload = await response.json();
    }
    window.lastNativePayload = payload;
    if (options.apply !== false) apply(payload, source);
    return payload;
  }
  function showError(options = {}) {
    document.querySelector("#native-error")?.remove();
    const error = node("div", "", "Something went wrong. Try reloading."); error.id = "native-error";
    const retry = node("button", "", "Retry");
    retry.addEventListener("click", async () => {
      window.nativeRetryClicks = (window.nativeRetryClicks || 0) + 1;
      retry.disabled = true;
      try { await load(active, { cursor: state().cursor, ...options }); error.remove(); }
      catch { retry.disabled = false; }
    });
    error.append(retry); document.querySelector("#native-loader").append(error);
  }
  function showPosted() {
    document.querySelector("#native-posted")?.remove();
    const banner = node("button", "", "posted"); banner.id = "native-posted";
    const avatar = node("img"); avatar.src = "https://pbs.twimg.com/media/fixture.png"; avatar.width = 24; avatar.height = 24; banner.prepend(avatar);
    banner.style.cssText = "position:fixed;top:80px;left:45%;z-index:10";
    banner.addEventListener("click", async () => {
      window.nativePostedClicks = (window.nativePostedClicks || 0) + 1;
      // Native notifier asks to jump to the head before loading fresh data.
      window.scrollTo({ top: 0 });
      await load(); banner.remove();
    });
    document.querySelector('[data-testid="primaryColumn"]').append(banner);
  }
  async function maybeLoad() {
    if (!automatic || busy || location.pathname !== "/home" || !state().cursor) return;
    if (document.querySelector("#native-loader").getBoundingClientRect().top > innerHeight + 600) return;
    busy = true; document.querySelector(".spinner").hidden = false;
    try { await load(active, { cursor: state().cursor }); } catch { showError(); }
    finally { busy = false; document.querySelector(".spinner").hidden = true; }
  }
  window.NativeFixture = {
    load, apply, state, showError, showPosted, setAutomatic: value => { automatic = value; },
    source: () => active, navigate,
    remember: () => { window.originalNativeCard = feed.querySelector("article"); window.originalNativeLike = feed.querySelector('[data-testid="like"]'); }
  };
  document.querySelectorAll('[role="tab"]').forEach(tab => tab.addEventListener("click", async () => {
    active = tab.dataset.source;
    for (const other of document.querySelectorAll('[role="tab"]')) other.setAttribute("aria-selected", String(other === tab));
    if (state().entries.size) apply({ data: { home: { home_timeline_urt: { instructions: [] } } } }, active);
    else await load(active);
  }));
  document.querySelector('[data-testid="AppTabBar_Home_Link"]').addEventListener("click", event => { event.preventDefault(); navigate("/home"); window.scrollTo(0, 0); load(); });
  document.querySelector("#native-explore").addEventListener("click", event => { event.preventDefault(); navigate("/explore"); });
  window.addEventListener("scroll", maybeLoad, { passive: true });
  setTimeout(() => load(), 100);
  setInterval(maybeLoad, 1000);
})();
