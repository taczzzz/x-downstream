/* Serialize local read-history writes across tabs. No network or credentials. */
importScripts("core.js");
let writes = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !["SAVE_READ", "CLEAR_READ"].includes(message?.type)) return false;
  const run = async () => {
    const { readHistory: stored } = await chrome.storage.local.get("readHistory");
    const history = message.type === "CLEAR_READ" ? { accounts: {} } : DownstreamCore.markRead(stored, message.account, Array.isArray(message.ids) ? message.ids.slice(0, 100) : []);
    await chrome.storage.local.set({ readHistory: history });
    return { saved: true };
  };
  writes = writes.then(run, run);
  writes.then(respond, () => respond({ saved: false }));
  return true;
});
