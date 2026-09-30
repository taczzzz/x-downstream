/* Adversarial functional tests, real MV3, disposable Chromium profile. No real
 * account, network credentials or production X UI are used. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("../scripts/runtime.cjs").dependency("playwright");
const { tweet, timeline } = require("./fixtures.cjs");
const root = path.join(__dirname, "..");
const initial = Array.from({ length: 18 }, (_, i) => tweet(1000 + i));
const results = [];
let context, page, worker, mode, calls, errors, gate, releaseGate, seedPosts = initial;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function storageCommand(messages) {
  const extensionPage = await context.newPage();
  try {
    await extensionPage.goto(`chrome-extension://${new URL(worker.url()).hostname}/popup.html`);
    return await extensionPage.evaluate(messages => Promise.all(messages.map(message => chrome.runtime.sendMessage(message))), messages);
  } finally { await extensionPage.close(); }
}
async function reset(nextMode = "fresh", options = {}) {
  releaseGate?.(); releaseGate = null;
  mode = "initial"; calls = []; errors = [];
  seedPosts = initial;
  await page.goto("about:blank");
  if (!options.keepHistory) await storageCommand([{ type: "CLEAR_READ" }]);
  await context.clearCookies();
  if (options.cookie !== false) await context.addCookies([{ name: "twid", value: options.cookie || "u%3D111111", domain: "x.com", path: "/", expires: Math.floor(Date.now() / 1000) + 60 * 86400 }]);
  await page.goto("https://x.com/home");
  await page.bringToFront();
  await page.waitForFunction(() => window.NativeFixture && document.querySelectorAll('[data-testid="tweet"]').length === 18);
  await page.evaluate(() => { NativeFixture.setAutomatic(false); window.scrollTo(0, document.documentElement.scrollHeight); });
  await page.waitForTimeout(150);
  mode = nextMode;
}
async function startPaging(name, signal = false) {
  await page.evaluate(({ name, signal }) => {
    window[name] = { outcome: "pending", controller: new AbortController() };
    NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor, ...(signal ? { signal: window[name].controller.signal } : {}) })
      .then(() => window[name].outcome = "resolved").catch(error => window[name].outcome = error.name);
  }, { name, signal });
}
async function check(name, run) {
  if (process.env.ADVERSARIAL_CASE && !name.includes(process.env.ADVERSARIAL_CASE)) return;
  try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log(`FAIL ${name}: ${error.message.split("\n")[0]}`); }
  finally { releaseGate?.(); releaseGate = null; }
}
(async () => {
  const version = JSON.parse(await fs.readFile(path.join(root, "extension/manifest.json"))).version;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "downstream-adversarial-"));
  try {
    const html = (await fs.readFile(path.join(root, "demo/index.html"), "utf8"))
      .replace(/\s*<script src="\/(?:extension\/[^"<]+|demo\/shim\.js)"><\/script>/g, "");
    context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, viewport: { width: 1440, height: 950 },
      args: [`--disable-extensions-except=${path.join(root, "extension")}`, `--load-extension=${path.join(root, "extension")}`] });
    worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const routeX = async route => {
      const request = route.request(), url = new URL(request.url());
      if (/\/i\/api\/graphql\/[^/]+\/(HomeTimeline|HomeLatestTimeline)$/.test(url.pathname)) {
        const variables = request.method() === "POST" ? request.postDataJSON().variables : JSON.parse(url.searchParams.get("variables"));
        const signature = request.headers()["x-client-transaction-id"];
        const source = url.pathname.endsWith("HomeLatestTimeline") ? "following" : "for-you";
        calls.push({ variables, source, signature, method: request.method(), headers: request.headers() });
        assert.ok(!String(variables.cursor || "").startsWith("downstream:"), "local cursor leaked to the server");
        let payload = timeline(source === "following" ? [tweet(2001), tweet(2002)] : seedPosts, "backend-next");
        const activeMode = mode;
        if (activeMode !== "initial" && !signature?.endsWith("-1")) {
          if (activeMode === "gated") { await gate; payload = timeline([tweet(3001)]); }
          else if (activeMode === "slow") { await wait(650); payload = timeline([tweet(3001)]); }
          else if (activeMode === "limit") return route.fulfill({ status: 429, headers: { "retry-after": "7200" }, json: {} }).catch(() => {});
          else if (activeMode === "malformed") payload = { data: { home: { home_timeline_urt: { instructions: [null] } } } };
          else if (activeMode === "graphql-error") payload = { errors: [{ message: "fixture unavailable" }], data: { home: null } };
          else if (activeMode === "empty") payload = timeline(initial, variables.cursor ? null : "backend-next");
          else if (activeMode === "backflow") payload = timeline(variables.cursor ? [initial[0], initial[17], tweet(6003)] : [tweet(6001), tweet(6002), initial[0]], "backend-next");
          else payload = timeline([initial[0], tweet(3001), tweet(3002)]);
          if (!variables.cursor && payload.data?.home?.home_timeline_urt?.instructions[0]) payload.data.home.home_timeline_urt.instructions.unshift({ type: "TimelineClearCache" });
        }
        return route.fulfill({ json: payload }).catch(() => {});
      }
      if (url.pathname.startsWith("/i/api/graphql/native-action/")) return route.fulfill({ json: { data: { ok: true } } });
      if (url.pathname.startsWith("/demo/")) return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "application/javascript", body: await fs.readFile(path.join(root, url.pathname)) });
      const pageHtml = mode === "profile" ? html.replace('</nav>', '<a data-testid="AppTabBar_Profile_Link" href="/fixture_owner">个人资料</a></nav>') : html;
      return route.fulfill({ contentType: "text/html", body: pageHtml });
    };
    await context.route("https://x.com/**", routeX);
    await context.route("https://pbs.twimg.com/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' }));
    page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors?.push(error.message));

    await check("abort a queued request immediately without cancelling its predecessor", async () => {
      await reset("empty"); await startPaging("first", true); await page.waitForTimeout(180);
      await startPaging("second", true); await page.evaluate(() => second.controller.abort());
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => second.outcome), "AbortError");
      assert.equal(await page.evaluate(() => first.outcome), "pending");
      await page.evaluate(() => first.controller.abort());
    });

    await check("head refresh cannot deadlock behind multiple empty pagination requests", async () => {
      await reset("empty"); await startPaging("first", true); await page.waitForTimeout(180);
      await startPaging("second", true); await page.waitForTimeout(60); mode = "fresh";
      await page.evaluate(() => { window.headOutcome = "pending"; NativeFixture.load("for-you").then(() => headOutcome = "resolved").catch(error => headOutcome = error.name); });
      await page.waitForTimeout(2300);
      assert.equal(await page.evaluate(() => headOutcome), "resolved");
      assert.equal(await page.locator('[data-id="3001"]').count(), 1);
    });

    await check("account switch fences requests that have not left the queue", async () => {
      await reset("gated"); gate = new Promise(resolve => { releaseGate = resolve; });
      await startPaging("first", true); await page.waitForTimeout(180); await startPaging("second", true);
      await page.evaluate(() => { document.cookie = "twid=u%3D222222;path=/"; });
      await page.waitForTimeout(1300);
      assert.equal(await page.evaluate(() => second.outcome), "AbortError");
      assert.equal(calls.filter(call => call.signature === "fixture-transaction-3").length, 0);
      assert.equal(await page.locator('[data-id="3001"]').count(), 0);
    });

    await check("reopening an in-flight XHR cancels its old callbacks and timeout", async () => {
      await reset("slow");
      await page.evaluate(() => {
        window.reusedXHR = new XMLHttpRequest(); window.reuseEvents = [];
        reusedXHR.onload = () => reuseEvents.push("load"); reusedXHR.ontimeout = () => reuseEvents.push("timeout");
        const url = '/i/api/graphql/local-demo/HomeTimeline?variables='+encodeURIComponent('{"count":20}');
        reusedXHR.open("GET", url); reusedXHR.timeout = 240; reusedXHR.setRequestHeader("x-client-transaction-id", "old-reuse"); reusedXHR.send();
        setTimeout(() => { reusedXHR.open("GET", url); reusedXHR.timeout = 2000; reusedXHR.setRequestHeader("x-client-transaction-id", "new-reuse"); reusedXHR.send(); }, 40);
      });
      await page.waitForTimeout(1500);
      assert.deepEqual(await page.evaluate(() => reuseEvents), ["load"]);
      assert.equal(await page.evaluate(() => reusedXHR.status), 200);
    });

    await check("native connection-loss error retries through the original bottom handler", async () => {
      await reset();
      await page.evaluate(() => {
        NativeFixture.showError();
        document.querySelector("#native-error").firstChild.textContent = "Looks like you lost your connection. Please check it and try again.";
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      const before = await page.evaluate(() => scrollY);
      await page.waitForFunction(() => window.nativeRetryClicks === 1);
      await page.waitForFunction(() => !document.querySelector("#native-error"));
      assert.equal(await page.evaluate(() => scrollY), before);
      assert.equal(await page.locator('[data-id="3001"]').count(), 1);
    });

    await check("connection-loss text in a composer or dialog never triggers Retry", async () => {
      await reset();
      await page.evaluate(() => {
        for (const kind of ["form", "dialog"]) {
          const box = document.createElement(kind === "form" ? "form" : "div");
          if (kind === "dialog") box.setAttribute("role", "dialog");
          box.textContent = "Looks like you lost your connection. Please check it and try again.";
          const button = document.createElement("button"); button.type = "button"; button.textContent = "Retry";
          button.onclick = () => window.falseConnectionRetry = true;
          box.append(button); box.style.cssText = "position:fixed;top:300px;left:400px";
          document.querySelector('[data-testid="primaryColumn"]').append(box);
        }
      });
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => window.falseConnectionRetry || false), false);
    });

    await check("invisible native-looking posted and Retry controls are never clicked", async () => {
      await reset();
      await page.evaluate(() => { NativeFixture.showPosted(); NativeFixture.showError(); document.querySelector("#native-posted").style.visibility = "hidden"; document.querySelector("#native-error").style.opacity = "0"; });
      await page.waitForTimeout(1300);
      assert.equal(await page.evaluate(() => window.nativePostedClicks || 0), 0);
      assert.equal(await page.evaluate(() => window.nativeRetryClicks || 0), 0);
    });

    await check("posted lookalike in the right sidebar does not trigger a click", async () => {
      await reset();
      await page.evaluate(() => {
        const aside = document.createElement("aside"); aside.dataset.testid = "sidebarColumn";
        aside.style.cssText = "position:fixed;right:20px;top:150px";
        const button = document.createElement("button"); button.textContent = "posted";
        const image = document.createElement("img"); image.src = "https://pbs.twimg.com/test"; button.prepend(image);
        button.onclick = () => window.sidebarClicked = true; aside.append(button); document.querySelector("main").append(aside);
      });
      await page.waitForTimeout(1300);
      assert.equal(await page.evaluate(() => window.sidebarClicked || false), false);
    });

    await check("composer retry does not accidentally submit a post", async () => {
      await reset();
      await page.evaluate(() => {
        const box = document.createElement("form"); box.textContent = "Something went wrong. Try reloading.";
        const button = document.createElement("button"); button.type = "button"; button.textContent = "Retry";
        button.onclick = () => window.composerSubmitted = true; box.append(button);
        box.style.cssText = "position:fixed;top:180px;left:400px";
        document.querySelector('[data-testid="primaryColumn"]').prepend(box);
      });
      await page.waitForTimeout(1300);
      assert.equal(await page.evaluate(() => window.composerSubmitted || false), false);
    });

    await check("tweet and dialog controls are excluded even when at the end", async () => {
      await reset();
      await page.evaluate(() => {
        const tweet = document.querySelector('[data-id="1017"]');
        const retry = document.createElement("button"); retry.textContent = "Retry"; retry.onclick = () => window.fakeClick = true;
        tweet.append("Something went wrong. Try reloading.", retry);
        const posted = document.createElement("button"); posted.textContent = "Show 4 new posts"; posted.onclick = () => window.fakeClick = true; tweet.append(posted);
        const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.style.cssText = "position:fixed;top:180px;left:400px";
        const other = posted.cloneNode(true); other.onclick = () => window.fakeClick = true; dialog.append(other); document.body.append(dialog);
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await page.waitForTimeout(1300);
      assert.equal(await page.evaluate(() => window.fakeClick || false), false);
    });

    await check("native posted notifier remains visible and waits for the user's own click", async () => {
      await reset();
      await page.evaluate(() => { NativeFixture.showPosted(); const banner = document.querySelector("#native-posted"); banner.lastChild.textContent = " "; banner.setAttribute("aria-label", "Show 3 new posts"); });
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => window.nativePostedClicks || 0), 0);
      assert.equal(await page.locator("#native-posted").count(), 1);
      await page.locator("#native-posted").click();
      await page.waitForFunction(() => !document.querySelector("#native-posted"));
      assert.equal(await page.evaluate(() => nativePostedClicks), 1);
      assert.equal(await page.locator('[data-id="3001"]').count(), 1);
    });

    await check("429 also suppresses native background head refreshes", async () => {
      await reset("limit"); await startPaging("limited", true); await page.waitForTimeout(250);
      const before = calls.length;
      await page.evaluate(() => { NativeFixture.load("for-you").catch(() => {}); });
      await page.waitForTimeout(500);
      assert.equal(calls.length, before);
      await page.evaluate(() => limited.controller.abort());
    });

    await check("a two-hour server cooldown is not truncated to one hour", async () => {
      await reset("limit"); await startPaging("limited", true); await page.waitForTimeout(250); const before = calls.length;
      await page.evaluate(() => { window.realNow = Date.now; Date.now = () => realNow() + 3601000; });
      await page.waitForTimeout(800);
      assert.equal(calls.length, before);
      await page.evaluate(() => { Date.now = realNow; limited.controller.abort(); });
    });

    await check("malformed instructions pass through without crashing the adapter or poisoning the queue", async () => {
      await reset("malformed");
      const outcome = await page.evaluate(async () => {
        try { await NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor, apply: false }); return "resolved"; }
        catch (error) { return error.name; }
      });
      assert.equal(outcome, "resolved");
      mode = "fresh";
      await page.evaluate(() => NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor }));
      assert.equal(await page.locator('[data-id="3001"]').count(), 1);
    });

    await check("HTTP 200 GraphQL errors preserve current cards and allow a later recovery", async () => {
      await reset("graphql-error");
      await page.evaluate(() => NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor }));
      assert.equal(await page.locator('[data-testid="tweet"]').count(), 18);
      mode = "fresh"; await page.evaluate(() => NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor }));
      assert.equal(await page.locator('[data-id="3001"]').count(), 1);
    });

    await check("rapid source switches keep native stores and dedup isolated", async () => {
      await reset("initial");
      await page.evaluate(async () => { for (let i = 0; i < 10; i++) { document.querySelectorAll('[role="tab"]')[i % 2].click(); await new Promise(resolve => setTimeout(resolve, 20)); } });
      await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => NativeFixture.source()), "following");
      assert.deepEqual(await page.locator('[data-testid="tweet"]').evaluateAll(nodes => nodes.map(node => node.dataset.id)), ["2001", "2002"]);
      await page.locator('[role="tab"]').nth(0).click();
      assert.equal(await page.locator('[data-testid="tweet"]').count(), 18);
      assert.equal(await page.locator('[data-id="2001"]').count(), 0);
    });

    await check("a hung native posted request leaves all manual scrolling native", async () => {
      await reset("gated"); gate = new Promise(resolve => { releaseGate = resolve; });
      await page.evaluate(() => NativeFixture.showPosted());
      await page.waitForTimeout(1100); assert.equal(await page.evaluate(() => window.nativePostedClicks || 0), 0);
      await page.locator("#native-posted").click();
      await page.waitForFunction(() => window.nativePostedClicks === 1);
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => nativePostedClicks), 1);
      await page.evaluate(() => window.scrollTo(0, 1000));
      assert.equal(await page.evaluate(() => scrollY), 1000);
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(await page.evaluate(() => scrollY), 0);
    });

    async function readA() {
      await reset();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(2300);
      const stored = await worker.evaluate(async () => (await chrome.storage.local.get("readHistory")).readHistory);
      assert.ok(stored.accounts["u%3D111111|"]?.some(record => record.id === "1000"), "visible A was not saved");
      assert.ok(!stored.accounts["u%3D111111|"].some(record => record.id === "1017"), "offscreen loaded A incorrectly marked read");
    }
    await check("A -> page refresh -> B -> backend sends A again: read A stays filtered, unread A survives", async () => {
      await readA();
      seedPosts = [tweet(6001), tweet(6002), initial[0]]; mode = "backflow";
      await page.reload(); await page.waitForFunction(() => document.querySelector('[data-id="6001"]'));
      await page.evaluate(() => { NativeFixture.setAutomatic(false); window.scrollTo(0, document.documentElement.scrollHeight); });
      assert.equal(await page.locator('[data-id="1000"]').count(), 0);
      await page.evaluate(() => NativeFixture.load("for-you", { cursor: NativeFixture.state().cursor }));
      assert.equal(await page.locator('[data-id="1000"]').count(), 0);
      assert.equal(await page.locator('[data-id="1017"]').count(), 1);
      assert.equal(await page.locator('[data-id="6003"]').count(), 1);
    });

    await check("A -> native home/X navigation -> B: previously read A is not reseeded", async () => {
      await readA(); mode = "fresh";
      await page.locator('[data-testid="AppTabBar_Home_Link"]').click();
      await page.waitForFunction(() => document.querySelector('[data-id="3001"]'));
      assert.equal(await page.locator('[data-id="1000"]').count(), 0);
      assert.equal(await page.evaluate(() => scrollY), 0);
    });

    await check("A -> user's native posted click -> B: native behavior retained and read A filtered", async () => {
      await readA(); mode = "fresh";
      await page.evaluate(() => NativeFixture.showPosted()); await page.waitForTimeout(1200);
      assert.equal(await page.evaluate(() => window.nativePostedClicks || 0), 0);
      await page.locator("#native-posted").click();
      await page.waitForFunction(() => !document.querySelector("#native-posted"));
      assert.equal(await page.locator('[data-id="1000"]').count(), 0);
      assert.equal(await page.locator('[data-id="3001"]').count(), 1);
      assert.equal(await page.evaluate(() => scrollY), 0);
    });

    await check("read records never cross account boundaries", async () => {
      await readA(); await reset("initial", { keepHistory: true, cookie: "u%3D333333" });
      assert.equal(await page.locator('[data-id="1000"]').count(), 1);
      assert.equal(await page.locator('[data-testid="tweet"]').count(), 18);
    });

    await check("account switch during a slow load never attributes the old screen's posts to the new account", async () => {
      await reset("gated"); gate = new Promise(resolve => { releaseGate = resolve; });
      await page.evaluate(() => {
        window.scrollTo(0, 0); document.cookie = "twid=u%3D444444;path=/";
        NativeFixture.load("for-you").catch(() => {});
      });
      await page.waitForTimeout(2300);
      const stored = await worker.evaluate(async () => (await chrome.storage.local.get("readHistory")).readHistory);
      assert.ok(!stored?.accounts["u%3D444444|"]?.some(record => record.id === "1000"), "old screen was recorded as new account's read data");
      releaseGate(); releaseGate = null;
      await page.waitForFunction(() => document.querySelector('[data-id="3001"]'));
    });

    await check("missing readable twid falls back to the native own-profile identity", async () => {
      await reset("initial", { cookie: false }); mode = "profile"; await page.reload();
      await page.waitForFunction(() => document.querySelector('[data-id="1000"]'));
      await page.evaluate(() => { NativeFixture.setAutomatic(false); window.scrollTo(0, 0); });
      await page.waitForTimeout(2300);
      const stored = await worker.evaluate(async () => (await chrome.storage.local.get("readHistory")).readHistory);
      assert.ok(stored.accounts["profile:fixture_owner|"]?.some(record => record.id === "1000"));
      await page.reload();
      await page.waitForFunction(() => NativeFixture.state().cursor);
      assert.equal(await page.locator('[data-id="1000"]').count(), 0);
    });

    await check("concurrent extension-context writes merge read IDs without losing either writer's records", async () => {
      await reset();
      await Promise.all([0, 10].map(offset => storageCommand(Array.from({ length: 10 }, (_, i) => ({ type: "SAVE_READ", account: "u%3D111111|", ids: [String(8000 + offset + i)] })))));
      const stored = await worker.evaluate(async () => (await chrome.storage.local.get("readHistory")).readHistory);
      assert.equal(stored.accounts["u%3D111111|"].filter(record => Number(record.id) >= 8000).length, 20);
    });

    await check("clearing saved read history makes old posts available after refresh", async () => {
      await readA();
      await storageCommand([{ type: "CLEAR_READ" }]);
      mode = "initial"; await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="tweet"]').length === 18);
      assert.equal(await page.locator('[data-id="1000"]').count(), 1);
    });

    await check("read A remains filtered after closing and restarting the actual test browser", async () => {
      await readA(); seedPosts = [tweet(6001), tweet(6002), initial[0]]; mode = "backflow";
      await context.close();
      context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, viewport: { width: 1440, height: 950 },
        args: [`--disable-extensions-except=${path.join(root, "extension")}`, `--load-extension=${path.join(root, "extension")}`] });
      await context.route("https://x.com/**", routeX);
      await context.route("https://pbs.twimg.com/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' }));
      worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      page = await context.newPage(); page.setDefaultTimeout(5000);
      await page.goto("https://x.com/home"); await page.waitForFunction(() => document.querySelector('[data-id="6001"]'));
      await page.evaluate(() => NativeFixture.setAutomatic(false));
      assert.ok((await context.cookies("https://x.com")).some(cookie => cookie.name === "twid" && cookie.value === "u%3D111111"), "fixture login identity must survive restart");
      assert.equal(await page.locator('[data-id="1000"]').count(), 0);
      const stored = await worker.evaluate(async () => (await chrome.storage.local.get("readHistory")).readHistory);
      assert.ok(stored.accounts["u%3D111111|"]?.some(record => record.id === "1000"));
    });

    const report = { version, fixtureOnly: true, liveXAccountTested: false, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, results };
    await fs.mkdir(path.join(root, "test-results"), { recursive: true });
    const suffix = process.env.ADVERSARIAL_CASE ? "-focused" : "";
    await fs.writeFile(path.join(root, `test-results/adversarial-report-${version}${suffix}.json`), JSON.stringify(report, null, 2) + "\n");
    console.log(`${report.passed} passed; ${report.failed} failed. Production X remains unverified.`);
    if (report.failed) process.exitCode = 1;
  } finally { releaseGate?.(); await context?.close(); await fs.rm(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
