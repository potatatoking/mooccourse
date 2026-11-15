const { endpoint, apiOrigin, apiCredentials } = CourseAssistant;
const byId = id => document.getElementById(id);
const form = byId("api");
const save = byId("save");
const status = byId("status");

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const { api } = await chrome.storage.local.get("api");
  for (const field of ["url", "model", "key"]) byId(field).value = api?.[field] ?? "";
  save.disabled = false;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  status.textContent = "";
  save.disabled = true;
  try {
    const url = endpoint(byId("url").value.trim());
    const model = byId("model").value.trim();
    const key = byId("key").value;
    apiCredentials(model, key);
    if (!await chrome.permissions.request({ origins: [apiOrigin(url)] })) {
      throw new Error("未授权访问该 API 域名。");
    }
    // Restrict storage.local before saving the key. Content scripts receive playback only.
    await chrome.storage.local.set({ api: { url: url.href, model, key } });
    status.textContent = "已保存。";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    save.disabled = false;
  }
});

initialize().catch(() => { status.textContent = "无法读取 API 设置。"; });
