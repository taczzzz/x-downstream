/* Native X adapter. Returns X-format timeline instructions to X's own renderer.
 * No DOM replacement, copied cards, injected UI, or mutation interception. */
(() => {
  "use strict";
  const Core = globalThis.DownstreamCore;
  if (!Core || window.__downstreamBridgeInstalled) return;
  Object.defineProperty(window, "__downstreamBridgeInstalled", { value: true });
  const nativeFetch = window.fetch.bind(window);
  const feeds = new Map(), controllers = new Set();
  const nonce = crypto.randomUUID();
  const recoveries = new Map();
  const actors = new Map();
  let history = Core.readHistory(null);
  let lastControlScan = 0;
  let enabled = false, visible = !document.hidden, nearEnd = false, activeSource = null;
  let generation = 0, currentViewer = viewerId(), settingsResolved = false;
  let resolveSettings;
  const settings = new Promise(resolve => { resolveSettings = resolve; });
  setTimeout(() => { if (!settingsResolved) { settingsResolved = true; resolveSettings(); } }, 1000);

  function viewerId() {
    const raw = document.cookie.split(";").find(item => item.trim().startsWith("twid="));
    const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href")?.match(/^\/([A-Za-z0-9_]{1,30})\/?$/)?.[1];
    return raw ? raw.trim().slice(5) : profile ? `profile:${profile.toLowerCase()}` : "tab";
  }
  function checkViewer() {
    const viewer = viewerId();
    if (viewer === currentViewer) return;
    if (currentViewer === "tab" && viewer !== "tab") {
      currentViewer = viewer;
      for (const [key, st] of [...feeds]) {
        const source = st.engine.source, actor = actors.get(source) || "";
        st.account = accountFor(source);
        for (const id of readIds(st.account)) st.engine.seen.add(id);
        feeds.delete(key); feeds.set(`${currentViewer}:${actor}:${source}`, st);
      }
      return;
    }
    currentViewer = viewer; generation++;
    for (const controller of controllers) controller.abort();
    feeds.clear(); recoveries.clear(); actors.clear();
    emit("ACCOUNT", { account: null });
  }
  function emit(type, data = {}) {
    if (type === "READY" || (type === "APPENDED" && data.count > 0)) {
      const recovery = recoveries.get(data.source);
      if (recovery) { recovery.attempts = 0; recovery.nextAt = 0; }
    }
    window.postMessage({ channel: Core.CHANNEL, direction: "event", type, ...data }, location.origin);
    if (type === "READY" && (!activeSource || activeSource === data.source)) emit("ACCOUNT", { account: readingAccount(data.source) });
  }
  function nativeControls() {
    if (!activeSource || !nearEnd || !applicable(activeSource)) return;
    if (performance.now() - lastControlScan < 750) return;
    lastControlScan = performance.now();
    const column = document.querySelector('[data-testid="primaryColumn"]');
    if (!column) return;
    const recovery = recoveries.get(activeSource) || { attempts: 0, nextAt: 0 };
    recoveries.set(activeSource, recovery);
    const sourceFeeds = [...feeds.entries()].filter(([key]) => key.endsWith(`:${activeSource}`)).map(([, st]) => st);
    if (sourceFeeds.some(st => Date.now() < (st.rateLimitUntil || 0))) return;
    const buttons = [...column.querySelectorAll('button, [role="button"]')].filter(button => {
      if (!/^(?:retry|try again|重试|重试一下)$/i.test(button.innerText.trim())) return false;
      if (button.closest('article, [data-testid="tweet"], [role="dialog"], dialog, form, aside, nav, [data-testid="sidebarColumn"], [hidden], [aria-hidden="true"], [inert]') || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
      const rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(button).visibility !== "visible") return false;
      for (let parent = button; parent; parent = parent.parentElement) if (Number(getComputedStyle(parent).opacity) === 0) return false;
      return true;
    });
    const retry = buttons.find(button => {
      if (!column.contains(button) || !/^(?:retry|try again|重试|重试一下)$/i.test(button.innerText.trim())) return false;
      const lastTweet = [...column.querySelectorAll('article[data-testid="tweet"]')].at(-1);
      if (lastTweet && !(lastTweet.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      const rect = button.getBoundingClientRect();
      if (rect.top > innerHeight + 300 || rect.bottom < 0) return false;
      for (let parent = button.parentElement, depth = 0; parent && parent !== column && depth < 4; parent = parent.parentElement, depth++) {
        if (/something went wrong|try reloading|looks like you lost your connection|出错了|出现.*错误|出了点问题|发生.*错误/i.test(parent.innerText)) return true;
      }
      return false;
    });
    if (!retry || recovery.attempts >= 5 || Date.now() < recovery.nextAt) return;
    recovery.nextAt = Date.now() + Math.min(120000, 5000 * 2 ** recovery.attempts++);
    retry.click();
  }
  function applicable(source) {
    return enabled && visible && !document.hidden && location.pathname === "/home" && (!activeSource || activeSource === source);
  }
  function feedFor(source, actor) {
    actors.set(source, actor || "");
    const key = `${currentViewer}:${actor || ""}:${source}`;
    const account = accountFor(source);
    if (!feeds.has(key)) feeds.set(key, { account, engine: new Core.NativeTimeline(source, nonce, readIds(account)), nextAt: 0, emptyRounds: 0, pendingHeads: 0, tail: Promise.resolve(), controllers: new Set() });
    if (!activeSource || activeSource === source) emit("ACCOUNT", { account: readingAccount(source) });
    return feeds.get(key);
  }
  function accountFor(source) { return currentViewer === "tab" || !actors.has(source) ? null : `${currentViewer}|${actors.get(source)}`; }
  function readingAccount(source) {
    const st = feeds.get(`${currentViewer}:${actors.get(source) || ""}:${source}`);
    return st?.seeded ? accountFor(source) : null;
  }
  function readIds(account) { return (history.accounts[account] || []).map(record => record.id); }
  function updateHistory(raw) {
    history = Core.readHistory(raw);
    for (const st of feeds.values()) for (const id of readIds(st.account)) st.engine.seen.add(id);
  }
  function delay(ms, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
      function abort() { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  function revisedResponse(response, payload) {
    const headers = new Headers(response.headers);
    for (const key of ["content-length", "content-encoding", "etag"]) headers.delete(key);
    headers.set("content-type", "application/json");
    headers.set("cache-control", "no-store");
    const revised = new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers });
    Object.defineProperties(revised, {
      url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type }
    });
    return revised;
  }
  function retryAfter(response) {
    const raw = response.headers.get("retry-after");
    const reset = Number(response.headers.get("x-rate-limit-reset")) * 1000;
    const seconds = raw?.trim() && Number(raw);
    const interval = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw || "") - Date.now();
    return Math.max(30000, Number.isFinite(interval) ? interval : reset > Date.now() ? reset - Date.now() : 60000);
  }
  function queued(previous, signal) {
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(new DOMException("Aborted", "AbortError")); };
      signal.addEventListener("abort", abort, { once: true });
      previous.then(() => { signal.removeEventListener("abort", abort); resolve(); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    });
  }
  async function requestWith(template, request, signal) {
    return nativeFetch(request.url, {
      method: template.method, headers: template.headers, body: request.body,
      credentials: template.credentials, referrer: template.referrer,
      referrerPolicy: template.referrerPolicy, mode: template.mode,
      redirect: template.redirect, cache: "no-store", signal
    });
  }
  async function process(template, info) {
    await settings;
    checkViewer();
    const st = feedFor(info.source, template.headers.get("x-act-as-user-id"));
    let variables;
    try { variables = Core.variablesOf(template); }
    catch { return requestWith(template, template, template.signal); }
    const paging = Boolean(variables.cursor);
    const realCursor = st.engine.decode(variables.cursor);
    const original = st.engine.isToken(variables.cursor) ? Core.withCursor(template, realCursor) : template;
    if (!enabled || location.pathname !== "/home") return requestWith(template, original, template.signal);
    // Settle a pending native pagination normally when a head refresh arrives;
    // aborting it would manufacture a native Retry error during the refresh.
    if (!paging) st.pendingHeads++;
    const previous = st.tail;
    let finish;
    const slot = new Promise(resolve => { finish = resolve; });
    st.tail = previous.then(() => slot);
    const stamp = generation;
    const controller = new AbortController();
    controller.paging = paging;
    controllers.add(controller); st.controllers.add(controller);
    const abort = () => controller.abort();
    template.signal?.addEventListener("abort", abort, { once: true });
    if (template.signal?.aborted) controller.abort();
    const valid = () => stamp === generation && enabled && location.pathname === "/home";
    try {
      await queued(previous, controller.signal);
      if (stamp !== generation) throw new DOMException("Aborted", "AbortError");
      if (paging) st.pagingController = controller;
      if (!paging) {
        if (Date.now() < (st.rateLimitUntil || 0) && st.lastPayload) return revisedResponse(st.lastResponse, st.engine.append(st.lastPayload));
        const response = await requestWith(template, original, controller.signal);
        if (response.status === 429) st.rateLimitUntil = st.nextAt = Date.now() + retryAfter(response);
        if (!response.ok || !valid()) return response;
        let payload;
        try { payload = await response.clone().json(); } catch { return response; }
        // X may refresh the head in the background while the reader is down the
        // page. Preserve the current native store instead of re-seeding it.
        if (st.seeded && scrollY > 160 && document.querySelector('[data-testid="primaryColumn"] article[data-testid="tweet"]')) {
          const count = st.engine.select(payload)?.length || 0;
          const appended = st.engine.append(payload);
          if (appended) {
            st.lastResponse = response; st.lastPayload = payload;
            if (count) { st.emptyRounds = 0; st.nextAt = Date.now() + 15000; }
            emit("APPENDED", { source: info.source, count });
          }
          return appended ? revisedResponse(response, appended) : response;
        }
        const engine = new Core.NativeTimeline(info.source, nonce, readIds(st.account));
        const seeded = engine.seed(payload);
        if (!seeded) return response;
        st.lastResponse = response; st.lastPayload = payload;
        st.engine = engine; st.seeded = true; st.nextAt = 0; st.emptyRounds = 0;
        emit("READY", { source: info.source });
        return revisedResponse(response, seeded);
      }
      // Keep the native pagination promise pending when no unseen item exists.
      // X owns the spinner, renderer and interaction handlers throughout.
      while (valid()) {
        if (st.pendingHeads > 0 && st.lastPayload) {
          return revisedResponse(st.lastResponse, st.engine.append(st.lastPayload));
        }
        if (!applicable(info.source) || !nearEnd || Date.now() < st.nextAt) {
          await delay(Math.min(500, Math.max(50, st.nextAt - Date.now())), controller.signal);
          continue;
        }
        const head = Core.freshRequest(template);
        let fromBacklog = false, usedBacklog = null;
        let response = await requestWith(template, head, controller.signal);
        if (!valid()) return response;
        if (response.status === 429) {
          st.rateLimitUntil = st.nextAt = Date.now() + retryAfter(response); emit("COOLDOWN", { source: info.source }); continue;
        }
        if (!response.ok) {
          if ([401, 403].includes(response.status) && st.engine.backlog) {
            usedBacklog = st.engine.backlog;
            response = await requestWith(template, Core.withCursor(template, usedBacklog), controller.signal);
            fromBacklog = true;
          }
          if (response.status === 429) {
            st.rateLimitUntil = st.nextAt = Date.now() + retryAfter(response);
            emit("COOLDOWN", { source: info.source }); continue;
          }
          if (!response.ok) { emit("UNAVAILABLE", { source: info.source }); return response; }
        }
        let payload;
        try { payload = await response.clone().json(); } catch { return response; }
        let selected = st.engine.select(payload);
        if (!selected) { emit("UNAVAILABLE", { source: info.source }); return response; }
        if (fromBacklog) {
          const next = st.engine.cursorEntry(payload)?.content.value;
          st.engine.backlog = next && next !== usedBacklog ? next : null;
        }
        if (!selected.length && st.engine.backlog && !fromBacklog) {
          const used = st.engine.backlog;
          await delay(1500, controller.signal);
          response = await requestWith(template, Core.withCursor(template, used), controller.signal);
          if (!valid()) return response;
          if (response.status === 429) { st.rateLimitUntil = st.nextAt = Date.now() + retryAfter(response); continue; }
          if (!response.ok) { emit("UNAVAILABLE", { source: info.source }); return response; }
          try { payload = await response.clone().json(); } catch { return response; }
          selected = st.engine.select(payload);
          if (!selected) { emit("UNAVAILABLE", { source: info.source }); return response; }
          const next = st.engine.cursorEntry(payload)?.content.value;
          st.engine.backlog = next && next !== used ? next : null;
        }
        if (selected.length) {
          const appended = st.engine.append(payload);
          st.lastResponse = response; st.lastPayload = payload;
          st.emptyRounds = 0; st.nextAt = Date.now() + 15000;
          emit("APPENDED", { source: info.source, count: selected.length });
          return revisedResponse(response, appended);
        }
        st.nextAt = Date.now() + Math.min(120000, 30000 * 2 ** Math.min(2, st.emptyRounds++));
      }
      return requestWith(template, original, controller.signal);
    } finally {
      controllers.delete(controller); st.controllers.delete(controller);
      if (!paging) st.pendingHeads--;
      if (st.pagingController === controller) st.pagingController = null;
      template.signal?.removeEventListener("abort", abort);
      finish();
    }
  }

  window.fetch = function (input, init) {
    const info = Core.classifyRequest(input instanceof Request ? input.url : String(input), init?.method || (input instanceof Request ? input.method : "GET"), location.origin);
    if (!info || location.pathname !== "/home") return nativeFetch(input, init);
    return (async () => {
      const request = new Request(input, init);
      const template = {
        ...info, headers: new Headers(request.headers), credentials: request.credentials,
        referrer: request.referrer, referrerPolicy: request.referrerPolicy,
        mode: request.mode, redirect: request.redirect, signal: request.signal,
        body: info.method === "POST" ? await request.clone().text() : undefined
      };
      return process(template, info);
    })();
  };

  // Adapt only async JSON/text homepage XHRs, preserving their callback API.
  const meta = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalAbort = XMLHttpRequest.prototype.abort;
  XMLHttpRequest.prototype.open = function (method, url, async = true, ...rest) {
    const old = meta.get(this);
    if (old?.synthetic && !old.ended) { old.ended = true; clearTimeout(old.timeout); old.controller.abort(); }
    meta.set(this, { info: Core.classifyRequest(url, method, location.origin), headers: new Headers(), async, synthetic: false, ended: false });
    for (const property of ["readyState", "status", "statusText", "response", "responseText", "responseURL", "getResponseHeader", "getAllResponseHeaders"]) {
      if (Object.prototype.hasOwnProperty.call(this, property)) delete this[property];
    }
    return originalOpen.call(this, method, url, async, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    meta.get(this)?.headers.append(name, value);
    return originalSetHeader.call(this, name, value);
  };
  function xhrProperty(xhr, name, value) { Object.defineProperty(xhr, name, { configurable: true, get: () => value }); }
  function event(xhr, type) { xhr.dispatchEvent(new ProgressEvent(type)); }
  XMLHttpRequest.prototype.send = function (body) {
    const m = meta.get(this);
    if (!m?.info || !m.async || location.pathname !== "/home" || !["", "text", "json"].includes(this.responseType)) return originalSend.call(this, body);
    m.synthetic = true; m.controller = new AbortController();
    const xhr = this;
    event(xhr, "loadstart");
    const timeout = this.timeout > 0 ? setTimeout(() => {
      if (m.ended) return;
      m.ended = true; m.controller.abort();
      xhrProperty(xhr, "readyState", 4); xhrProperty(xhr, "status", 0);
      xhr.dispatchEvent(new Event("readystatechange")); event(xhr, "timeout"); event(xhr, "loadend");
    }, this.timeout) : null;
    m.timeout = timeout;
    process({ ...m.info, headers: m.headers, body: body == null ? undefined : String(body),
      credentials: this.withCredentials ? "include" : "same-origin", mode: "cors", redirect: "follow", signal: m.controller.signal
    }, m.info).then(async response => {
      const text = await response.text();
      if (m.ended) return;
      m.ended = true; clearTimeout(timeout);
      xhrProperty(xhr, "status", response.status); xhrProperty(xhr, "statusText", response.statusText);
      xhrProperty(xhr, "responseURL", response.url);
      Object.defineProperty(xhr, "getResponseHeader", { configurable: true, value: name => response.headers.get(name) });
      Object.defineProperty(xhr, "getAllResponseHeaders", { configurable: true, value: () => Array.from(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("") });
      xhrProperty(xhr, "readyState", 2); xhr.dispatchEvent(new Event("readystatechange"));
      xhrProperty(xhr, "readyState", 3); xhr.dispatchEvent(new Event("readystatechange"));
      if (xhr.responseType === "json") { let parsed = null; try { parsed = JSON.parse(text); } catch {} xhrProperty(xhr, "response", parsed); }
      else { xhrProperty(xhr, "responseText", text); xhrProperty(xhr, "response", text); }
      xhrProperty(xhr, "readyState", 4); xhr.dispatchEvent(new Event("readystatechange"));
      event(xhr, "load"); event(xhr, "loadend");
    }).catch(error => {
      if (m.ended) return;
      m.ended = true; clearTimeout(timeout);
      xhrProperty(xhr, "readyState", 4); xhrProperty(xhr, "status", 0);
      xhr.dispatchEvent(new Event("readystatechange")); event(xhr, error?.name === "AbortError" ? "abort" : "error"); event(xhr, "loadend");
    });
  };
  XMLHttpRequest.prototype.abort = function () {
    const m = meta.get(this);
    if (!m?.synthetic || m.ended) return originalAbort.call(this);
    m.ended = true; clearTimeout(m.timeout); m.controller.abort();
    xhrProperty(this, "readyState", 0); xhrProperty(this, "status", 0);
    this.dispatchEvent(new Event("readystatechange")); event(this, "abort"); event(this, "loadend");
  };
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== Core.CHANNEL || message.direction !== "command") return;
    if (message.type === "SETTINGS") {
      enabled = message.enabled === true;
      updateHistory(message.history);
      if (!settingsResolved) { settingsResolved = true; resolveSettings(); }
    }
    if (message.type === "HISTORY") updateHistory(message.history);
    if (message.type === "READ" && message.account && message.account === readingAccount(activeSource) && Array.isArray(message.ids)) {
      updateHistory(Core.markRead(history, message.account, message.ids));
    }
    if (message.type === "VIEWPORT") {
      const nextSource = ["for-you", "following"].includes(message.source) ? message.source : null;
      if (!message.visible || (activeSource && nextSource && activeSource !== nextSource)) {
        for (const [key, st] of feeds) if (!message.visible || key.endsWith(`:${activeSource}`)) {
          for (const controller of st.controllers) if (controller.paging) controller.abort();
        }
      }
      visible = message.visible === true; nearEnd = message.nearEnd === true;
      activeSource = nextSource;
      checkViewer();
      emit("ACCOUNT", { account: readingAccount(activeSource) });
      nativeControls();
    }
  });
})();
