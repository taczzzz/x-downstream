"use strict";
const toggle = document.querySelector("#enabled");
const status = document.querySelector("#state");
function describe(enabled) {
  status.textContent = enabled ? "已开启。已读推文跨刷新去重，保留 X 原版界面和操作。" : "已关闭，使用 X 原版时间线。";
}
chrome.storage.local.get({ enabled: true }).then(settings => {
  toggle.checked = settings.enabled !== false; describe(toggle.checked);
}).catch(() => { status.textContent = "无法读取设置，请重新打开插件菜单。"; });
toggle.addEventListener("change", async () => {
  toggle.disabled = true;
  try { await chrome.storage.local.set({ enabled: toggle.checked }); describe(toggle.checked); }
  catch { toggle.checked = !toggle.checked; status.textContent = "设置未保存，请重试。"; }
  finally { toggle.disabled = false; }
});
document.querySelector("#clear-read").addEventListener("click", async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "CLEAR_READ" });
    status.textContent = result?.saved ? "已清空已读记录，刷新 X 首页后生效。" : "未能清空，请重试。";
  } catch { status.textContent = "未能清空，请重试。"; }
  finally { button.disabled = false; }
});
