/* No injected elements, CSS, cards, controls, or page layout changes. */
(() => {
  "use strict";
  const CHANNEL = "x-downstream/v1";
  const Core = globalThis.DownstreamCore;
  let enabled = true, frame = 0;
  let history = Core.readHistory(null), account = null, visibleSince = new WeakMap();
  let viewerCookie = document.cookie.split(";").find(item => item.trim().startsWith("twid="));
  const recorded = new Map();
  function send(type, values) {
    window.postMessage({ channel: CHANNEL, direction: "command", type, ...values }, location.origin);
  }
  function viewport() {
    frame = 0;
    const column = document.querySelector('[data-testid="primaryColumn"]');
    const tabs = column?.querySelectorAll('[role="tab"]');
    const selected = tabs ? Array.from(tabs).findIndex(tab => tab.getAttribute("aria-selected") === "true") : -1;
    send("VIEWPORT", {
      visible: enabled && !document.hidden && location.pathname === "/home",
      nearEnd: Boolean(column && column.getBoundingClientRect().bottom < innerHeight + 1200),
      source: selected === 0 ? "for-you" : selected === 1 ? "following" : null
    });
    const viewer = document.cookie.split(";").find(item => item.trim().startsWith("twid="));
    if (viewer !== viewerCookie) { viewerCookie = viewer; account = null; visibleSince = new WeakMap(); }
    rememberVisible(column);
  }
  function rememberVisible(column) {
    if (!enabled || document.hidden || location.pathname !== "/home" || !account || !column) { visibleSince = new WeakMap(); return; }
    const ids = [];
    for (const article of column.querySelectorAll('article[data-testid="tweet"]')) {
      const rect = article.getBoundingClientRect();
      const pixels = Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top);
      if (rect.right <= 0 || rect.left >= innerWidth || pixels < Math.min(200, rect.height / 2)) { visibleSince.delete(article); continue; }
      if (!visibleSince.has(article)) { visibleSince.set(article, performance.now()); continue; }
      if (performance.now() - visibleSince.get(article) < 800) continue;
      const link = article.querySelector('a[href*="/status/"] time')?.closest("a");
      const id = link?.getAttribute("href")?.match(/\/status\/(\d{1,30})(?:[/?#]|$)/)?.[1];
      if (!id) continue;
      const previous = recorded.get(`${account}:${id}`) || 0;
      if (Date.now() - previous < 60000) continue;
      recorded.set(`${account}:${id}`, Date.now()); ids.push(id);
    }
    if (!ids.length) return;
    history = Core.markRead(history, account, ids);
    send("READ", { account, ids });
    const savedAccount = account;
    chrome.runtime.sendMessage({ type: "SAVE_READ", account: savedAccount, ids }).then(result => {
      if (!result?.saved) for (const id of ids) recorded.delete(`${savedAccount}:${id}`);
    }).catch(() => { for (const id of ids) recorded.delete(`${savedAccount}:${id}`); });
    if (recorded.size > 6000) for (const key of [...recorded.keys()].slice(0, recorded.size - 5000)) recorded.delete(key);
  }
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data.direction !== "event" || event.data.type !== "ACCOUNT") return;
    if (account !== event.data.account) { account = event.data.account || null; visibleSince = new WeakMap(); }
  });
  function schedule() { if (!frame) frame = requestAnimationFrame(viewport); }
  chrome.storage.local.get({ enabled: true, readHistory: { accounts: {} } }).then(settings => {
    enabled = settings.enabled !== false;
    history = Core.readHistory(settings.readHistory);
    send("SETTINGS", { enabled, history }); schedule();
  }).catch(() => { enabled = false; send("SETTINGS", { enabled }); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.readHistory) { history = Core.readHistory(changes.readHistory.newValue); send("HISTORY", { history }); }
    if (!changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    send("SETTINGS", { enabled, history }); schedule();
    if (location.pathname === "/home" && changes.enabled.oldValue !== changes.enabled.newValue) location.reload();
  });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("click", schedule, { passive: true });
  document.addEventListener("visibilitychange", schedule);
  document.addEventListener("DOMContentLoaded", schedule, { once: true });
  setInterval(viewport, 1000);
})();
