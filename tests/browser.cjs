/* Real MV3 tests against an unchanged native-style fixture renderer. Tests do
 * not claim that a logged-in X account or X's current production UI was tested. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { dependency } = require("../scripts/runtime.cjs");
const { chromium } = dependency("playwright");
const { tweet, timeline } = require("./fixtures.cjs");
const root = path.join(__dirname, "..");
const checks = [];
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
const initial = Array.from({ length: 18 }, (_, i) => tweet(1000 + i, [
  "好的工具不需要你记住操作步骤。\n\n它应该顺着你的习惯，让下一步自然发生。",
  "把「获取内容」和「阅读内容」分开，很多界面上的来回跳转就消失了。",
  "与其追求更多功能，不如把一个每天重复的动作，做到足够顺手。"
][i % 3]));
initial[3].quoted_status_result = { result: tweet(900, "这是引用推文，原生点击行为仍然存在。") };
initial[7].legacy.extended_entities = { media: [{ type: "video", media_url_https: "https://pbs.twimg.com/media/fixture.png", video_info: { variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/fixture.mp4" }] } }] };

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "downstream-native-test-"));
  let context, baselineBrowser;
  let mode = "initial", calls = [], actions = [];
  let latest = [initial[0], tweet(3001, "新内容由页面原生渲染器接到下方。"), tweet(3002, "没有批次标题，没有插件按钮。")];
  try {
    await fs.mkdir(path.join(root, "test-results"), { recursive: true });
    const originalHtml = (await fs.readFile(path.join(root, "demo/index.html"), "utf8"))
      .replace(/\s*<script src="\/(?:extension\/[^"<]+|demo\/shim\.js)"><\/script>/g, "");
    async function routeX(route) {
      const request = route.request(), url = new URL(request.url());
      if (/\/i\/api\/graphql\/[^/]+\/(HomeTimeline|HomeLatestTimeline)$/.test(url.pathname)) {
        const variables = request.method() === "POST" ? request.postDataJSON().variables : JSON.parse(url.searchParams.get("variables"));
        const signature = request.headers()["x-client-transaction-id"];
        const source = url.pathname.endsWith("HomeLatestTimeline") ? "following" : "for-you";
        calls.push({ variables, signature, source, method: request.method() });
        assert.ok(!String(variables.cursor || "").startsWith("downstream:"), "internal cursors never reach X");
        let posts = source === "following" ? [tweet(2001, "关注时间线独立去重。"), tweet(2002, "原生关注内容。"), ...initial.slice(3)] : initial;
        const isInitial = mode === "initial" || signature?.endsWith("-1");
        if (!isInitial && mode === "limit") return route.fulfill({ status: 429, headers: { "retry-after": "120" }, json: {} });
        if (!isInitial && mode === "failure") return route.fulfill({ status: 503, json: {} });
        if (!isInitial && mode === "auth" && !variables.cursor) return route.fulfill({ status: 403, json: {} });
        if (!isInitial && mode === "schema") return route.fulfill({ json: { data: { unknown_layout: true } } });
        if (!isInitial) posts = mode === "empty" ? initial : variables.cursor ? [initial[0], tweet(4001, "头部全是重复时，自动补充一条未读内容。") ] : latest;
        const payload = timeline(posts, variables.cursor ? null : "backend-next");
        if (!isInitial && !variables.cursor) {
          payload.data.home.home_timeline_urt.instructions.unshift({ type: "TimelineClearCache" });
          payload.data.home.home_timeline_urt.instructions.push({ type: "TimelineTerminateTimeline", direction: "Bottom" });
        }
        return route.fulfill({ json: payload });
      }
      if (url.pathname.startsWith("/i/api/graphql/native-action/")) {
        actions.push({ path: url.pathname, body: request.postDataJSON(), method: request.method() });
        return route.fulfill({ json: { data: { ok: true } } });
      }
      if (url.pathname.startsWith("/demo/")) {
        const file = path.join(root, url.pathname);
        return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "application/javascript", body: await fs.readFile(file) });
      }
      return route.fulfill({ contentType: "text/html", body: originalHtml });
    }
    async function wire(ctx) {
      await ctx.route("https://x.com/**", routeX);
      await ctx.route("https://pbs.twimg.com/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180"><rect width="480" height="180" fill="#eff3f4"/></svg>' }));
      await ctx.route("https://video.twimg.com/**", route => route.fulfill({ contentType: "video/mp4", body: "" }));
    }
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true, viewport: { width: 1440, height: 950 },
      args: [`--disable-extensions-except=${path.join(root, "extension")}`, `--load-extension=${path.join(root, "extension")}`]
    });
    await wire(context);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("https://x.com/home");
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="tweet"]').length === 18);
    await page.evaluate(() => { NativeFixture.setAutomatic(false); NativeFixture.remember(); });
    const screenshot = await page.screenshot({ path: path.join(root, "test-results/preview-native-desktop.png") });
    const bodyBefore = await page.locator("body").innerText();
    assert.ok(!/新一批|已接上|找新内容|继续往下|打开原帖|顺流/.test(bodyBefore));
    assert.equal(await page.locator("#x-downstream").count(), 0);
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="primaryColumn"]').style.cssText), "");
    assert.equal(await page.evaluate(() => document.documentElement.style.cssText), "");
    pass("MV3 plugin injects no cards, controls, banners, styles, scroll containers or body locks");

    baselineBrowser = await chromium.launch({ channel: "chromium", headless: true });
    const baseline = await baselineBrowser.newContext({ viewport: { width: 1440, height: 950 } }); await wire(baseline);
    const reference = await baseline.newPage(); await reference.goto("https://x.com/home");
    await reference.waitForFunction(() => document.querySelectorAll('[data-testid="tweet"]').length === 18);
    await reference.evaluate(() => NativeFixture.setAutomatic(false));
    const baselineScreenshot = await reference.screenshot({ path: path.join(root, "test-results/preview-native-baseline.png") });
    assert.equal(Buffer.compare(screenshot, baselineScreenshot), 0, "enabled UI is pixel-identical to fixture without the extension");
    pass("initial native page screenshot is pixel-identical with and without the extension");
    await baseline.close(); await baselineBrowser.close(); baselineBrowser = null;

    const before = await page.evaluate(() => {
      window.scrollTo(0, 1400);
      return { scroll: scrollY, anchor: document.querySelector('[data-id="1008"]').getBoundingClientRect().top };
    });
    mode = "fresh";
    await page.evaluate(() => NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor }));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="tweet"]').length === 20);
    const after = await page.evaluate(() => ({
      scroll: scrollY, anchor: document.querySelector('[data-id="1008"]').getBoundingClientRect().top,
      ids: Array.from(document.querySelectorAll('[data-testid="tweet"]')).map(n => n.dataset.id),
      sameCard: originalNativeCard === document.querySelector('[data-id="1000"]'),
      sameLike: originalNativeLike === document.querySelector('[data-id="1000"] [data-testid="like"]')
    }));
    assert.equal(after.scroll, before.scroll); assert.equal(after.anchor, before.anchor);
    assert.deepEqual(after.ids.slice(-2), ["3001", "3002"]); assert.equal(after.ids.filter(id => id === "1000").length, 1);
    assert.equal(after.sameCard, true); assert.equal(after.sameLike, true);
    assert.ok(calls.at(-1).signature.startsWith("fixture-transaction-"));
    pass("refresh appends unseen posts below existing nodes, preserves exact scroll/anchor and original DOM/listeners");

    await page.evaluate(() => window.scrollTo(0, 0));
    const first = page.locator('[data-id="1000"]');
    await first.locator('[data-testid="like"]').click();
    await first.locator('[data-testid="bookmark"]').click();
    await first.locator('[data-testid="retweet"]').click();
    await first.locator('[data-testid="reply"]').click();
    assert.equal(await page.locator("#native-reply").evaluate(n => n.open), true);
    await page.locator("#native-reply button").click();
    assert.equal(await first.locator('[data-testid="like"]').getAttribute("aria-pressed"), "true");
    assert.equal(actions.length, 3); assert.ok(actions.every(a => a.method === "POST" && a.body.variables.tweet_id === "1000"));
    const pagesBefore = context.pages().length;
    await first.locator(".text").click(); assert.equal(new URL(page.url()).pathname, "/forest_notes/status/1000");
    assert.equal(context.pages().length, pagesBefore);
    pass("native text click uses same-tab detail navigation; reply, like, bookmark and repost handlers remain original");
    await page.evaluate(() => { NativeFixture.navigate("/home"); });
    await page.locator('[data-id="1003"] .native-quote').click();
    assert.equal(new URL(page.url()).pathname, "/forest_notes/status/900");
    await page.evaluate(() => { NativeFixture.navigate("/home"); });
    assert.equal(await page.locator('[data-id="1007"] video').count(), 1);
    assert.equal(await page.locator('[data-id="1007"] video').evaluate(n => n.controls), true);
    pass("quote navigation and the fixture's original video controls remain untouched");

    mode = "fresh"; latest = [initial[0], tweet(3003, "后台刷新也只能追加，不会清空原生时间线。")];
    await page.evaluate(() => window.scrollTo(0, 1400));
    const backgroundTop = await page.evaluate(() => document.querySelector('[data-id="1008"]').getBoundingClientRect().top);
    await page.evaluate(() => NativeFixture.load("for-you"));
    assert.equal(await page.locator('[data-testid="tweet"]').count(), 21);
    assert.equal(await page.evaluate(() => originalNativeCard === document.querySelector('[data-id="1000"]')), true);
    assert.equal(await page.evaluate(() => document.querySelector('[data-id="1008"]').getBoundingClientRect().top), backgroundTop);
    latest = [initial[0], tweet(3001), tweet(3002)];
    pass("background head refresh preserves the native store and reading anchor below the top");

    mode = "initial";
    await page.locator('[role="tab"]').nth(1).click();
    await page.waitForFunction(() => document.querySelector('[data-id="2001"]'));
    await page.locator('[role="tab"]').nth(0).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="tweet"]').length === 21);
    pass("X's own source tabs and cached native timelines remain in control");

    const extensionPage = await context.newPage(); await extensionPage.goto("chrome://extensions");
    const id = await extensionPage.locator("extensions-item").filter({ hasText: "顺流" }).getAttribute("id"); await extensionPage.close();
    const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.locator("#enabled").uncheck();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="tweet"]').length === 18);
    assert.equal(await page.evaluate(() => NativeFixture.state().cursor), "backend-next");
    await popup.locator("#enabled").check();
    await page.waitForFunction(() => String(window.NativeFixture?.state().cursor).startsWith("downstream:"));
    await page.evaluate(() => NativeFixture.setAutomatic(false));
    pass("popup disable restores true native cursors; enable reloads into seamless mode");

    async function reset(testMode = "initial") {
      mode = "initial";
      if (new URL(page.url()).pathname === "/home") await page.reload();
      else await page.goto("https://x.com/home");
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="tweet"]').length === 18);
      await page.evaluate(() => NativeFixture.setAutomatic(false));
      mode = testMode;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(100);
    }
    await reset("fresh");
    await page.evaluate(() => NativeFixture.setAutomatic(true));
    await page.waitForFunction(() => document.querySelector('[data-id="3001"]'));
    pass("native end-of-feed pagination automatically refreshes and appends without any plugin button");

    await reset("fresh");
    const postedPosition = await page.evaluate(() => ({ scroll: scrollY, anchor: document.querySelector('[data-id="1016"]').getBoundingClientRect().top }));
    await page.evaluate(() => { NativeFixture.remember(); NativeFixture.showPosted(); });
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => window.nativePostedClicks || 0), 0);
    assert.equal(await page.locator("#native-posted").count(), 1);
    assert.deepEqual(await page.evaluate(() => ({ scroll: scrollY, anchor: document.querySelector('[data-id="1016"]').getBoundingClientRect().top })), postedPosition);
    assert.equal(await page.evaluate(() => originalNativeCard === document.querySelector('[data-id="1000"]')), true);
    pass("native posted notifier stays untouched and does not change the reader's nodes, scroll or anchor");

    await reset("empty");
    await page.evaluate(() => {
      window.pendingBeforePosted = "pending";
      NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor }).then(() => pendingBeforePosted = "resolved").catch(() => pendingBeforePosted = "aborted");
    });
    await page.waitForTimeout(2200);
    mode = "fresh";
    await page.evaluate(() => NativeFixture.showPosted());
    await page.locator("#native-posted").click();
    await page.waitForFunction(() => document.querySelector('[data-id="3001"]'));
    assert.equal(await page.evaluate(() => pendingBeforePosted), "resolved");
    assert.equal(await page.locator("#native-error").count(), 0);
    pass("user's native posted refresh settles pending pagination normally without manufacturing a Retry error");

    await reset("fresh");
    const retryPosition = await page.evaluate(() => scrollY);
    await page.evaluate(() => NativeFixture.showError());
    await page.waitForFunction(() => !document.querySelector("#native-error") && document.querySelector('[data-id="3001"]'));
    assert.equal(await page.evaluate(() => nativeRetryClicks), 1);
    assert.equal(await page.evaluate(() => scrollY), retryPosition);
    pass("native bottom Retry recovers automatically through its original handler without scrolling to top");

    await reset("failure");
    await page.evaluate(() => NativeFixture.showError());
    await page.waitForFunction(() => window.nativeRetryClicks === 1);
    await page.waitForTimeout(1200); const failedCalls = calls.length;
    await page.waitForTimeout(2200); assert.equal(calls.length, failedCalls);
    assert.equal(await page.locator("#native-error").count(), 1);
    await page.evaluate(() => { window.realNow = Date.now; window.clockOffset = 0; Date.now = () => realNow() + clockOffset; });
    for (let attempt = 2; attempt <= 5; attempt++) {
      await page.evaluate(() => { clockOffset += 130000; });
      await page.waitForFunction(n => window.nativeRetryClicks === n, attempt);
      await page.waitForFunction(() => !document.querySelector("#native-error button").disabled);
    }
    await page.evaluate(() => { clockOffset += 130000; });
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => nativeRetryClicks), 5);
    await page.evaluate(() => { Date.now = realNow; });
    pass("persistent failures retain the native error and back off rather than rapid retrying or hiding it");

    await reset("fresh");
    await page.evaluate(() => {
      window.scrollTo(0, 0); NativeFixture.showError(); NativeFixture.showPosted();
      const article = document.querySelector('[data-testid="tweet"]');
      const button = document.createElement("button"); button.textContent = "Retry";
      button.onclick = () => window.falseRetryClick = true;
      article.append("Something went wrong. Try reloading.", button);
    });
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => window.nativeRetryClicks || 0), 0);
    assert.equal(await page.evaluate(() => window.nativePostedClicks || 0), 0);
    assert.equal(await page.evaluate(() => window.falseRetryClick || false), false);
    await page.evaluate(() => { NativeFixture.navigate("/explore"); window.scrollTo(0, document.documentElement.scrollHeight); });
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => window.nativeRetryClicks || 0), 0);
    assert.equal(await page.evaluate(() => window.nativePostedClicks || 0), 0);
    pass("native recovery waits until the end, excludes tweet buttons, and pauses outside home");

    await reset("empty");
    await page.evaluate(() => {
      window.hold = new AbortController(); window.holdOutcome = "pending";
      NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor, signal: hold.signal }).then(() => holdOutcome = "resolved").catch(() => holdOutcome = "aborted");
    });
    const emptyCalls = calls.length;
    await page.waitForTimeout(2200);
    assert.equal(await page.evaluate(() => holdOutcome), "pending");
    assert.equal(await page.locator('[data-testid="tweet"]').count(), 18);
    assert.ok(calls.length - emptyCalls <= 2);
    await page.waitForTimeout(1200); const stableCalls = calls.length;
    await page.waitForTimeout(1100); assert.equal(calls.length, stableCalls);
    await page.evaluate(() => hold.abort());
    await page.waitForFunction(() => holdOutcome === "aborted");
    pass("duplicate-only batches stay pending silently, back off without a hot loop, and obey native AbortSignal");

    await reset("fresh"); latest = [initial[0]];
    await page.evaluate(() => NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor }));
    assert.equal(await page.locator('[data-id="4001"]').count(), 1);
    assert.equal(calls.at(-1).variables.cursor, "backend-next");
    pass("duplicate head refresh falls back to the real native backlog cursor once");
    latest = [initial[0], tweet(3001), tweet(3002)];

    await reset("fresh");
    await page.evaluate(() => NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor, method: "POST", xhr: true, responseType: "json" }));
    assert.equal(await page.locator('[data-id="3001"]').count(), 1);
    const xhr = await page.evaluate(() => ({ state: lastNativeXHR.readyState, status: lastNativeXHR.status, events: nativeXHREvents, type: lastNativeXHR.getResponseHeader("content-type") }));
    assert.equal(xhr.state, 4); assert.equal(xhr.status, 200); assert.ok(xhr.events.includes("load")); assert.ok(xhr.events.includes("loadend")); assert.ok(xhr.type.includes("application/json"));
    pass("POST/XHR JSON response preserves native readyState, response headers, load and loadend callbacks");

    await reset("empty");
    await page.evaluate(() => {
      window.timeoutOutcome = "pending";
      NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor, xhr: true, timeout: 300 }).catch(error => { timeoutOutcome = error.message; NativeFixture.showError(); });
    });
    await page.waitForFunction(() => timeoutOutcome === "Timeout");
    assert.equal(await page.evaluate(() => lastNativeXHR.status), 0);
    assert.ok(await page.evaluate(() => nativeXHREvents.includes("timeout")));
    mode = "fresh";
    await page.waitForFunction(() => document.querySelector('[data-id="3001"]') && !document.querySelector("#native-error"));
    assert.equal(await page.evaluate(() => nativeRetryClicks), 1);
    pass("native XHR timeout cancels polling and its resulting Retry recovers automatically when fresh data becomes available");

    await reset("limit");
    await page.evaluate(() => {
      window.limited = new AbortController();
      NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor, signal: limited.signal }).catch(() => {});
    });
    await page.waitForTimeout(700); const limitedCount = calls.length;
    await page.evaluate(() => { NativeFixture.showError(); NativeFixture.showPosted(); });
    await page.waitForTimeout(2000); assert.equal(calls.length, limitedCount);
    assert.equal(await page.evaluate(() => window.nativeRetryClicks || 0), 0);
    assert.equal(await page.evaluate(() => window.nativePostedClicks || 0), 0);
    assert.equal(await page.locator('[data-testid="tweet"]').count(), 18);
    await page.evaluate(() => limited.abort());
    pass("429 observes server cooldown without a page notice or repeated requests");

    await reset("auth");
    await page.evaluate(() => NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor }));
    assert.equal(await page.locator('[data-id="4001"]').count(), 1);
    pass("rejected head refresh falls back to native signed pagination");

    await reset("fresh");
    await page.locator("#native-explore").click();
    const nonHomeCalls = calls.length;
    await page.waitForTimeout(1200); assert.equal(calls.length, nonHomeCalls);
    const untouched = await page.evaluate(async () => {
      const response = await fetch('/i/api/graphql/local-demo/HomeTimeline?variables='+encodeURIComponent(JSON.stringify({count:20})), { headers: { "x-client-transaction-id": "non-home-2" } });
      const payload = await response.json(); return payload.data.home.home_timeline_urt.instructions.map(i => i.type);
    });
    assert.ok(untouched.includes("TimelineClearCache"));
    pass("outside /home, timeline responses and native pages pass through unchanged");

    await reset("fresh");
    await page.evaluate(() => { document.cookie = "twid=u%3D123456;path=/"; });
    await page.waitForTimeout(1100); mode = "initial";
    await page.evaluate(() => NativeFixture.load("for-you"));
    assert.equal(await page.locator('[data-testid="tweet"]').count(), 18);
    pass("account switches reset native dedup and ordering state");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(root, "test-results/preview-native-narrow.png") });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    pass("narrow screen layout remains the original renderer's responsive UI");
    assert.deepEqual(errors, []); pass("no uncaught page errors");
    const version = JSON.parse(await fs.readFile(path.join(root, "extension/manifest.json"))).version;
    await fs.writeFile(path.join(root, `test-results/browser-report-${version}.json`), JSON.stringify({ version, passed: checks.length, checks, fixtureOnly: true, liveXAccountTested: false, initialNativeScreenshotPixelIdentical: true }, null, 2) + "\n");
    console.log(`${checks.length} native browser checks passed. Live X remains unverified.`);
  } finally {
    await context?.close(); await baselineBrowser?.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
